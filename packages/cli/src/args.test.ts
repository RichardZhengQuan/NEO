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
      expect(r).toHaveProperty('error');
    });

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
        '--conversation', 'conv-abc', '--model', 'anthropic/claude-3-opus',
        '--incognito', '--show-reasoning']);
      expect(r).toMatchObject({
        cmd: 'chat',
        server: 'http://localhost:9000',
        token: 'tok123',
        conversation: 'conv-abc',
        model: 'anthropic/claude-3-opus',
        incognito: true,
        showReasoning: true,
      });
    });
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

    it('parses memory import', () => {
      const r = parseCliArgs(['memory', 'import', '/tmp/export.json', '--replace']);
      expect(r).toMatchObject({ cmd: 'memory', sub: 'import', file: '/tmp/export.json', replace: true });
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
