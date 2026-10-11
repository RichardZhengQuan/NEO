/**
 * `neo pair` — create a device token and print a pairing QR + link.
 */
import { NeoClient } from '@neo/client';
import QRCode from 'qrcode';
import { bold, cyan, green, magenta } from '../ansi.js';
import { resolveDataDir, readToken } from '../config-file.js';

export interface PairOptions {
  name?: string;
  platform?: string;
  dataDir?: string;
  server?: string;
  token?: string;
}

export async function runPair(opts: PairOptions): Promise<void> {
  const dataDir = resolveDataDir(opts.dataDir);
  const serverUrl = opts.server ?? `http://127.0.0.1:7777`;
  const token = opts.token ?? readToken(dataDir) ?? '';

  if (!token) {
    process.stderr.write('  Error: no owner token found. Is the server running? Run `neo serve` first.\n');
    process.exit(1);
  }

  const client = new NeoClient({ baseUrl: serverUrl, token });

  const name = opts.name ?? `CLI-${new Date().toISOString().slice(0, 10)}`;
  const platform = (opts.platform as 'cli' | 'web' | 'desktop' | 'ios' | 'android' | 'other') ?? 'cli';

  const result = await client.devices.create(name, platform);

  process.stdout.write(`\n  ${bold(cyan('Device paired'))}\n`);
  process.stdout.write(`  ${bold('Name')}     ${result.device.name}\n`);
  process.stdout.write(`  ${bold('Token')}    ${magenta(result.token)}\n`);
  process.stdout.write(`  ${bold('URL')}      ${green(result.pairingUrl)}\n\n`);

  // Print QR code
  try {
    const qr = await QRCode.toString(result.pairingUrl, { type: 'terminal', small: true });
    process.stdout.write(qr);
    process.stdout.write('\n');
  } catch {
    // QR generation failed, URL is already printed
  }
}
