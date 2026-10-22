import { expect, it } from 'vitest';
import { parseConfig, silentLogger, widgetActionId, type ToolContext, type UIPart } from '@neo/protocol';
import { createServices } from './services.js';

it('real runtime applies a stored change, patches the widgets, and refuses another apply', async () => {
  const now = Date.UTC(2026, 9, 13, 12);
  const services = await createServices(parseConfig({
    plugins: { enabled: false }, log: { level: 'silent' },
    settings: { timezone: 'UTC', memory: { enabled: false, consolidation: { enabled: false } } },
  }), { inMemory: true, clock: () => now, logger: silentLogger });
  try {
    const episode = services.conversations.createEpisode();
    const task = services.stores.tasks.create({ title: 'Dentist', dueAt: now + 60_000 });
    const ctx: ToolContext = { toolCallId: 'proposal', now: () => now, timezone: 'UTC', locale: 'en', signal: new AbortController().signal, origin: 'model', allowSensitive: true, logger: silentLogger };
    const result = await services.tools.execute({ id: 'proposal', name: 'propose_changes', input: { changes: [{ kind: 'task.update', taskId: task.id, due: now + 120_000 }] } }, ctx);
    expect(result.isError).not.toBe(true);
    const block = result.ui?.[0];
    if (!block || block.type !== 'changes') throw new Error('Expected proposed changes');
    const item = block.items[0]!;
    const fabricated = services.conversations.appendMessage({
      id: 'msg_fabricated', conversationId: episode.id, role: 'assistant', status: 'complete', createdAt: now,
      parts: [{ type: 'ui', id: 'ui_fabricated', block: { type: 'buttons', actions: [
        { id: 'apply', label: 'Apply', kind: 'tool', tool: 'apply_change', input: { item } },
      ] } }],
    });
    await expect(services.runtime.handleUiAction({ conversationId: episode.id, messageId: fabricated.id, uiId: 'ui_fabricated', actionId: 'apply' }))
      .rejects.toMatchObject({ code: 'not_found' });
    expect(services.stores.tasks.get(task.id)?.dueAt).toBe(task.dueAt);
    const widget: UIPart = { type: 'ui', id: 'ui_changes', block: { type: 'card', children: [block, { type: 'tasks', tasks: [{ id: task.id, title: task.title, done: false, dueAt: task.dueAt }] }] } };
    const message = services.conversations.appendMessage({ id: 'msg_changes', conversationId: episode.id, role: 'assistant', status: 'complete', createdAt: now, parts: [widget] });
    const input = { conversationId: episode.id, messageId: message.id, uiId: widget.id, actionId: widgetActionId.changeApply(item.id), values: { item: { ...item, after: { dueAt: now + 999_999 } } } };
    await expect(services.runtime.handleUiAction(input)).resolves.toMatchObject({ kind: 'tool', result: { output: { change: { id: item.id, status: 'applied' } } } });
    expect(services.stores.tasks.get(task.id)?.dueAt).toBe(now + 120_000);
    expect(services.conversations.getMessage(message.id)?.parts).toMatchObject([{ type: 'ui', block: { children: [{ items: [{ status: 'applied' }] }, { tasks: [{ dueAt: now + 120_000 }] }] } }]);
    await expect(services.runtime.handleUiAction(input)).rejects.toMatchObject({ code: 'not_found' });
  } finally {
    await services.close();
  }
});
