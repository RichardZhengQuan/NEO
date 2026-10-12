import type { ToolCallPart, ToolResultPart, ToolUseEvent } from '@neo/protocol';

const categories: Record<string, ToolUseEvent['category']> = {
  create_note: 'note', update_note: 'note', replace_note: 'note',
  create_reminder: 'reminder', update_reminder: 'reminder', snooze_reminder: 'reminder',
  create_task: 'task', update_task: 'task',
  web_search: 'search', web_fetch: 'search', remember: 'memory', forget: 'memory',
};

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

function short(value: unknown, max = 88): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function id(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
}

/** Only URLs supplied to the tool are navigable; page output is untrusted. */
function url(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) return undefined;
    return parsed.href;
  } catch { return undefined; }
}

/** Result summaries are deliberately ignored: external output may contain arbitrary instructions. */
export function describeToolUse(
  messageId: string, at: number, partIndex: number, call: ToolCallPart, result: ToolResultPart, messageSensitive = false,
): ToolUseEvent {
  const input = object(call.input);
  const output = object(result.output);
  const category = Object.hasOwn(categories, call.name) ? categories[call.name]! : 'other';
  const event: ToolUseEvent = {
    id: `tool-use:${messageId}:${partIndex}`, at, tool: call.name, category, messageId,
    title: `Used tool “${short(call.name, 80)}”`,
  };
  const quoted = (verb: string, value: unknown, fallback: string) => {
    const detail = short(value);
    return detail ? `${verb} “${detail}”` : fallback;
  };
  if (category === 'note' || category === 'reminder' || category === 'task') {
    const resource = object(output[category]);
    const resourceId = id(resource.id) ?? id(output.id);
    if (resourceId) event.target = { kind: category, id: resourceId };
    const verbs: Record<string, string> = {
      create_note: 'Wrote note', update_note: 'Updated note', replace_note: 'Replaced note',
      create_reminder: 'Set reminder', update_reminder: 'Updated reminder', snooze_reminder: 'Snoozed reminder',
      create_task: 'Created task', update_task: 'Updated task',
    };
    const verb = verbs[call.name]!;
    event.title = quoted(verb, resource.title ?? input.title, verb);
  } else if (call.name === 'web_search') {
    // Search result titles, URLs and snippets are never used in a marker.
    event.title = quoted('Searched', input.query, 'Searched the web');
  } else if (call.name === 'web_fetch') {
    const targetUrl = url(input.url);
    if (targetUrl) {
      event.target = { kind: 'url', url: targetUrl };
      const parsed = new URL(targetUrl);
      event.title = quoted('Looked up', `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`, 'Looked up a web page');
    } else event.title = 'Looked up a web page';
  } else if (call.name === 'remember') {
    const resource = Object.keys(object(output.memory)).length ? object(output.memory) : output;
    const resourceId = id(resource.id);
    if (resourceId) event.target = { kind: 'memory', id: resourceId };
    const privateWrite = messageSensitive || result.sensitive || input.sensitivity === 'sensitive' || resource.sensitivity === 'sensitive';
    event.title = privateWrite ? 'Remembered something private' : quoted('Remembered', resource.label ?? input.label, 'Remembered something');
  } else if (call.name === 'forget') {
    // Deleted memories cannot be rechecked for sensitivity, so never repeat their labels or query.
    const count = Array.isArray(output.forgotten) ? output.forgotten.length : undefined;
    event.title = count ? `Forgot ${count} ${count === 1 ? 'memory' : 'memories'}` : 'Forgot memories';
    const resourceId = id(output.id) ?? id(object(output.memory).id);
    if (resourceId) event.target = { kind: 'memory', id: resourceId };
  }
  return event;
}
