/**
 * `neo chat` — interactive REPL against a running NEO server.
 * Uses HTTP + SSE for turns and WebSocket privacy updates. Falls back to an
 * embedded server if the configured URL is unreachable and no --server was given.
 */
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { NeoClient } from '@neo/client';
import type { EventConnection } from '@neo/client';
import { loadConfig, startServer } from '@neo/server';
import { NeoError, textOf, uiBlocksToText } from '@neo/protocol';
import { bold, cyan, dim, green, magenta, red, stripModelText, yellow } from '../ansi.js';
import { resolveDataDir, readToken } from '../config-file.js';
import { renderEvent } from '../render.js';
import type { NeoServer } from '@neo/server';

export interface ChatOptions {
  server?: string;
  token?: string;
  offRecord?: boolean;
  showReasoning?: boolean;
}

export async function runChat(opts: ChatOptions): Promise<void> {
  const dataDir = resolveDataDir();

  // Resolve server URL and token
  let serverUrl = opts.server ?? `http://127.0.0.1:7777`;
  let token = opts.token ?? readToken(dataDir) ?? '';

  let embeddedServer: NeoServer | null = null;

  // If no explicit --server, check if the default server is reachable
  if (!opts.server) {
    const reachable = await isReachable(serverUrl, token);
    if (!reachable) {
      // Start embedded server
      process.stderr.write(dim('  Starting embedded server…\n'));
      const config = loadConfig({ overrides: { mode: 'local', dataDir, server: { port: 0 } } });
      embeddedServer = await startServer(config);
      serverUrl = embeddedServer.url;
      token = embeddedServer.ownerToken;
      process.stderr.write(dim(`  Embedded server started at ${serverUrl}\n`));
    }
  }

  const client = new NeoClient({ baseUrl: serverUrl, token });

  const privateState = opts.offRecord
    ? await client.timeline.startOffRecord()
    : await client.timeline.offRecord();
  const ctx: SlashContext = { offRecord: privateState.active, opts, embeddedServer };
  const recent = await client.timeline.list({ limit: 6 });

  // Set up readline interface
  const rl = readline.createInterface({ input, output, terminal: true });

  process.stdout.write(
    `\n  ${bold(cyan('NEO chat'))}  ${dim('timeline')}\n` +
    `  ${dim('Type your message. Ctrl+C cancels a running turn (press again to exit).')}\n` +
    `  ${dim('Commands: /help /off-record /memory /remember /forget /reminders /tasks /notes /exit')}\n\n`,
  );

  for (const message of recent.items) {
    const text = textOf(message.parts) || message.parts.filter((part) => part.type === 'ui').map((part) => uiBlocksToText([part.block])).join('\n');
    const safeText = message.role === 'assistant' ? stripModelText(text) : text;
    if (safeText.trim()) process.stdout.write(`${dim(`  ${new Date(message.createdAt).toLocaleString()} ${message.role}:`)} ${safeText}\n`);
  }
  if (recent.items.length) process.stdout.write('\n');

  let abortController: AbortController | null = null;
  let pendingConfirmationId: string | null = null;
  let interrupted = false;

  // Handle Ctrl+C
  rl.on('SIGINT', () => {
    if (abortController) {
      abortController.abort();
      pendingConfirmationId = null;
      void client.timeline.cancel().catch(() => undefined);
      abortController = null;
      process.stdout.write(`\n${yellow('  Turn cancelled.')}\n\n`);
      interrupted = false;
      rl.setPrompt(prompt());
      rl.prompt();
    } else {
      if (interrupted) {
        process.stdout.write('\n  Goodbye!\n');
        void cleanup(embeddedServer, client, ctx.offRecord, ctx.connection).then(() => process.exit(0));
      } else {
        interrupted = true;
        process.stdout.write('\n  Press Ctrl+C again to exit.\n');
        rl.prompt();
        setTimeout(() => { interrupted = false; }, 2000);
      }
    }
  });

  const prompt = () => `${bold(cyan('you'))}${ctx.offRecord ? magenta(' [off the record]') : ''}> `;
  rl.setPrompt(prompt());
  rl.prompt();

  rl.on('line', async (line: string) => {
    const text = line.trim();
    if (!text) {
      rl.prompt();
      return;
    }

    // Slash commands
    if (text.startsWith('/')) {
      await handleSlash(text, rl, client, ctx);
      rl.setPrompt(prompt());
      rl.prompt();
      return;
    }

    // Handle pending confirmation responses
    if (pendingConfirmationId && (text === 'y' || text === 'n' || text === 'a')) {
      const approve = text !== 'n';
      const always = text === 'a';
      try {
        await client.confirmations.respond(pendingConfirmationId, { approve, always });
      } catch {
        // ignore
      }
      pendingConfirmationId = null;
      rl.prompt();
      return;
    }

    // Send message and stream response
    const turnController = new AbortController();
    abortController = turnController;
    rl.pause();

    try {
      const stream = client.timeline.stream({
        text,
      }, turnController.signal);

      let onSameLine = false;

      for await (const event of stream) {
        const lines = renderEvent(event, { showReasoning: opts.showReasoning });

        if (event.type === 'text.delta') {
          // Accumulate and print inline; strip control sequences from model text.
          process.stdout.write(stripModelText(event.text));
          onSameLine = true;
        } else if (event.type === 'tool.confirmation') {
          // Prompt for confirmation
          if (onSameLine) { process.stdout.write('\n'); onSameLine = false; }
          pendingConfirmationId = event.confirmation.id;
          for (const l of lines) process.stdout.write(`${l.text}\n`);
          // Inline prompt for y/n/a
          rl.resume();
          const answer = await rl.question('  → ', { signal: turnController.signal });
          rl.pause();
          const approve = answer.trim() === 'y' || answer.trim() === 'a';
          const always = answer.trim() === 'a';
          try {
            await client.confirmations.respond(event.confirmation.id, { approve, always });
          } catch { /* ignore */ }
          pendingConfirmationId = null;
        } else {
          if (onSameLine && lines.length > 0 && !lines[0]?.delta) {
            process.stdout.write('\n');
            onSameLine = false;
          }
          for (const l of lines) {
            if (l.text || !l.delta) process.stdout.write(`${l.text}\n`);
          }
        }
      }
      if (onSameLine) process.stdout.write('\n');
    } catch (err: unknown) {
      if ((err as { name?: string }).name === 'AbortError') {
        // cancelled, already printed
      } else if (err instanceof NeoError && err.code === 'no_provider') {
        process.stdout.write(`\n${yellow('  Connect an AI to start chatting. Open Settings → AI or run `neo init`.')}\n`);
      } else {
        process.stdout.write(`\n${red(`  Error: ${String(err)}`)}\n`);
      }
    }

    if (abortController === turnController) abortController = null;
    pendingConfirmationId = null;
    rl.resume();
    rl.setPrompt(prompt());
    rl.prompt();
  });

  rl.on('close', () => {
    abortController?.abort();
    if (abortController) void client.timeline.cancel().catch(() => undefined);
    void cleanup(embeddedServer, client, ctx.offRecord, ctx.connection).then(() => process.exit(0));
  });

  ctx.connection = client.connect({
    onEvent: ({ event }) => {
      if (event.type !== 'timeline.off_record') return;
      ctx.privacyRevision = (ctx.privacyRevision ?? 0) + 1;
      ctx.offRecord = event.active;
      rl.setPrompt(prompt());
      if (!abortController) rl.prompt();
    },
    onStatus: (status) => {
      if (status !== 'open') return;
      const revision = ctx.privacyRevision;
      void client.timeline.offRecord().then((state) => {
        if (revision !== ctx.privacyRevision) return;
        ctx.offRecord = state.active;
        rl.setPrompt(prompt());
        if (!abortController) rl.prompt();
      }).catch(() => undefined);
    },
  });
}

async function isReachable(url: string, token: string): Promise<boolean> {
  try {
    const client = new NeoClient({ baseUrl: url, token, timeoutMs: 2000 });
    await client.health();
    return true;
  } catch {
    return false;
  }
}

async function cleanup(server: NeoServer | null, client?: NeoClient, offRecord = false, connection?: EventConnection): Promise<void> {
  connection?.close();
  if (client && offRecord) {
    try { await client.timeline.endOffRecord(); } catch { /* server may already be unreachable */ }
  }
  if (server) {
    try { await server.stop(); } catch { /* ignore */ }
  }
}

export interface SlashContext {
  offRecord: boolean;
  opts: ChatOptions;
  embeddedServer: NeoServer | null;
  connection?: EventConnection;
  privacyRevision?: number;
}

export async function handleSlash(
  text: string,
  rl: readline.Interface,
  client: NeoClient,
  ctx: SlashContext,
): Promise<void> {
  const parts = text.slice(1).split(/\s+/);
  const cmd = parts[0]?.toLowerCase() ?? '';
  const args = parts.slice(1).join(' ');

  switch (cmd) {
    case 'exit':
    case 'quit':
      process.stdout.write('  Goodbye!\n');
      await cleanup(ctx.embeddedServer, client, ctx.offRecord, ctx.connection);
      process.exit(0);
      break;

    case 'help':
      process.stdout.write(
        `\n  ${bold('Slash commands:')}\n` +
        `  /off-record [on|off]  Toggle off the record (recall allowed, no writes)\n` +
        `  /memory               Show memory stats\n` +
        `  /remember <text>      Save a memory\n` +
        `  /forget <query>       Find and forget matching memories\n` +
        `  /reminders            List upcoming reminders\n` +
        `  /tasks                List tasks\n` +
        `  /notes                List notes\n` +
        `  /exit                 Exit\n\n`,
      );
      break;

    case 'off-record': {
      try {
        const state = await client.timeline.offRecord();
        const next = args === 'on' ? true : args === 'off' ? false : !state.active;
        const revision = ctx.privacyRevision;
        let active = false;
        if (next) active = (await client.timeline.startOffRecord()).active;
        else await client.timeline.endOffRecord();
        if (revision === ctx.privacyRevision) {
          ctx.offRecord = active;
          ctx.privacyRevision = (ctx.privacyRevision ?? 0) + 1;
        }
        process.stdout.write(dim(`  Off the record ${ctx.offRecord ? 'on' : 'off'}.\n`));
      } catch (e) {
        process.stdout.write(red(`  Error: ${String(e)}\n`));
      }
      break;
    }

    case 'memory': {
      try {
        const stats = await client.memory.stats();
        process.stdout.write(
          `\n  ${bold('Memory stats:')}\n` +
          `  Total nodes: ${stats.total}\n` +
          `  By kind: ${Object.entries(stats.byKind ?? {}).map(([k, v]) => `${k}: ${v}`).join(', ') || '—'}\n\n`,
        );
      } catch (e) {
        process.stdout.write(red(`  Error: ${String(e)}\n`));
      }
      break;
    }

    case 'remember': {
      if (ctx.offRecord) {
        process.stdout.write(yellow('  End off the record before saving memories.\n'));
        break;
      }
      if (!args) {
        process.stdout.write(yellow('  Usage: /remember <text>\n'));
        break;
      }
      try {
        const node = await client.memory.create({ kind: 'fact', content: args });
        process.stdout.write(green(`  Remembered: ${node.label ?? args} (${node.id})\n`));
      } catch (e) {
        process.stdout.write(red(`  Error: ${String(e)}\n`));
      }
      break;
    }

    case 'forget': {
      if (!args) {
        process.stdout.write(yellow('  Usage: /forget <query>\n'));
        break;
      }
      try {
        const res = await client.memory.findForForget(args, 10);
        if (!res.items.length) {
          process.stdout.write(dim('  No matching memories found.\n'));
          break;
        }
        process.stdout.write(`\n  ${bold('Matching memories:')}\n`);
        for (const n of res.items) {
          process.stdout.write(`  • [${n.kind}] ${n.label} (${n.id})\n`);
        }
        const answer = await rl.question('\n  Forget all of these? [y/N] ');
        if (answer.trim().toLowerCase() === 'y') {
          const result = await client.memory.forget(res.items.map((n) => n.id));
          process.stdout.write(green(`  Deleted ${result.deleted} memor${result.deleted === 1 ? 'y' : 'ies'}.\n`));
        } else {
          process.stdout.write(dim('  Cancelled.\n'));
        }
      } catch (e) {
        process.stdout.write(red(`  Error: ${String(e)}\n`));
      }
      break;
    }

    case 'reminders': {
      try {
        const res = await client.reminders.list({ status: ['scheduled'], limit: 10 });
        if (!res.items.length) {
          process.stdout.write(dim('  No upcoming reminders.\n'));
        } else {
          process.stdout.write(`\n  ${bold('Reminders:')}\n`);
          for (const r of res.items) {
            const dt = new Date(r.dueAt).toLocaleString();
            process.stdout.write(`  • ${r.title} — ${dt}\n`);
          }
          process.stdout.write('\n');
        }
      } catch (e) {
        process.stdout.write(red(`  Error: ${String(e)}\n`));
      }
      break;
    }

    case 'tasks': {
      try {
        const res = await client.tasks.list({ done: false, limit: 10 });
        if (!res.items.length) {
          process.stdout.write(dim('  No tasks.\n'));
        } else {
          process.stdout.write(`\n  ${bold('Tasks:')}\n`);
          for (const t of res.items) {
            process.stdout.write(`  ${t.done ? '☑' : '☐'} ${t.title}\n`);
          }
          process.stdout.write('\n');
        }
      } catch (e) {
        process.stdout.write(red(`  Error: ${String(e)}\n`));
      }
      break;
    }

    case 'notes': {
      try {
        const res = await client.notes.list({ limit: 10 });
        if (!res.items.length) {
          process.stdout.write(dim('  No notes.\n'));
        } else {
          process.stdout.write(`\n  ${bold('Notes:')}\n`);
          for (const n of res.items) {
            process.stdout.write(`  • ${n.title}\n`);
          }
          process.stdout.write('\n');
        }
      } catch (e) {
        process.stdout.write(red(`  Error: ${String(e)}\n`));
      }
      break;
    }

    default:
      process.stdout.write(yellow(`  Unknown command: /${cmd}. Type /help for a list.\n`));
  }
}
