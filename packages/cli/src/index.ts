#!/usr/bin/env node
/**
 * `neo` — the NEO command-line interface.
 *
 * Usage:
 *   neo serve [options]      Start the NEO server
 *   neo chat [options]       Chat with NEO in the terminal
 *   neo init [options]       Interactive setup wizard
 *   neo pair [options]       Create a device pairing token
 *   neo token [options]      Print the owner token
 *   neo memory <sub> [opts]  Memory management
 *   neo doctor [options]     Health check
 *   neo --version            Print version
 *   neo help [command]       Show help
 */
import { NEO_VERSION } from '@neo/protocol';
import { parseCliArgs } from './args.js';
import { bold, cyan, dim, red } from './ansi.js';

async function main(): Promise<void> {
  const parsed = parseCliArgs();

  if ('error' in parsed) {
    process.stderr.write(`${red(`  neo: ${parsed.error}`)}\n`);
    process.stderr.write(dim('  Run `neo help` for usage.\n'));
    process.exit(1);
  }

  switch (parsed.cmd) {
    case 'version':
      process.stdout.write(`neo ${NEO_VERSION}\n`);
      return;

    case 'help': {
      const { topic } = parsed;
      if (topic) {
        printCommandHelp(topic);
      } else {
        printHelp();
      }
      return;
    }

    case 'serve': {
      const { runServe } = await import('./commands/serve.js');
      await runServe({
        host: parsed.host,
        port: parsed.port,
        dataDir: parsed.dataDir,
        mode: parsed.mode,
        config: parsed.config,
        webDir: parsed.webDir,
        logLevel: parsed.logLevel,
        showToken: parsed.showToken,
      });
      return;
    }

    case 'chat': {
      const { runChat } = await import('./commands/chat.js');
      await runChat({
        server: parsed.server,
        token: parsed.token,
        conversation: parsed.conversation,
        model: parsed.model,
        incognito: parsed.incognito,
        showReasoning: parsed.showReasoning,
      });
      return;
    }

    case 'init': {
      const { runInit } = await import('./commands/init.js');
      await runInit({ dataDir: parsed.dataDir });
      return;
    }

    case 'pair': {
      const { runPair } = await import('./commands/pair.js');
      await runPair({
        name: parsed.name,
        platform: parsed.platform,
        dataDir: parsed.dataDir,
        server: parsed.server,
        token: parsed.token,
      });
      return;
    }

    case 'token': {
      const { runToken } = await import('./commands/token.js');
      await runToken({ dataDir: parsed.dataDir });
      return;
    }

    case 'memory': {
      const { runMemory } = await import('./commands/memory.js');
      await runMemory({
        sub: parsed.sub,
        file: parsed.file,
        replace: parsed.replace,
        dataDir: parsed.dataDir,
        server: parsed.server,
        token: parsed.token,
      });
      return;
    }

    case 'doctor': {
      const { runDoctor } = await import('./commands/doctor.js');
      await runDoctor({
        dataDir: parsed.dataDir,
        server: parsed.server,
        token: parsed.token,
      });
      return;
    }
  }
}

function printHelp(): void {
  process.stdout.write(
    `\n  ${bold(cyan('neo'))} — your personal AI assistant\n\n` +
    `  ${bold('Commands:')}\n` +
    `    serve     Start the NEO server\n` +
    `    chat      Chat interactively in the terminal\n` +
    `    init      Interactive setup wizard\n` +
    `    pair      Create a device pairing token + QR code\n` +
    `    token     Print the owner token\n` +
    `    memory    Memory management (export/import/stats/consolidate)\n` +
    `    doctor    Health check\n\n` +
    `  ${bold('Flags:')}\n` +
    `    --version   Print version\n` +
    `    --help      Show this help\n\n` +
    `  Run ${cyan('neo <command> --help')} for command-specific options.\n\n`,
  );
}

function printCommandHelp(topic: string): void {
  const helps: Record<string, string> = {
    serve:
      `  ${bold('neo serve')} — start the NEO server\n\n` +
      `  ${bold('Options:')}\n` +
      `    --host <host>          Bind host (default: 127.0.0.1)\n` +
      `    --port <port>          Port (default: 7777)\n` +
      `    --data-dir <dir>       Data directory (default: ~/.neo)\n` +
      `    --mode local|server    Deployment mode (default: local)\n` +
      `    --config <file>        Config file path\n` +
      `    --web-dir <dir>        Path to built web app\n` +
      `    --log-level <level>    Log level: debug, info, warn, error, silent\n` +
      `    --show-token           Always print the owner token\n`,
    chat:
      `  ${bold('neo chat')} — interactive REPL\n\n` +
      `  ${bold('Options:')}\n` +
      `    --server <url>         Server URL (default: http://127.0.0.1:7777)\n` +
      `    --token <token>        Auth token\n` +
      `    --conversation <id>    Resume a conversation\n` +
      `    --model <p/m>          Model as provider/model\n` +
      `    --incognito            Incognito mode (no memory)\n` +
      `    --show-reasoning       Show model reasoning\n`,
    init:
      `  ${bold('neo init')} — interactive setup wizard\n\n` +
      `  ${bold('Options:')}\n` +
      `    --data-dir <dir>  Data directory (default: ~/.neo)\n`,
    pair:
      `  ${bold('neo pair')} — pair a new device\n\n` +
      `  ${bold('Options:')}\n` +
      `    --name <name>      Device name\n` +
      `    --platform <p>     Platform: web, desktop, ios, android, cli, other\n` +
      `    --server <url>     Server URL\n` +
      `    --token <token>    Owner token\n` +
      `    --data-dir <dir>   Data directory\n`,
    token:
      `  ${bold('neo token')} — print the owner token\n\n` +
      `  ${bold('Options:')}\n` +
      `    --data-dir <dir>  Data directory (default: ~/.neo)\n`,
    memory:
      `  ${bold('neo memory')} — memory management\n\n` +
      `  ${bold('Subcommands:')}\n` +
      `    export [file]          Export to JSON file (default: stdout)\n` +
      `    import <file> [--replace]  Import from JSON file\n` +
      `    stats                  Show memory statistics\n` +
      `    consolidate            Force a consolidation run\n\n` +
      `  ${bold('Options:')}\n` +
      `    --server <url>     Server URL\n` +
      `    --token <token>    Auth token\n` +
      `    --data-dir <dir>   Data directory\n`,
    doctor:
      `  ${bold('neo doctor')} — system health check\n\n` +
      `  ${bold('Options:')}\n` +
      `    --server <url>     Server URL (default: http://127.0.0.1:7777)\n` +
      `    --token <token>    Auth token\n` +
      `    --data-dir <dir>   Data directory\n`,
  };

  const help = helps[topic];
  if (help) {
    process.stdout.write(`\n${help}\n\n`);
  } else {
    process.stdout.write(dim(`  No help for "${topic}". Run \`neo help\` for a list of commands.\n`));
  }
}

// Unhandled error handler
process.on('unhandledRejection', (reason) => {
  process.stderr.write(red(`\n  Unhandled error: ${String(reason)}\n`));
  process.exit(1);
});

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${red(`  Error: ${msg}`)}\n`);
  process.exit(1);
});
