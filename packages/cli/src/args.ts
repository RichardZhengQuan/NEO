/**
 * Argument parsing for the `neo` command.
 * Uses node:util parseArgs so we stay dependency-free.
 */
import { parseArgs } from 'node:util';

export type Command =
  | { cmd: 'serve'; host?: string; port?: number; dataDir?: string; mode?: string; config?: string; webDir?: string; logLevel?: string; showToken?: boolean }
  | { cmd: 'chat'; server?: string; token?: string; offRecord?: boolean; showReasoning?: boolean }
  | { cmd: 'init'; dataDir?: string }
  | { cmd: 'pair'; name?: string; platform?: string; dataDir?: string; server?: string; token?: string }
  | { cmd: 'token'; dataDir?: string }
  | { cmd: 'memory'; sub: 'export' | 'import' | 'stats' | 'consolidate'; file?: string; replace?: boolean; dataDir?: string; server?: string; token?: string }
  | { cmd: 'doctor'; dataDir?: string; server?: string; token?: string }
  | { cmd: 'version' }
  | { cmd: 'help'; topic?: string };

export type ParseArgsError = { error: string };

/** Parse a decimal port in the range 0–65535. */
export function parsePort(input: string): number | ParseArgsError {
  const trimmed = input.trim();
  const port = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || port < 0 || port > 65535) {
    return { error: `Invalid port: ${input}` };
  }
  return port;
}

/** Parse process.argv (or a provided array). Returns a Command or an error. */
export function parseCliArgs(argv: string[] = process.argv.slice(2)): Command | ParseArgsError {
  if (argv.length === 0) return { cmd: 'help' };

  const first = argv[0];
  if (first === '--version' || first === '-v') return { cmd: 'version' };
  if (first === '--help' || first === '-h' || first === 'help') {
    return { cmd: 'help', topic: argv[1] };
  }

  switch (first) {
    case 'serve': return parseServe(argv.slice(1));
    case 'chat': return parseChat(argv.slice(1));
    case 'init': return parseInit(argv.slice(1));
    case 'pair': return parsePair(argv.slice(1));
    case 'token': return parseToken(argv.slice(1));
    case 'memory': return parseMemory(argv.slice(1));
    case 'doctor': return parseDoctor(argv.slice(1));
    default:
      return { error: `Unknown command: ${first}. Run \`neo help\` for usage.` };
  }
}

// ─── sub-parsers ───────────────────────────────────────────────────────────────

function parseServe(args: string[]): Command | ParseArgsError {
  try {
    const { values } = parseArgs({
      args,
      options: {
        host: { type: 'string' },
        port: { type: 'string' },
        'data-dir': { type: 'string' },
        mode: { type: 'string' },
        config: { type: 'string' },
        'web-dir': { type: 'string' },
        'log-level': { type: 'string' },
        'show-token': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) return { cmd: 'help', topic: 'serve' };
    const port = values.port === undefined ? undefined : parsePort(values.port);
    if (typeof port === 'object') return port;
    if (values.mode && values.mode !== 'local' && values.mode !== 'server') {
      return { error: `--mode must be local or server` };
    }
    return {
      cmd: 'serve',
      host: values.host,
      port,
      dataDir: values['data-dir'],
      mode: values.mode,
      config: values.config,
      webDir: values['web-dir'],
      logLevel: values['log-level'],
      showToken: values['show-token'],
    };
  } catch (e) {
    return { error: String(e) };
  }
}

function parseChat(args: string[]): Command | ParseArgsError {
  try {
    const { values } = parseArgs({
      args,
      options: {
        server: { type: 'string' },
        token: { type: 'string' },
        'off-record': { type: 'boolean', default: false },
        'show-reasoning': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) return { cmd: 'help', topic: 'chat' };
    return {
      cmd: 'chat',
      server: values.server,
      token: values.token,
      offRecord: values['off-record'],
      showReasoning: values['show-reasoning'],
    };
  } catch (e) {
    return { error: String(e) };
  }
}

function parseInit(args: string[]): Command | ParseArgsError {
  try {
    const { values } = parseArgs({
      args,
      options: {
        'data-dir': { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) return { cmd: 'help', topic: 'init' };
    return { cmd: 'init', dataDir: values['data-dir'] };
  } catch (e) {
    return { error: String(e) };
  }
}

function parsePair(args: string[]): Command | ParseArgsError {
  try {
    const { values } = parseArgs({
      args,
      options: {
        name: { type: 'string' },
        platform: { type: 'string' },
        'data-dir': { type: 'string' },
        server: { type: 'string' },
        token: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) return { cmd: 'help', topic: 'pair' };
    return {
      cmd: 'pair',
      name: values.name,
      platform: values.platform,
      dataDir: values['data-dir'],
      server: values.server,
      token: values.token,
    };
  } catch (e) {
    return { error: String(e) };
  }
}

function parseToken(args: string[]): Command | ParseArgsError {
  try {
    const { values } = parseArgs({
      args,
      options: {
        'data-dir': { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) return { cmd: 'help', topic: 'token' };
    return { cmd: 'token', dataDir: values['data-dir'] };
  } catch (e) {
    return { error: String(e) };
  }
}

function parseMemory(args: string[]): Command | ParseArgsError {
  const sub = args[0];
  if (!sub) return { error: 'memory requires a subcommand: export, import, stats, consolidate' };
  if (sub === '--help' || sub === '-h') return { cmd: 'help', topic: 'memory' };
  const rest = args.slice(1);

  if (sub === 'stats' || sub === 'consolidate') {
    try {
      const { values } = parseArgs({
        args: rest,
        options: {
          'data-dir': { type: 'string' },
          server: { type: 'string' },
          token: { type: 'string' },
          help: { type: 'boolean', short: 'h', default: false },
        },
        strict: true,
        allowPositionals: false,
      });
      if (values.help) return { cmd: 'help', topic: 'memory' };
      return { cmd: 'memory', sub: sub as 'stats' | 'consolidate', dataDir: values['data-dir'], server: values.server, token: values.token };
    } catch (e) {
      return { error: String(e) };
    }
  }

  if (sub === 'export') {
    try {
      const { values, positionals } = parseArgs({
        args: rest,
        options: {
          'data-dir': { type: 'string' },
          server: { type: 'string' },
          token: { type: 'string' },
          help: { type: 'boolean', short: 'h', default: false },
        },
        strict: true,
        allowPositionals: true,
      });
      if (values.help) return { cmd: 'help', topic: 'memory' };
      if (positionals.length > 1) {
        return { error: `memory export takes at most one file path, got: ${positionals.slice(1).join(', ')}` };
      }
      return { cmd: 'memory', sub: 'export', file: positionals[0], dataDir: values['data-dir'], server: values.server, token: values.token };
    } catch (e) {
      return { error: String(e) };
    }
  }

  if (sub === 'import') {
    try {
      const { values, positionals } = parseArgs({
        args: rest,
        options: {
          replace: { type: 'boolean', default: false },
          'data-dir': { type: 'string' },
          server: { type: 'string' },
          token: { type: 'string' },
          help: { type: 'boolean', short: 'h', default: false },
        },
        strict: true,
        allowPositionals: true,
      });
      if (values.help) return { cmd: 'help', topic: 'memory' };
      if (positionals.length > 1) {
        return { error: `memory import takes exactly one file path, got extra: ${positionals.slice(1).join(', ')}` };
      }
      if (!positionals[0]) return { error: 'memory import requires a file path' };
      return { cmd: 'memory', sub: 'import', file: positionals[0], replace: values.replace, dataDir: values['data-dir'], server: values.server, token: values.token };
    } catch (e) {
      return { error: String(e) };
    }
  }

  return { error: `Unknown memory subcommand: ${sub}. Use export, import, stats, or consolidate.` };
}

function parseDoctor(args: string[]): Command | ParseArgsError {
  try {
    const { values } = parseArgs({
      args,
      options: {
        'data-dir': { type: 'string' },
        server: { type: 'string' },
        token: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) return { cmd: 'help', topic: 'doctor' };
    return { cmd: 'doctor', dataDir: values['data-dir'], server: values.server, token: values.token };
  } catch (e) {
    return { error: String(e) };
  }
}
