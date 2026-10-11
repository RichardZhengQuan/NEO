/**
 * render_ui: the model shows native UI blocks. The input schema is
 * deliberately loose (the full recursive union would bloat every request);
 * blocks are validated with validateUIBlocks and errors go back to the model.
 * The description carries a compact catalogue built from UI_BLOCK_TYPES.
 */
import { z } from 'zod';
import { MAX_UI_DEPTH, UI_BLOCK_TYPES, defineTool, uiBlocksToText, validateUIBlocks, type UIBlockType } from '@neo/protocol';

/** Key props per block type ("?" = optional). Kept in sync with UI_BLOCK_TYPES by the type checker. */
const BLOCK_PROPS: Record<UIBlockType, string> = {
  text: 'text (Markdown)',
  heading: 'text, level? 1-3',
  card: 'title?, subtitle?, icon?, imageUrl?, tone?, children?[], actions?[], footer?',
  list: 'title?, ordered?, items[{id, title, subtitle?, icon?, meta?, badge?, tone?, action?}]',
  table: 'caption?, columns[{key, label, align?, format?: text|number|currency|percent|date}], rows[{<key>: value}]',
  chart: 'kind: bar|line|area|pie|donut, series[{name, data[{x, y}]}], title?, xLabel?, yLabel?, unit?, stacked?',
  stat: 'label, value, unit?, delta?, deltaLabel?, caption?, tone?, icon?',
  progress: 'value 0-1, label?, caption?, tone?',
  form: 'fields[{name, label, kind: text|textarea|number|email|url|select|multiselect|checkbox|switch|date|time|datetime|slider, required?, options?[{value, label}], defaultValue?}], title?, description?, submitLabel?',
  buttons: 'actions[], layout?: row|column',
  image: 'url, alt, caption?',
  gallery: 'images[{url, alt, caption?}]',
  callout: 'tone, text, title?, icon?',
  code: 'code, language?, filename?',
  quote: 'text, cite?',
  divider: 'label?',
  grid: 'columns 1-4, children[]',
  stack: 'children[], direction?: vertical|horizontal, gap?: sm|md|lg',
  tabs: 'tabs[{id, label, children[]}]',
  accordion: 'items[{id, title, open?, children[]}]',
  link: 'url, title, description?, imageUrl?, siteName?',
  timeline: 'items[{time (epoch ms or text), title, description?, icon?, tone?}], title?',
  keyvalue: 'items[{key, value}], title?',
  tags: 'items[{label, tone?, icon?}]',
  countdown: 'label, until (epoch ms), doneText?',
  reminder: 'reminderId, title, dueAt, status (prefer create_reminder, which adds it)',
  tasks: 'tasks[{id, title, done}], title?, listId? (prefer list_tasks)',
  memory: 'nodes[{id, kind, label, status?}] (prefer remember/recall)',
};

const CATALOGUE = UI_BLOCK_TYPES.map((type) => `- ${type}: ${BLOCK_PROPS[type]}`).join('\n');

const DESCRIPTION = `Show rich, native UI to the user instead of (or next to) plain text: tables for comparisons, charts for numbers over time, stats, timelines for plans, forms to collect details, buttons for choices, cards, lists, galleries and more. Each block is a JSON object with a "type". After calling it, don't repeat the content in prose; one sentence is enough.
Blocks (key props):
${CATALOGUE}
Common values: tone = neutral|accent|info|success|warning|danger; icon = a lucide name ("calendar", "map-pin") or one emoji; URLs must be https (images may also be data:image/png|jpeg|gif|webp|avif;base64).
Actions (buttons.actions, card.actions, list item action): {id (unique), label, kind, ...} with kind "message" + text (sent as the user's reply), "event" + payload?, "link" + url, "copy" + text; optional style: primary|secondary|ghost|danger and confirm (question shown first).
Limits: 1-20 blocks per call, nesting depth ${MAX_UI_DEPTH}. Invalid blocks return an error explaining what to fix.`;

export const renderUiTool = defineTool({
  name: 'render_ui',
  title: 'Show UI',
  description: DESCRIPTION,
  inputSchema: z.object({
    blocks: z.array(z.record(z.string(), z.unknown())).min(1).max(20).describe('UI blocks, each an object with a "type".'),
  }),
  risk: 'read',
  defaultPermission: 'auto',
  async execute(input) {
    const result = validateUIBlocks(input.blocks);
    if (!result.ok) {
      return { isError: true, output: { error: `The UI blocks are invalid, nothing was shown. Fix and retry:\n${result.error}` }, summary: 'Invalid UI' };
    }
    const types = [...new Set(result.blocks.map((b) => b.type))].join(', ');
    return {
      output: { shown: true, text: uiBlocksToText(result.blocks).slice(0, 1000) },
      ui: result.blocks,
      summary: `Showed ${types}`,
    };
  },
});
