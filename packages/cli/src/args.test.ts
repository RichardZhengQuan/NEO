/**
 * Argument parsing tests.
 */
import { describe, it, expect } from 'vitest';
import { parseCliArgs } from './args.js';

describe('parseCliArgs', () => {
  it('returns help with no args', () => {
    expect(parseCliArgs([])).toEqual({ cmd: 'help' });
  });

  it('returns version for --version', () => {
    expect(parseCliArgs(['--version'])).toEqual({ cmd: 'version' });
    expect(parseCliArgs(['-v'])).toEqual({ cmd: 'version' });
  });

  it('returns help for help', () => {
    expect(parseCliArgs(['help'])).toMatchObject({ cmd: 'help' });
    expect(parseCliArgs(['--help'])).toMatchObject({ cmd: 'help' });
  });

  it('returns help topic', () => {
    expect(parseCliArgs(['help', 'serve'])).toEqual({ cmd: 'help', topic: 'serve' });
  });

  // ── serve ──
  describe('serve', () => {
    it('parses no flags', () => {
      const r = parseCliArgs(['serve']);
      expect(r).toMatchObject({ cmd: 'serve' });
    });

    it('parses all flags', () => {
      const r = parseCliArgs(['serve', '--host', '0.0.0.0', '--port', '8080', '--data-dir', '/tmp/neo',
        '--mode', 'server', '--config', '/etc/neo.json', '--web-dir', '/var/web',
        '--log-level', 'debug', '--show-token']);
      expect(r).toMatchObject({
        cmd: 'serve',
        host: '0.0.0.0',
        port: 8080,
        dataDir: '/tmp/neo',
        mode: 'server',
        config: '/etc/neo.json',
        webDir: '/var/web',
        logLevel: 'debug',
        showToken: true,
      });
    });

    it('rejects bad port', () => {
      const r = parseCliArgs(['serve', '--port', 'abc']);
      expect(r).toEqual({ error: 'Invalid port: abc' });
    });

    it('--port 7777junk → Invalid port', () => {
      expect(parseCliArgs(['serve', '--port', '7777junk'])).toEqual({ error: 'Invalid port: 7777junk' });
    });

    it('--port 1e4 → Invalid port', () => {
      expect(parseCliArgs(['serve', '--port', '1e4'])).toEqual({ error: 'Invalid port: 1e4' });
    });

    it('existing valid cases keep passing', () => {
      expect(parseCliArgs(['serve', '--port', '8080'])).toMatchObject({ cmd: 'serve', port: 8080 });
    });

    it.each(['', '   ', '-1', '65536', '8080.5', '+8080', '0x1f90', '8080 90'])(
      'rejects invalid decimal port %j', (input) => {
        expect(parseCliArgs(['serve', '--port', input])).toHaveProperty('error');
      },
    );

    it('rejects a negative port with equals syntax', () => {
      expect(parseCliArgs(['serve', '--port=-1'])).toEqual({ error: 'Invalid port: -1' });
    });

    it.each([['0', 0], ['65535', 65535], [' 8080 ', 8080], ['008080', 8080]] as const)(
      'accepts decimal port %j', (input, port) => {
        expect(parseCliArgs(['serve', '--port', input])).toMatchObject({ cmd: 'serve', port });
      },
    );

    it('rejects bad mode', () => {
      const r = parseCliArgs(['serve', '--mode', 'invalid']);
      expect(r).toHaveProperty('error');
    });

    it('returns help for --help', () => {
      const r = parseCliArgs(['serve', '--help']);
      expect(r).toMatchObject({ cmd: 'help', topic: 'serve' });
    });
  });

  // ── chat ──
  describe('chat', () => {
    it('parses no flags', () => {
      expect(parseCliArgs(['chat'])).toMatchObject({ cmd: 'chat' });
    });

    it('parses all flags', () => {
      const r = parseCliArgs(['chat', '--server', 'http://localhost:9000', '--token', 'tok123',
        '--off-record', '--show-reasoning']);
      expect(r).toMatchObject({
        cmd: 'chat',
        server: 'http://localhost:9000',
        token: 'tok123',
        offRecord: true,
        showReasoning: true,
      });
    });
  });

  it.each(['--conversation', '--model', '--incognito'])('rejects removed chat option %s', (flag) => {
    expect(parseCliArgs(['chat', flag])).toHaveProperty('error');
  });

  // ── init ──
  describe('init', () => {
    it('parses no flags', () => {
      expect(parseCliArgs(['init'])).toMatchObject({ cmd: 'init' });
    });

    it('parses --data-dir', () => {
      const r = parseCliArgs(['init', '--data-dir', '/tmp/neo']);
      expect(r).toMatchObject({ cmd: 'init', dataDir: '/tmp/neo' });
    });
  });

  // ── pair ──
  describe('pair', () => {
    it('parses all flags', () => {
      const r = parseCliArgs(['pair', '--name', 'My Phone', '--platform', 'ios', '--server', 'http://s:7777']);
      expect(r).toMatchObject({
        cmd: 'pair',
        name: 'My Phone',
        platform: 'ios',
        server: 'http://s:7777',
      });
    });
  });

  // ── token ──
  describe('token', () => {
    it('parses no flags', () => {
      expect(parseCliArgs(['token'])).toMatchObject({ cmd: 'token' });
    });
  });

  // ── memory ──
  describe('memory', () => {
    it('rejects missing subcommand', () => {
      const r = parseCliArgs(['memory']);
      expect(r).toHaveProperty('error');
    });

    it('parses memory stats', () => {
      expect(parseCliArgs(['memory', 'stats'])).toMatchObject({ cmd: 'memory', sub: 'stats' });
    });

    it('parses memory consolidate', () => {
      expect(parseCliArgs(['memory', 'consolidate'])).toMatchObject({ cmd: 'memory', sub: 'consolidate' });
    });

    it('parses memory export with file', () => {
      const r = parseCliArgs(['memory', 'export', '/tmp/export.json']);
      expect(r).toMatchObject({ cmd: 'memory', sub: 'export', file: '/tmp/export.json' });
    });

    it('parses memory export without file', () => {
      const r = parseCliArgs(['memory', 'export']);
      expect(r).toMatchObject({ cmd: 'memory', sub: 'export', file: undefined });
    });

    it('rejects memory export with extra file paths', () => {
      const r = parseCliArgs(['memory', 'export', 'a.json', 'b.json']);
      expect(r).toEqual({ error: 'memory export takes at most one file path, got: b.json' });
    });

    it('parses memory import', () => {
      const r = parseCliArgs(['memory', 'import', '/tmp/export.json', '--replace']);
      expect(r).toMatchObject({ cmd: 'memory', sub: 'import', file: '/tmp/export.json', replace: true });
    });

    it('rejects memory import with extra file paths', () => {
      const r = parseCliArgs(['memory', 'import', 'a.json', 'b.json']);
      expect(r).toEqual({ error: 'memory import takes exactly one file path, got extra: b.json' });
    });

    it('rejects memory import with no file', () => {
      const r = parseCliArgs(['memory', 'import']);
      expect(r).toHaveProperty('error');
    });

    it('rejects unknown memory subcommand', () => {
      const r = parseCliArgs(['memory', 'foobar']);
      expect(r).toHaveProperty('error');
    });
  });

  // ── doctor ──
  describe('doctor', () => {
    it('parses no flags', () => {
      expect(parseCliArgs(['doctor'])).toMatchObject({ cmd: 'doctor' });
    });

    it('parses server + token', () => {
      const r = parseCliArgs(['doctor', '--server', 'http://s', '--token', 't']);
      expect(r).toMatchObject({ cmd: 'doctor', server: 'http://s', token: 't' });
    });
  });

  it('returns error for unknown command', () => {
    const r = parseCliArgs(['foobar']);
    expect(r).toHaveProperty('error');
  });
});
