/**
 * `neo memory export|import|stats|consolidate`
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NeoClient } from '@neo/client';
import type { MemoryExport } from '@neo/protocol';
import { bold, cyan, dim, green, stripModelText } from '../ansi.js';
import { resolveDataDir, readToken } from '../config-file.js';

export interface MemoryOptions {
  sub: 'export' | 'import' | 'stats' | 'consolidate';
  file?: string;
  replace?: boolean;
  dataDir?: string;
  server?: string;
  token?: string;
}

export async function runMemory(opts: MemoryOptions): Promise<void> {
  const dataDir = resolveDataDir(opts.dataDir);
  const serverUrl = opts.server ?? `http://127.0.0.1:7777`;
  const token = opts.token ?? readToken(dataDir) ?? '';

  const client = new NeoClient({ baseUrl: serverUrl, token });

  switch (opts.sub) {
    case 'export':
      await doExport(client, opts.file);
      break;
    case 'import':
      await doImport(client, opts.file!, opts.replace);
      break;
    case 'stats':
      await doStats(client);
      break;
    case 'consolidate':
      await doConsolidate(client);
      break;
  }
}

async function doExport(client: NeoClient, file?: string): Promise<void> {
  const data = await client.memory.export();
  const json = JSON.stringify(data, null, 2);

  if (file) {
    fs.writeFileSync(file, json, 'utf8');
    process.stdout.write(green(`  Memory exported to ${file} (${data.nodes?.length ?? 0} nodes)\n`));
  } else {
    process.stdout.write(json + '\n');
  }
}

async function doImport(client: NeoClient, file: string, replace?: boolean): Promise<void> {
  if (!fs.existsSync(file)) {
    process.stderr.write(`  File not found: ${file}\n`);
    process.exit(1);
  }
  const json = fs.readFileSync(file, 'utf8');
  let data: MemoryExport;
  try {
    data = JSON.parse(json) as MemoryExport;
  } catch {
    process.stderr.write(`  Invalid JSON in ${file}\n`);
    process.exit(1);
  }

  const result = await client.memory.import(data, replace ? 'replace' : 'merge');
  process.stdout.write(green(`  Import complete: ${result.nodes} nodes, ${result.edges} edges, ${result.skipped} skipped.\n`));
}

async function doStats(client: NeoClient): Promise<void> {
  const stats = await client.memory.stats();
  process.stdout.write(`\n  ${bold(cyan('Memory stats'))}\n`);
  process.stdout.write(`  ${bold('Total nodes:')} ${stats.total}\n`);
  for (const [k, v] of Object.entries(stats.byKind)) {
    process.stdout.write(`    ${k}: ${v}\n`);
  }
  process.stdout.write(`  ${bold('Edges:')} ${stats.edges}\n`);
  if (stats.lastConsolidationAt) {
    process.stdout.write(`  ${bold('Last consolidation:')} ${new Date(stats.lastConsolidationAt).toLocaleString()}\n`);
  }
  process.stdout.write('\n');
}

async function doConsolidate(client: NeoClient): Promise<void> {
  process.stdout.write(dim('  Running consolidation…\n'));
  const report = await client.memory.consolidate();
  process.stdout.write(green(`  Consolidation complete.\n`));
  process.stdout.write(`  Archived: ${report.archived}  Episodes: ${report.episodesConsolidated}  Facts: ${report.factsCreated}  Entities merged: ${report.entitiesMerged}\n`);
  if (report.notes?.length) {
    for (const note of report.notes.slice(0, 5)) {
      process.stdout.write(dim(`  • ${stripModelText(note)}\n`));
    }
  }
  process.stdout.write('\n');
}
