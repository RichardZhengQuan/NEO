/**
 * `neo token` — print the owner token.
 */
import { resolveDataDir, readToken, readConfigFile, expandHome } from '../config-file.js';
import * as path from 'node:path';

export interface TokenOptions {
  dataDir?: string;
}

export async function runToken(opts: TokenOptions): Promise<void> {
  const dataDir = resolveDataDir(opts.dataDir);

  // Try config file first
  const cfgPath = path.join(dataDir, 'config.json');
  const cfg = readConfigFile(cfgPath);
  if (cfg && (cfg as Record<string, unknown>)['server']) {
    const serverCfg = (cfg as Record<string, unknown>)['server'] as Record<string, unknown>;
    if (typeof serverCfg['authToken'] === 'string') {
      process.stdout.write(`${serverCfg['authToken']}\n`);
      return;
    }
  }

  // Try token file
  const token = readToken(dataDir);
  if (token) {
    process.stdout.write(`${token}\n`);
    return;
  }

  process.stderr.write(`  No token found in ${dataDir}.\n`);
  process.stderr.write('  Run `neo serve` once to generate a token, or `neo init` to set one.\n');
  process.exit(1);
}
