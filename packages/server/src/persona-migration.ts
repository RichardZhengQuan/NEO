import { createHash } from 'node:crypto';
import { NeoError, silentLogger } from '@neo/protocol';
import type { Clock, Logger, MemoryService, RememberInput, SettingsStore } from '@neo/protocol';
import { assistantStyleTags } from '@neo/memory';
import { fromJson, type NeoDatabase } from '@neo/storage';

export const PERSONA_MEMORY_MIGRATION = 'persona-settings-to-memory:v1';
const SOURCE = { by: 'user', note: 'migrated from persona settings' } as const;
const DEFAULT_TRAITS = ['curious', 'warm', 'direct'];

function splitInstructions(text: string): string[] {
  const items: string[] = [];
  let start = 0;
  const boundaries = /(?<=[.!?])\s+|(?<=[。！？])\s*|[\n;；]+|\s+(?:and|then)\s+(?=(?:keep|call|reply|respond|answer|speak|write|be)\b)/giu;
  for (const boundary of text.matchAll(boundaries)) {
    const preceding = text.slice(start, boundary.index);
    // Dots in titles and initials belong to the instruction, as do unspaced domains and decimals.
    if (/^\s+$/u.test(boundary[0]) && (/\b(?:dr|mr|mrs|ms|prof|sr|jr|st|vs|etc|e\.g|i\.e)\.$/iu.test(preceding) || /\b(?:[A-Z]\.)+$/u.test(preceding))) continue;
    if (preceding.trim()) items.push(preceding.trim());
    start = boundary.index + boundary[0].length;
  }
  if (text.slice(start).trim()) items.push(text.slice(start).trim());
  return items;
}

function preferences(persona: unknown): RememberInput[] {
  if (!persona || typeof persona !== 'object' || Array.isArray(persona)) return [];
  const raw = persona as Record<string, unknown>;
  const items: RememberInput[] = [];
  const add = (content: string, aspect?: string) => items.push({
    kind: 'preference', content, importance: 0.8, source: SOURCE,
    tags: assistantStyleTags(content, ['assistant-style', ...(aspect ? [`assistant-style:${aspect}`] : [])]),
  });
  if (typeof raw.name === 'string' && raw.name.trim() && raw.name !== 'NEO') add(`The user calls me ${raw.name.trim()}`, 'assistant-name');
  if (typeof raw.tone === 'string' && raw.tone.trim() && raw.tone !== 'warm') add(`The user wants me to use a ${raw.tone.trim()} tone`, 'tone');
  if (Array.isArray(raw.traits) && raw.traits.every(trait => typeof trait === 'string')) {
    const traits = raw.traits.map(trait => (trait as string).trim()).filter(Boolean);
    if (traits.length !== DEFAULT_TRAITS.length || !DEFAULT_TRAITS.every(trait => traits.includes(trait))) {
      if (traits.length) {
        for (const trait of traits) add(`The user wants me to be ${trait}`, 'traits');
      } else add('The user does not want any preset personality traits', 'traits');
    }
  }
  if (typeof raw.language === 'string' && raw.language.trim() && raw.language !== 'auto') add(`The user wants replies in ${raw.language.trim()}`, 'language');
  // Standing instructions had the final word in the old prompt, so seed them last.
  if (typeof raw.instructions === 'string') {
    for (const instruction of splitInstructions(raw.instructions)) add(instruction, 'instructions');
  }
  return items;
}

export function storedPersona(db: NeoDatabase): unknown {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('settings') as { value: string } | undefined;
  const settings = fromJson<unknown>(row?.value, {});
  return settings && typeof settings === 'object' && !Array.isArray(settings) ? (settings as Record<string, unknown>).persona : undefined;
}

/** Keep legacy settings until every preference has reached the normal memory write path. */
export async function migratePersonaSettings(
  db: NeoDatabase, memory: MemoryService, settings: SettingsStore, persona: unknown, clock: Clock, logger: Logger = silentLogger,
): Promise<void> {
  if (db.prepare('SELECT 1 FROM memory_meta WHERE key = ?').get(PERSONA_MEMORY_MIGRATION)) return;
  for (const input of preferences(persona)) {
    const key = `${PERSONA_MEMORY_MIGRATION}:${createHash('sha256').update(input.content).digest('hex')}`;
    if (db.prepare('SELECT 1 FROM memory_meta WHERE key = ?').get(key)) continue;
    try {
      const node = await memory.remember(input);
      db.prepare('INSERT INTO memory_meta (key, value) VALUES (?, ?)').run(key, node.id);
    } catch (err) {
      if (!(err instanceof NeoError) || err.code !== 'bad_request' || !err.message.includes('NEO never stores secrets in memory')) throw err;
      logger.warn('A legacy persona preference contained credentials and was skipped.');
      db.prepare('INSERT INTO memory_meta (key, value) VALUES (?, ?)').run(key, 'skipped:credentials');
    }
  }
  db.transaction(() => {
    settings.update({});
    db.prepare('INSERT INTO memory_meta (key, value) VALUES (?, ?)').run(PERSONA_MEMORY_MIGRATION, String(clock()));
  });
}
