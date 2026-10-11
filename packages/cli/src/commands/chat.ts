/**
 * `neo chat` — interactive REPL against a running NEO server.
 * Connects via HTTP + SSE streaming; falls back to an embedded server if the
 * configured URL is unreachable and no explicit --server was given.
 */
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { NeoClient } from '@neo/client';
import { loadConfig, startServer } from '@neo/server';
import { parseModelRef, uiBlocksToText } from '@neo/protocol';
import type { AgentEvent, Conversation } from '@neo/protocol';
import { bold, cyan, dim, green, magenta, red, yellow } from '../ansi.js';
import { resolveDataDir, readToken } from '../config-file.js';
import { renderEvent } from '../render.js';
import type { NeoServer } from '@neo/server';

export interface ChatOptions {
  server?: string;
  token?: string;
  conversation?: string;
  model?: string;
  incognito?: boolean;
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

  // Get or create conversation
  let conv: Conversation;
  let incognito = opts.incognito ?? false;

  if (opts.conversation) {
    try {
      const res = await client.conversations.get(opts.conversation);
      conv = res.conversation;
    } catch {
      process.stderr.write(red(`  Conversation ${opts.conversation} not found.\n`));
      await cleanup(embeddedServer);
      process.exit(1);
    }
  } else {
    conv = await client.conversations.create({
      incognito,
      model: opts.model ? (parseModelRef(opts.model) ?? undefined) : undefined,
    });
  }

  // Set up readline interface
  const rl = readline.createInterface({ input, output, terminal: true });

  process.stdout.write(
    `\n  ${bold(cyan('NEO chat'))}  ${dim(`conversation ${conv.id.slice(-8)}`)}\n` +
    `  ${dim('Type your message. Ctrl+C cancels a running turn (press again to exit).')}\n` +
    `  ${dim('Commands: /help /new /model /memory /remember /forget /reminders /tasks /notes /title /exit')}\n\n`,
  );

  let abortController: AbortController | null = null;
  let pendingConfirmationId: string | null = null;
  let interrupted = false;

  // Handle Ctrl+C
  rl.on('SIGINT', () => {
    if (abortController) {
      abortController.abort();
      abortController = null;
      process.stdout.write(`\n${yellow('  Turn cancelled.')}\n\n`);
      interrupted = false;
      rl.setPrompt(prompt());
      rl.prompt();
    } else {
      if (interrupted) {
        process.stdout.write('\n  Goodbye!\n');
        void cleanup(embeddedServer).then(() => process.exit(0));
      } else {
        interrupted = true;
        process.stdout.write('\n  Press Ctrl+C again to exit.\n');
        rl.prompt();
        setTimeout(() => { interrupted = false; }, 2000);
      }
    }
  });

  const prompt = () => `${bold(cyan('you'))}> `;
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
      await handleSlash(text, rl, client, { conv, incognito, opts, embeddedServer });
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
    abortController = new AbortController();
    rl.pause();

    try {
      const stream = client.conversations.stream(conv.id, {
        text,
        model: opts.model ? (parseModelRef(opts.model) ?? undefined) : undefined,
      }, abortController.signal);

      let currentText = '';
      let onSameLine = false;

      for await (const event of stream) {
        const lines = renderEvent(event, { showReasoning: opts.showReasoning });

        if (event.type === 'text.delta') {
          // Accumulate and print inline
          currentText += event.text;
          process.stdout.write(event.text);
          onSameLine = true;
        } else if (event.type === 'tool.confirmation') {
          // Prompt for confirmation
          if (onSameLine) { process.stdout.write('\n'); onSameLine = false; }
          pendingConfirmationId = event.confirmation.toolCallId;
          for (const l of lines) process.stdout.write(`${l.text}\n`);
          // Inline prompt for y/n/a
          rl.resume();
          const answer = await rl.question('  → ');
          rl.pause();
          const approve = answer.trim() !== 'n';
          const always = answer.trim() === 'a';
          try {
            await client.confirmations.respond(event.confirmation.toolCallId, { approve, always });
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
          currentText = '';
        }
      }
      if (onSameLine) process.stdout.write('\n');
    } catch (err: unknown) {
      if ((err as { name?: string }).name === 'AbortError') {
        // cancelled, already printed
      } else {
        process.stdout.write(`\n${red(`  Error: ${String(err)}`)}\n`);
      }
    }

    abortController = null;
    rl.resume();
    rl.setPrompt(prompt());
    rl.prompt();
  });

  rl.on('close', () => {
    void cleanup(embeddedServer).then(() => process.exit(0));
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

async function cleanup(server: NeoServer | null): Promise<void> {
  if (server) {
    try { await server.stop(); } catch { /* ignore */ }
  }
}

interface SlashContext {
  conv: Conversation;
  incognito: boolean;
  opts: ChatOptions;
  embeddedServer: NeoServer | null;
}

async function handleSlash(
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
      await cleanup(ctx.embeddedServer);
      process.exit(0);
      break;

    case 'help':
      process.stdout.write(
        `\n  ${bold('Slash commands:')}\n` +
        `  /new [--incognito]    Start a new conversation\n` +
        `  /model [name]         Show or set the model (provider/model)\n` +
        `  /memory               Show memory stats\n` +
        `  /remember <text>      Save a memory\n` +
        `  /forget <query>       Find and forget matching memories\n` +
        `  /reminders            List upcoming reminders\n` +
        `  /tasks                List tasks\n` +
        `  /notes                List notes\n` +
        `  /title <text>         Rename this conversation\n` +
        `  /exit                 Exit\n\n`,
      );
      break;

    case 'new': {
      const incognito = args.includes('--incognito');
      try {
        ctx.conv = await client.conversations.create({ incognito });
        ctx.incognito = incognito;
        process.stdout.write(dim(`  New conversation started (${ctx.conv.id.slice(-8)})${incognito ? ' [incognito]' : ''}\n`));
      } catch (e) {
        process.stdout.write(red(`  Could not create conversation: ${String(e)}\n`));
      }
      break;
    }

    case 'model': {
      if (!args) {
        // List providers and models
        try {
          const res = await client.providers.list();
          process.stdout.write(`\n  ${bold('Available providers:')}\n`);
          for (const p of res.items) {
            process.stdout.write(`  ${p.id} (${p.kind})${p.defaultModel ? ` — default: ${p.defaultModel}` : ''}\n`);
          }
          if (res.defaultModel) {
            process.stdout.write(`\n  ${dim(`Current default: ${res.defaultModel.provider}/${res.defaultModel.model}`)}\n`);
          }
          process.stdout.write('\n');
        } catch (e) {
          process.stdout.write(red(`  Error: ${String(e)}\n`));
        }
      } else {
        ctx.opts.model = args;
        process.stdout.write(dim(`  Model set to ${args}\n`));
      }
      break;
    }

    case 'memory': {
      try {
        const stats = await client.memory.stats();
        process.stdout.write(
          `\n  ${bold('Memory stats:')}\n` +
          `  Total nodes: ${stats.total}\n` +
          `  By kind: ${Object.entries(stats.byKind ?? {}).map(([k, v]) => `${k}: ${v}`).join(', ') || '—'}\n` +
          `  Pending: ${stats.pending ?? 0}\n\n`,
        );
      } catch (e) {
        process.stdout.write(red(`  Error: ${String(e)}\n`));
      }
      break;
    }

    case 'remember': {
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

    case 'title': {
      if (!args) {
        process.stdout.write(yellow('  Usage: /title <text>\n'));
        break;
      }
      try {
        await client.conversations.update(ctx.conv.id, { title: args });
        process.stdout.write(green(`  Title set to "${args}".\n`));
      } catch (e) {
        process.stdout.write(red(`  Error: ${String(e)}\n`));
      }
      break;
    }

    default:
      process.stdout.write(yellow(`  Unknown command: /${cmd}. Type /help for a list.\n`));
  }
}
