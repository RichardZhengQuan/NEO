/**
 * The consolidation journal ("dream journal") and forgetting.
 *
 * Journal lines can name memories ("Learned: The user has lupus (from 2
 * conversations)"). Each such line is stored with the ids of the memories it
 * names (`noteRefs`, kept next to the report in the database and never returned
 * by journal()). Forgetting a memory rewrites the lines that name it into a
 * neutral form, so its text does not outlive it; the report's counts stay.
 */
import type { ConsolidationReport } from '@neo/protocol';
import type { NeoDatabase } from '@neo/storage';

/** note index → ids of the memories that line names. */
const REFS = new WeakMap<ConsolidationReport, Map<number, string[]>>();

/** Add a journal line that names the memories `ids`. */
export function addNote(report: ConsolidationReport, line: string, ids: readonly string[] = []): void {
  const index = report.notes.push(line) - 1;
  if (!ids.length) return;
  let refs = REFS.get(report);
  if (!refs) {
    refs = new Map();
    REFS.set(report, refs);
  }
  refs.set(index, [...new Set(ids)]);
}

/** The JSON stored in memory_journal: the report plus its line references. */
export function journalJson(report: ConsolidationReport): string {
  const refs = REFS.get(report);
  return JSON.stringify(refs?.size ? { ...report, noteRefs: Object.fromEntries([...refs].map(([i, ids]) => [String(i), ids])) } : report);
}

/** A stored journal row as the public report (line references removed). */
export function parseJournal(json: string): ConsolidationReport {
  const { noteRefs: _refs, ...report } = JSON.parse(json) as ConsolidationReport & { noteRefs?: unknown };
  return report;
}

/** A line naming a forgotten memory, rewritten without its text (counts are kept). */
function redacted(line: string): string {
  const archived = /^(Archived \d+ (?:faded|expired) memor(?:y|ies))\b/.exec(line);
  if (archived) return `${archived[1]} (one of them was later forgotten)`;
  const learned = /\((from \d+ conversations?)\)\s*$/.exec(line);
  if (/^Learned: /.test(line)) return `Learned something you later asked me to forget${learned ? ` (${learned[1]})` : ''}`;
  if (/^Merged /.test(line)) return 'Merged two entries about something you later asked me to forget';
  return 'A note about a memory you later asked me to forget was removed';
}

/** Lines of the kinds that quote memory labels (for reports written before line references existed). */
const QUOTING_LINE = /^(?:Archived \d+ |Learned: |Merged ')/;

/**
 * Rewrite every journal line that names one of the forgotten memories: by its
 * stored references, or, for older reports without references, by its label.
 * Runs inside the caller's transaction. Returns the number of reports rewritten.
 */
export function redactJournal(db: NeoDatabase, forgotten: readonly { id: string; label: string }[]): number {
  if (!forgotten.length) return 0;
  const ids = new Set(forgotten.map((f) => f.id));
  // quoteExamples() clips labels longer than 60 chars to 59 + "…".
  const labels = forgotten.map((f) => (f.label.length > 60 ? f.label.slice(0, 59) : f.label)).filter((l) => l.trim().length >= 3);
  const rows = db.prepare('SELECT id, report FROM memory_journal').all() as { id: string; report: string }[];
  const update = db.prepare('UPDATE memory_journal SET report = ? WHERE id = ?');
  let rewritten = 0;
  for (const row of rows) {
    let stored: ConsolidationReport & { noteRefs?: Record<string, unknown> };
    try {
      stored = JSON.parse(row.report) as typeof stored;
    } catch {
      continue;
    }
    if (!Array.isArray(stored.notes)) continue;
    const refs = stored.noteRefs && typeof stored.noteRefs === 'object' ? stored.noteRefs : null;
    let changed = false;
    stored.notes = stored.notes.map((line, i) => {
      if (typeof line !== 'string') return line;
      const named = refs?.[String(i)];
      const hit = refs
        ? Array.isArray(named) && named.some((id) => typeof id === 'string' && ids.has(id))
        : QUOTING_LINE.test(line) && labels.some((l) => line.includes(l));
      if (!hit) return line;
      changed = true;
      if (refs) delete refs[String(i)];
      return redacted(line);
    });
    if (!changed) continue;
    rewritten++;
    update.run(JSON.stringify(stored), row.id);
  }
  return rewritten;
}
