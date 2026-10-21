/**
 * `neo init` — interactive wizard to write <dataDir>/config.json.
 */
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { bold, cyan, dim, green } from '../ansi.js';
import { resolveDataDir, runInitWizard, writeInitConfig, type PromptFn } from '../config-file.js';

export interface InitOptions {
  dataDir?: string;
}

export async function runInit(opts: InitOptions): Promise<void> {
  const dataDir = resolveDataDir(opts.dataDir);

  process.stdout.write(`\n  ${bold(cyan('NEO setup wizard'))}\n`);
  process.stdout.write(`  ${dim(`Data directory: ${dataDir}`)}\n\n`);

  const rl = readline.createInterface({ input, output, terminal: true });

  // Build a prompt function that uses readline
  const prompt: PromptFn = async (question, options) => {
    if (options?.secret) {
      // For secret input: use readline but hide the input
      return readSecret(rl, question);
    }
    const answer = await rl.question(`  ${question}: `);
    return answer;
  };

  try {
    const answers = await runInitWizard(prompt);
    writeInitConfig(dataDir, answers);

    rl.close();

    process.stdout.write('\n');
    process.stdout.write(green('  ✓ Config written.\n\n'));
    process.stdout.write(`  ${bold('Next steps:')}\n`);
    process.stdout.write(`  1. Run ${cyan('neo serve')} to start the server.\n`);
    process.stdout.write(answers.providerKind === null
      ? `  2. Connect an AI in Settings → AI, or run ${cyan('neo init')} again.\n`
      : `  2. Run ${cyan('neo chat')} to start chatting.\n`);
    process.stdout.write(`  3. Open ${cyan(getWebAppHint(answers.mode))} in a browser.\n\n`);
  } catch (e) {
    rl.close();
    throw e;
  }
}

function getWebAppHint(mode: string): string {
  if (mode === 'server') return 'https://your-server/';
  return 'http://127.0.0.1:7777/';
}

/**
 * Read a secret/password without echoing it.
 * Falls back to a regular prompt if the terminal does not support it.
 */
async function readSecret(rl: readline.Interface, question: string): Promise<string> {
  // Write the question manually so we control the newline
  process.stdout.write(`  ${question}: `);
  const keypressListeners = process.stdin.rawListeners('keypress') as ((...args: unknown[]) => void)[];
  rl.pause();
  // Pausing the stream alone leaves readline's echoing keypress listener attached.
  for (const listener of keypressListeners) process.stdin.removeListener('keypress', listener);
  process.stdin.setRawMode(true);

  return new Promise<string>((resolve) => {
    let value = '';
    const handler = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 13 || byte === 10) { // Enter
          process.stdout.write('\n');
          process.stdin.removeListener('data', handler);
          process.stdin.setRawMode(false);
          rl.resume();
          for (const listener of keypressListeners) process.stdin.on('keypress', listener);
          resolve(value);
          return;
        }
        if (byte === 127 || byte === 8) { // Backspace
          if (value.length > 0) {
            value = value.slice(0, -1);
          }
        } else if (byte >= 32) { // printable
          value += String.fromCharCode(byte);
        }
      }
    };
    process.stdin.on('data', handler);
    process.stdin.resume();
  });
}
