import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { PROVIDER_PRESETS } from '@neo/protocol';
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

  it('submits the partial key and restores terminal on Ctrl-D at the API-key prompt', async () => {
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
    const rawMode = vi.spyOn(fakeStdin, 'setRawMode');

    try {
      const providerPrompt = waitForOutput(fakeStdout, 'Enter number [0]');
      const run = runInit({ dataDir });
      run.catch(() => {});
      await providerPrompt;

      const keyPrompt = waitForOutput(fakeStdout, ' API key');
      fakeStdin.write('1\n');
      await keyPrompt;

      const modelPrompt = waitForOutput(fakeStdout, 'Default model [');
      // Type a partial key then press Ctrl-D (EOT byte 0x04).
      for (const character of 'sk-partial') fakeStdin.write(character);
      fakeStdin.write(Buffer.from([0x04]));

      // Ctrl-D should submit; continue the wizard with the rest of the prompts.
      await modelPrompt;
      expect(rawMode).toHaveBeenLastCalledWith(false);

      const modePrompt = waitForOutput(fakeStdout, 'Mode —');
      fakeStdin.write('fixture-model\n');
      await modePrompt;
      fakeStdin.write('\n');
      await run;

      expect(kill).not.toHaveBeenCalledWith(process.pid, 'SIGINT');
      const config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'));
      expect(config.providers[0]).toMatchObject({ apiKey: 'sk-partial' });
    } finally {
      Object.defineProperty(process, 'stdin', originalStdin);
      Object.defineProperty(process, 'stdout', originalStdout);
      fakeStdin.destroy();
      fakeStdout.destroy();
      rawMode.mockRestore();
      kill.mockRestore();
      syncBuiltinESMExports();
    }
  });
});

async function withInitStreams(
  input: PassThrough,
  output: PassThrough,
  test: (captured: () => string) => Promise<void>,
): Promise<void> {
  const originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin')!;
  const originalStdout = Object.getOwnPropertyDescriptor(process, 'stdout')!;
  let captured = '';
  output.on('data', (chunk: Buffer) => { captured += chunk.toString('utf8'); });
  Object.defineProperty(process, 'stdin', { value: input, configurable: true });
  Object.defineProperty(process, 'stdout', { value: output, configurable: true });
  syncBuiltinESMExports();
  try {
    await test(() => captured);
  } finally {
    Object.defineProperty(process, 'stdin', originalStdin);
    Object.defineProperty(process, 'stdout', originalStdout);
    syncBuiltinESMExports();
    input.destroy();
    output.destroy();
  }
}

describe('init stream input', () => {
  it.each([undefined, false, true])('reads one bulk chunk without raw-mode support (isTTY: %s)', async (isTTY) => {
    const input = Object.assign(new PassThrough(), { isTTY });
    // A TTY output must not make piped input echo or enable raw mode.
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 120 });
    const secret = 'sk-test-pipe-484';

    await withInitStreams(input, output, async (captured) => {
      const providerPrompt = waitForOutput(output, 'Enter number [0]');
      const run = runInit({ dataDir });
      await providerPrompt;
      expect(captured()).not.toContain(' API key');
      expect(input).not.toHaveProperty('setRawMode');
      // All answers arrive before the second question, including a blank model.
      input.end(`1\n${secret}\n\nlocal\n`);
      await run;

      const config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'));
      expect(config.providers[0]).toMatchObject({ apiKey: secret });
      expect(config.mode).toBe('local');
      expect(captured()).toContain(' API key');
      expect(captured()).toContain('Default model [');
      expect(captured()).toContain('Mode —');
      expect(captured()).toContain('Config written.');
      expect(captured()).not.toContain(secret);
    });
  });

  it('reads line-paced pipe input without calling an available setRawMode', async () => {
    const setRawMode = vi.fn();
    const input = Object.assign(new PassThrough(), { isTTY: false, setRawMode });
    const output = new PassThrough();
    const secret = 'sk-test-paced-484';

    await withInitStreams(input, output, async (captured) => {
      const providerPrompt = waitForOutput(output, 'Enter number [0]');
      const run = runInit({ dataDir });
      await providerPrompt;
      for (const [answer, nextPrompt] of [
        ['1', ' API key'],
        [secret, 'Default model ['],
        ['fixture-model', 'Mode —'],
      ] as const) {
        const next = waitForOutput(output, nextPrompt);
        input.write(`${answer}\n`);
        await Promise.race([next, run]);
      }
      input.end('local\n');
      await run;

      const config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'));
      expect(config.providers[0]).toMatchObject({ apiKey: secret, defaultModel: 'fixture-model' });
      expect(setRawMode).not.toHaveBeenCalled();
      expect(captured()).toContain('Config written.');
      expect(captured()).not.toContain(secret);
    });
  });

  it('does not echo bulk piped input when provider validation rejects', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const secret = 'sk-test-rejected-484';

    await withInitStreams(input, output, async (captured) => {
      const run = runInit({ dataDir });
      input.end(`invalid\n${secret}\n`);
      await expect(run).rejects.toThrow('Choose a provider number');
      expect(captured()).toContain('Enter number [0]');
      expect(captured()).not.toContain(secret);
      expect(readdirSync(dataDir)).toEqual([]);
    });
  });

  it('reads bulk server answers after skipping AI, including a final line without a newline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const input = new PassThrough();
    const output = new PassThrough();

    try {
      await withInitStreams(input, output, async () => {
        const stalled = new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error('Bulk input did not complete setup.')), 1000);
        });
        const result = Promise.race([runInit({ dataDir }), stalled]).then(
          () => 'complete',
          (error: Error) => error.message,
        );
        input.end('0\nserver\n0.0.0.0\n8888');
        await vi.runAllTimersAsync();
        expect(await result).toBe('complete');
        const config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'));
        expect(config).toMatchObject({ providers: [], mode: 'server', server: { host: '0.0.0.0', port: 8888 } });
      });
    } finally {
      vi.useRealTimers();
    }
  });

  const customProvider = String(Object.keys(PROVIDER_PRESETS).indexOf('openai-compatible') + 1);
  it.each([
    ['provider', '', 'Enter number [0]'],
    ['API key', '1\n', ' API key'],
    ['base URL', `${customProvider}\n`, 'Base URL ['],
    ['model', '1\nsk-test-eof\n', 'Default model ['],
    ['mode', '1\nsk-test-eof\n\n', 'Mode —'],
    ['host', '1\nsk-test-eof\n\nserver\n', 'Bind host ['],
    ['port', '1\nsk-test-eof\n\nserver\n\n', 'Port ['],
  ])('rejects EOF before the %s answer without writing config', async (_name, answers, question) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const input = new PassThrough();
    const output = new PassThrough();
    try {
      await withInitStreams(input, output, async (captured) => {
        // A fake deadline makes a hanging EOF path fail without a wall-clock wait.
        const stalled = new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error('Init is still waiting after EOF.')), 1000);
        });
        const ended = once(input, 'end');
        const result = Promise.race([Promise.all([runInit({ dataDir }), ended]), stalled]).then(
          () => undefined,
          (error: unknown) => error,
        );
        input.end(answers);
        await vi.runAllTimersAsync();

        expect(await result).toMatchObject({ message: 'Input ended before setup was complete.' });
        expect(captured()).toContain(question);
        expect(captured()).not.toContain('sk-test-eof');
        expect(captured()).not.toContain('Config written.');
        expect(readdirSync(dataDir)).toEqual([]);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps TTY secret input hidden when stdout is piped', async () => {
    const setRawMode = vi.fn(function (this: PassThrough, _mode: boolean) { return this; });
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode });
    const output = Object.assign(new PassThrough(), { isTTY: false });
    const secret = 'sk-test-tty-redirected';

    await withInitStreams(input, output, async (captured) => {
      const providerPrompt = waitForOutput(output, 'Enter number [0]');
      const run = runInit({ dataDir });
      await providerPrompt;
      const keyPrompt = waitForOutput(output, ' API key');
      input.write('1\n');
      await Promise.race([keyPrompt, run]);
      expect(setRawMode).toHaveBeenLastCalledWith(true);

      const modelPrompt = waitForOutput(output, 'Default model [');
      for (const character of secret) input.write(character);
      input.write('\n');
      await Promise.race([modelPrompt, run]);
      expect(setRawMode).toHaveBeenLastCalledWith(false);
      const modePrompt = waitForOutput(output, 'Mode —');
      input.write('\n');
      await Promise.race([modePrompt, run]);
      input.write('local\n');
      await run;

      const config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'));
      expect(config.providers[0]).toMatchObject({ apiKey: secret });
      expect(captured()).toContain('Config written.');
      expect(captured()).not.toContain(secret);
    });
  });
});
