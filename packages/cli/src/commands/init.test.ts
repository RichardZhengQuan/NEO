import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInit } from './init.js';

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'neo-init-'));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function waitForOutput(output: PassThrough, text: string): Promise<void> {
  return new Promise((resolve) => {
    let written = '';
    const onData = (chunk: Buffer) => {
      written += chunk.toString('utf8');
      if (written.includes(text)) {
        output.removeListener('data', onData);
        resolve();
      }
    };
    output.on('data', onData);
  });
}

describe('init API key input', () => {
  it('does not echo the typed secret and continues the wizard', async () => {
    const originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin')!;
    const originalStdout = Object.getOwnPropertyDescriptor(process, 'stdout')!;
    const fakeStdin = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode(this: PassThrough, _mode: boolean) { return this; },
    });
    const fakeStdout = Object.assign(new PassThrough(), { isTTY: true, columns: 120 });
    const secret = 'sk-test-shhh';
    let captured = '';

    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });
    Object.defineProperty(process, 'stdout', { value: fakeStdout, configurable: true });
    // runInit also imports these streams from node:process for readline.
    syncBuiltinESMExports();
    const stdout = vi.spyOn(process.stdout, 'write');

    try {
      const providerPrompt = waitForOutput(fakeStdout, 'Enter number [0]');
      const run = runInit({ dataDir });
      await providerPrompt;

      const keyPrompt = waitForOutput(fakeStdout, ' API key');
      fakeStdin.write('1\n');
      await keyPrompt;

      const modelPrompt = waitForOutput(fakeStdout, 'Default model [');
      for (const character of secret) fakeStdin.write(character);
      fakeStdin.write('\n');
      await modelPrompt;

      const modePrompt = waitForOutput(fakeStdout, 'Mode —');
      fakeStdin.write('fixture-model\n');
      await modePrompt;
      fakeStdin.write('\n');
      await run;

      captured = stdout.mock.calls.map(([chunk]) => String(chunk)).join('');
      const config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'));
      expect(config.providers[0]).toMatchObject({ apiKey: secret, defaultModel: 'fixture-model' });
    } finally {
      stdout.mockRestore();
      Object.defineProperty(process, 'stdin', originalStdin);
      Object.defineProperty(process, 'stdout', originalStdout);
      syncBuiltinESMExports();
      fakeStdin.destroy();
      fakeStdout.destroy();
    }

    expect(captured).not.toContain(secret);
    expect(captured).toContain('Config written.');
  });

  it('aborts via SIGINT when the user presses Ctrl-C at the API-key prompt', async () => {
    const originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin')!;
    const originalStdout = Object.getOwnPropertyDescriptor(process, 'stdout')!;
    const fakeStdin = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode(this: PassThrough, _mode: boolean) { return this; },
    });
    const fakeStdout = Object.assign(new PassThrough(), { isTTY: true, columns: 120 });

    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });
    Object.defineProperty(process, 'stdout', { value: fakeStdout, configurable: true });
    syncBuiltinESMExports();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true as any);

    try {
      const providerPrompt = waitForOutput(fakeStdout, 'Enter number [0]');
      const run = runInit({ dataDir });
      run.catch(() => {});
      await providerPrompt;

      const keyPrompt = waitForOutput(fakeStdout, ' API key');
      fakeStdin.write('1\n');
      await keyPrompt;

      fakeStdin.write(Buffer.from([0x03]));
      await new Promise((r) => setImmediate(r));
      expect(process.kill).toHaveBeenCalledWith(process.pid, 'SIGINT');
    } finally {
      Object.defineProperty(process, 'stdin', originalStdin);
      Object.defineProperty(process, 'stdout', originalStdout);
      fakeStdin.destroy();
      fakeStdout.destroy();
      kill.mockRestore();
      syncBuiltinESMExports();
    }
  });
});
