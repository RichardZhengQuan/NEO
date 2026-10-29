import { describe, expect, it } from 'vitest';
import { silentLogger, type ChangesBlock, type ToolContext } from '@neo/protocol';
import { renderUiTool } from './render_ui.js';

const context: ToolContext = {
  toolCallId: 'tc_ui', signal: new AbortController().signal, now: () => 0,
  timezone: 'UTC', locale: 'en-US', origin: 'model', allowSensitive: false, logger: silentLogger,
};
const changes: ChangesBlock = {
  type: 'changes', items: [{ id: 'chg_task', kind: 'task.update', taskId: 'task_one', title: 'Dentist', before: { done: false }, after: { done: true } }],
};

describe('render_ui tool-only widgets', () => {
  it.each([changes, { type: 'card', children: [{ type: 'tabs', tabs: [{ id: 'review', label: 'Review', children: [changes] }] }] }])(
    'rejects changes blocks, including nested ones', async (block) => {
      const result = await renderUiTool.execute({ blocks: [block] }, context);
      expect(result).toMatchObject({ isError: true, summary: 'Invalid UI', output: { error: expect.stringMatching(/changes blocks come from propose_changes/) } });
      expect(result.ui).toBeUndefined();
    },
  );
});

it('exposes supported presentation props in the compact catalogue', () => {
  const description = renderUiTool.description;
  expect(description).toMatch(/- list:.*imageUrl\?/);
  expect(description).toMatch(/- image:.*aspectRatio\?/);
  expect(description).toMatch(/- form:.*placeholder\?.*help\?.*min\?.*max\?.*step\?/);
  expect(description).toMatch(/- reminder:.*notes\?.*timezone\?.*recurrenceText\?/);
  expect(description).toMatch(/- countdown:.*timezone\?/);
  expect(description).toMatch(/- timeline:.*timezone\?/);
  expect(description).toMatch(/- table:.*currency\?.*USD default/);
  expect(description).toMatch(/- memory:.*content\?.*recall with show:true/);
  expect(description).toContain('images: http(s)');
  expect(description.length).toBeLessThan(4000);
});


it('preserves an explicit timeline timezone and keeps old blocks unstamped', async () => {
  const legacy = { type: 'timeline', items: [{ time: 0, title: 'Epoch' }] };
  const explicit = { ...legacy, timezone: 'America/New_York' };
  const result = await renderUiTool.execute({ blocks: [legacy, explicit] }, context);
  expect(result.ui).toEqual([legacy, explicit]);
  expect(result.output).toMatchObject({ shown: true, text: expect.stringContaining('Dec 31, 1969, 7:00 PM') });
});
