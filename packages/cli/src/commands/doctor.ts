/**
 * `neo doctor` — system health check.
 */
import { NeoClient } from '@neo/client';
import { bold, cyan, dim, green, red, yellow } from '../ansi.js';
import { resolveDataDir, readToken } from '../config-file.js';
import type { NeoConfig } from '@neo/protocol';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig } from '@neo/server';

export interface DoctorOptions {
  dataDir?: string;
  server?: string;
  token?: string;
}

interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
}

export async function runDoctor(opts: DoctorOptions): Promise<void> {
  process.stdout.write(`\n  ${bold(cyan('NEO doctor'))}\n\n`);
  const checks: Check[] = [];

  // 1. Node version
  const nodeVersion = process.versions.node;
  const [major, minor] = nodeVersion.split('.').map(Number);
  const nodeOk = (major ?? 0) > 22 || ((major ?? 0) === 22 && (minor ?? 0) >= 13);
  checks.push({
    name: 'Node.js version',
    status: nodeOk ? 'ok' : 'fail',
    message: nodeOk ? `v${nodeVersion}` : `v${nodeVersion} — requires v22.13 or later`,
  });

  // 2. node:sqlite available
  let sqliteOk = false;
  try {
    await import('node:sqlite' as unknown as string);
    sqliteOk = true;
  } catch {
    sqliteOk = false;
  }
  checks.push({
    name: 'node:sqlite',
    status: sqliteOk ? 'ok' : 'fail',
    message: sqliteOk ? 'available' : 'not available (requires Node.js 22.13+)',
  });

  // 3. Data dir writable
  const dataDir = resolveDataDir(opts.dataDir);
  let dataDirOk = false;
  let dataDirMsg = '';
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const testFile = path.join(dataDir, '.neo-doctor-test');
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
    dataDirOk = true;
    dataDirMsg = dataDir;
  } catch (e) {
    dataDirMsg = `${dataDir} — ${String(e)}`;
  }
  checks.push({
    name: 'Data directory',
    status: dataDirOk ? 'ok' : 'fail',
    message: dataDirMsg,
  });

  // 4. Config valid
  const cfgPath = path.join(dataDir, 'config.json');
  let configStatus: 'ok' | 'warn' | 'fail' = 'warn';
  let configMsg = 'no config.json found (run `neo init`)';
  let configuredProviders: NeoConfig['providers'] = [];
  try {
    configuredProviders = loadConfig({ path: cfgPath, overrides: { dataDir } }).providers;
    if (fs.existsSync(cfgPath)) {
      configStatus = 'ok';
      configMsg = cfgPath;
    }
  } catch (e) {
    configStatus = 'fail';
    configMsg = `invalid config: ${String(e)}`;
  }
  checks.push({ name: 'Config', status: configStatus, message: configMsg });

  // 5. Server reachable
  const serverUrl = opts.server ?? `http://127.0.0.1:7777`;
  const token = opts.token ?? readToken(dataDir) ?? '';
  let serverStatus: 'ok' | 'warn' | 'fail' = 'fail';
  let serverMsg = '';
  try {
    const client = new NeoClient({ baseUrl: serverUrl, token, timeoutMs: 3000 });
    const health = await client.health();
    serverStatus = 'ok';
    serverMsg = `${serverUrl} — ${health.name} v${health.version} (${health.mode})`;
  } catch (e) {
    serverMsg = `${serverUrl} — not reachable`;
  }
  checks.push({ name: 'Server', status: serverStatus, message: serverMsg });

  // 6. Provider test (only if server is reachable)
  if (serverStatus === 'ok' && token) {
    try {
      const client = new NeoClient({ baseUrl: serverUrl, token, timeoutMs: 10_000 });
      const res = await client.providers.list();
      const providers = res.items.filter(p => p.enabled && p.kind !== 'mock');
      if (providers.length === 0) {
        checks.push({ name: 'Providers', status: 'warn', message: 'no AI provider configured (connect an AI in Settings → AI or run `neo init`)' });
      } else {
        for (const p of providers.slice(0, 3)) {
          try {
            const result = await client.providers.test(p.id);
            checks.push({
              name: `Provider: ${p.id}`,
              status: result.ok ? 'ok' : 'fail',
              message: result.ok ? `${p.label ?? p.id} (${p.kind})` : (result.error ?? 'failed'),
            });
          } catch (e) {
            checks.push({ name: `Provider: ${p.id}`, status: 'fail', message: String(e) });
          }
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const is404 = /\b404\b/.test(msg);
      checks.push({
        name: 'Providers',
        status: is404 ? 'warn' : 'fail',
        message: is404
          ? 'provider list unavailable (older server?)'
          : `provider list failed — ${msg}`,
      });
    }
  } else if (!configuredProviders.some(p => p.enabled && p.kind !== 'mock')) {
    checks.push({ name: 'Providers', status: 'warn', message: 'no AI provider configured (connect an AI in Settings → AI or run `neo init`)' });
  }

  // Print results
  let hasFailure = false;
  for (const check of checks) {
    const icon = check.status === 'ok' ? green('✓') : check.status === 'warn' ? yellow('!') : red('✗');
    const name = bold(check.name.padEnd(20));
    process.stdout.write(`  ${icon} ${name} ${check.status === 'ok' ? dim(check.message) : check.message}\n`);
    if (check.status === 'fail') hasFailure = true;
  }

  process.stdout.write('\n');
  if (hasFailure) {
    process.stdout.write(red('  Some checks failed. See above for details.\n\n'));
    process.exit(1);
  } else {
    process.stdout.write(green('  All checks passed.\n\n'));
  }
}
