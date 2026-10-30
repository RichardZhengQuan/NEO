/**
 * `neo serve` — start the NEO server and print a startup banner.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig, startServer, type LoadConfigOptions } from '@neo/server';
import { buildPairingUrl, NeoError } from '@neo/protocol';
import QRCode from 'qrcode';
import { expandHome } from '../config-file.js';
import { safeConfigDiagnostic } from '../config-diagnostic.js';
import { renderBanner } from '../render.js';

export interface ServeOptions {
  host?: string;
  port?: number;
  dataDir?: string;
  mode?: string;
  config?: string;
  webDir?: string;
  logLevel?: string;
  showToken?: boolean;
}

export async function runServe(opts: ServeOptions): Promise<void> {
  // Build overrides from CLI flags
  const overrides: Record<string, unknown> = {};
  if (opts.mode === 'local' || opts.mode === 'server') overrides['mode'] = opts.mode;
  // Only override dataDir when the flag is explicitly provided.
  // NEO_DATA_DIR is handled by loadConfig's env layer; the config file's dataDir
  // is used when neither flag nor env is set.
  if (opts.dataDir !== undefined) {
    overrides['dataDir'] = expandHome(opts.dataDir);
  }
  if (opts.host || opts.port !== undefined || opts.webDir || opts.logLevel) {
    const serverObj: Record<string, unknown> = {};
    if (opts.host) serverObj['host'] = opts.host;
    if (opts.port !== undefined) serverObj['port'] = opts.port;
    if (opts.webDir) serverObj['webDir'] = opts.webDir;
    overrides['server'] = serverObj;
    if (opts.logLevel) {
      overrides['log'] = { level: opts.logLevel };
    }
  }

  const loadOpts: LoadConfigOptions = {
    path: opts.config,
    overrides: overrides as LoadConfigOptions['overrides'],
  };
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(loadOpts);
  } catch (error) {
    const diagnostic = safeConfigDiagnostic(error);
    if (diagnostic) throw new NeoError('config_error', diagnostic, { cause: error });
    throw error;
  }

  // Auto-detect only when config file, env, and CLI flags left webDir unset.
  if (!config.server.webDir) {
    const webDir = detectWebDir();
    if (webDir) config.server.webDir = webDir;
  }

  // Start the server
  const server = await startServer(config);

  // Owner pairing links are secrets too: generate them only on explicit request.
  let qrText: string | undefined;
  let pairingUrl: string | undefined;
  if (config.mode === 'server' && opts.showToken === true) {
    const publicUrl = config.server.publicUrl ?? server.url;
    pairingUrl = buildPairingUrl(publicUrl, server.ownerToken);
    try {
      qrText = await QRCode.toString(pairingUrl, { type: 'terminal', small: true });
    } catch {
      qrText = undefined;
    }
  }

  // Print banner
  const banner = renderBanner({
    url: server.url,
    mode: config.mode,
    dataDir: expandHome(config.dataDir),
    ownerToken: server.ownerToken,
    showToken: opts.showToken ?? false,
    isInteractive: process.stdout.isTTY === true,
    webDir: config.server.webDir ?? null,
    qrText,
    pairingUrl,
  });
  process.stdout.write(banner);

  // Graceful shutdown
  const stop = async () => {
    process.stdout.write('\n  Shutting down…\n');
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => { void stop(); });
  process.on('SIGTERM', () => { void stop(); });

  // Keep alive
  await new Promise<void>(() => {/* never resolves unless server closes */});
}

/** Look for a built web app relative to the CLI package or via NEO_WEB_DIR. */
function detectWebDir(): string | null {
  const envDir = process.env['NEO_WEB_DIR'];
  if (envDir) {
    return fs.existsSync(envDir) ? envDir : null;
  }
  // Try <repo>/apps/web/dist relative to the CLI package (packages/cli)
  const candidates = [
    path.resolve(import.meta.dirname, '../../../apps/web/dist'),
    path.resolve(import.meta.dirname, '../../../../apps/web/dist'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'index.html'))) return c;
  }
  return null;
}
