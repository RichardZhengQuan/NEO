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
