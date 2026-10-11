import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { newId, type Message, type ToolDefinition, type UIAction, type UiActionInput } from '@neo/protocol';
import { deferred, ev, harness, settle, standardTools, until, userText } from './fakes.test-utils.js';

function fixture(def: ToolDefinition = standardTools()[1]!, actionPatch: Partial<UIAction> = {}) {
  const executed = vi.spyOn(def, 'execute');
  const h = harness({ tools: [def], settings: { agent: { autoTitle: false, confirmationTimeoutSec: 10 } } });
  const action: UIAction = { id: 'delete', label: 'Preview only', kind: 'tool', tool: def.name, input: { msg: 'private record' }, confirm: 'Harmless preview', ...actionPatch } as UIAction;
  const message: Message = {
    id: newId('msg'), conversationId: h.conv.id, role: 'assistant', status: 'complete', createdAt: h.clock(),
    parts: [{ type: 'ui', id: 'ui_delete', block: { type: 'buttons', actions: [action] } }],
  };
  h.conversations.appendMessage(message);
  const input: UiActionInput = { conversationId: h.conv.id, messageId: message.id, uiId: 'ui_delete', actionId: 'delete' };
  return { ...h, input, message, action, executed };
}

async function requestConfirmation(h: ReturnType<typeof fixture>, input = h.input) {
  const result = await h.runtime.handleUiAction(input);
  expect(result.kind).toBe('confirm');
  if (result.kind !== 'confirm') throw new Error('Expected server confirmation');
  expect(h.executed.mock.calls).toHaveLength(0);
  return result.confirmation;
}

describe('NEO-04 UI action confirmation authority', () => {
  it('uses the tool definition and validated input instead of model-written labels or confirm text', async () => {
    const def = { ...standardTools()[1]!, inputSchema: z.object({ msg: z.string().trim(), count: z.number().default(1) }),
      describeCall: (input: { msg: string; count: number }) => `Delete ${input.count} record: ${input.msg}` };
    const h = fixture(def, { input: { msg: ' private record ', extra: 'untrusted' } });
    const confirmation = await requestConfirmation(h);
    expect(confirmation).toMatchObject({ tool: def.name, title: 'Delete thing', description: 'Delete 1 record: private record', risk: 'dangerous', expiresAt: h.clock() + 10_000 });
    expect(confirmation.token).toBeTruthy();
    expect(JSON.stringify(confirmation)).not.toMatch(/Harmless preview|Preview only|untrusted/);
  });

  it('asks even when the stored tool action has no confirm text', async () => {
    const h = fixture(undefined, { confirm: undefined });
    await requestConfirmation(h);
  });

  it('asks for dangerous tools even with auto permission', async () => {
    const h = fixture();
    h.tools.setPermission('delete_thing', 'auto');
    await requestConfirmation(h);
  });

  it('asks for non-dangerous tools whose permission is confirm', async () => {
    const h = fixture({ ...standardTools()[0]!, defaultPermission: 'confirm' });
    await requestConfirmation(h);
  });

  it('keeps auto non-dangerous tools immediate', async () => {
    const h = fixture(standardTools()[0]!);
    await expect(h.runtime.handleUiAction(h.input)).resolves.toMatchObject({ kind: 'tool', result: { output: { echoed: 'private record' } } });
  });

  it('refuses denied tools before validating or executing', async () => {
    const h = fixture(undefined, { input: { invalid: true } });
    h.tools.setPermission('delete_thing', 'deny');
    await expect(h.runtime.handleUiAction(h.input)).rejects.toMatchObject({ code: 'tool_denied' });
    expect(h.executed.mock.calls).toHaveLength(0);
  });

  it('rejects invalid input before issuing a confirmation', async () => {
    const h = fixture(undefined, { input: { msg: 123 } });
    await expect(h.runtime.handleUiAction(h.input)).rejects.toMatchObject({ code: 'bad_request' });
    expect(h.executed.mock.calls).toHaveLength(0);
  });

  it.each(['missing', 'throws', 'empty'])('falls back to the tool title and compact validated JSON when describeCall is %s', async (mode) => {
    const def = { ...standardTools()[1]! };
    if (mode === 'missing') delete def.describeCall;
    else def.describeCall = () => { if (mode === 'throws') throw new Error('broken'); return '  '; };
    const h = fixture(def);
    const confirmation = await requestConfirmation(h);
    expect(confirmation.description).toBe('Delete thing: {"msg":"private record"}');
  });

  it('executes an approved token once and rejects concurrent use and replay', async () => {
    const h = fixture();
    const confirmation = await requestConfirmation(h);
    const input = { ...h.input, confirmationToken: confirmation.token };
    const results = await Promise.allSettled([h.runtime.handleUiAction(input), h.runtime.handleUiAction(input)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'fulfilled')).toMatchObject({ value: { kind: 'tool', result: { output: { deleted: 'private record' } } } });
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'conflict' } });
    expect(h.executed.mock.calls).toHaveLength(1);
    await expect(h.runtime.handleUiAction(input)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('rejects unknown tokens without executing', async () => {
    const h = fixture();
    await expect(h.runtime.handleUiAction({ ...h.input, confirmationToken: 'invented' })).rejects.toMatchObject({ code: 'conflict' });
    expect(h.executed.mock.calls).toHaveLength(0);
  });

  it.each(['conversationId', 'messageId', 'uiId', 'actionId'] as const)('rejects an approval sent with an unknown %s as a token mismatch', async field => {
    const h = fixture();
    const confirmation = await requestConfirmation(h);
    await expect(h.runtime.handleUiAction({ ...h.input, [field]: 'unknown', confirmationToken: confirmation.token })).rejects.toMatchObject({ code: 'conflict', message: expect.stringMatching(/match/i) });
    expect(h.executed.mock.calls).toHaveLength(0);
    await expect(h.runtime.handleUiAction({ ...h.input, confirmationToken: confirmation.token })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('expires tokens at the configured deadline', async () => {
    const h = fixture();
    const confirmation = await requestConfirmation(h);
    h.advance(10_000);
    await expect(h.runtime.handleUiAction({ ...h.input, confirmationToken: confirmation.token })).rejects.toMatchObject({ code: 'conflict', message: expect.stringMatching(/expired/i) });
    expect(h.executed.mock.calls).toHaveLength(0);
  });

  it.each(['conversation', 'message', 'ui', 'action', 'tool', 'validated input', 'values'])('binds approval to %s and consumes mismatched tokens', async field => {
    const h = fixture();
    const original = { ...h.input, values: { answer: 1 } };
    const confirmation = await requestConfirmation(h, original);
    let changed: UiActionInput = { ...original, confirmationToken: confirmation.token };
    let message = structuredClone(h.message);
    const block = { type: 'buttons' as const, actions: [structuredClone(h.action)] };
    if (field === 'conversation') {
      const conv = h.conversations.create();
      message = { ...message, id: newId('msg'), conversationId: conv.id };
      h.conversations.appendMessage(message);
      changed = { ...changed, conversationId: conv.id, messageId: message.id };
    } else if (field === 'message') {
      message.id = newId('msg');
      h.conversations.appendMessage(message);
      changed.messageId = message.id;
    } else if (field === 'values') changed.values = { answer: 2 };
    else {
      if (field === 'ui') changed.uiId = 'ui_other';
      if (field === 'action') { block.actions[0]!.id = 'other'; changed.actionId = 'other'; }
      if (field === 'validated input') block.actions[0] = { ...h.action, input: { msg: 'another record' } } as UIAction;
      if (field === 'tool') {
        h.tools.register({ ...standardTools()[1]!, name: 'another_delete' });
        block.actions[0] = { ...h.action, tool: 'another_delete' } as UIAction;
      }
      h.conversations.updateMessage(message.id, { parts: [{ type: 'ui', id: changed.uiId, block }] });
    }
    await expect(h.runtime.handleUiAction(changed)).rejects.toMatchObject({ code: 'conflict', message: expect.stringMatching(/match/i) });
    await expect(h.runtime.handleUiAction({ ...original, confirmationToken: confirmation.token })).rejects.toMatchObject({ code: 'conflict' });
    expect(h.executed.mock.calls).toHaveLength(0);
  });

  it('accepts equivalent form values regardless of object key order', async () => {
    const h = fixture();
    const confirmation = await requestConfirmation(h, { ...h.input, values: { a: 1, b: { x: 2, y: 3 } } });
    await expect(h.runtime.handleUiAction({ ...h.input, values: { b: { y: 3, x: 2 }, a: 1 }, confirmationToken: confirmation.token })).resolves.toMatchObject({ kind: 'tool' });
  });

  it('consumes tokens when tool execution fails', async () => {
    const h = fixture({ ...standardTools()[1]!, async execute() { throw new Error('execution failed'); } });
    const confirmation = await requestConfirmation(h);
    const input = { ...h.input, confirmationToken: confirmation.token };
    await expect(h.runtime.handleUiAction(input)).resolves.toMatchObject({ kind: 'tool', result: { isError: true } });
    await expect(h.runtime.handleUiAction(input)).rejects.toMatchObject({ code: 'conflict' });
    expect(h.executed.mock.calls).toHaveLength(1);
  });

  it('consumes tokens even when the stored message has disappeared', async () => {
    const h = fixture();
    const confirmation = await requestConfirmation(h);
    h.conversations.deleteMessage(h.message.id);
    await expect(h.runtime.handleUiAction({ ...h.input, confirmationToken: confirmation.token })).rejects.toMatchObject({ code: 'not_found' });
    h.conversations.appendMessage(h.message);
    await expect(h.runtime.handleUiAction({ ...h.input, confirmationToken: confirmation.token })).rejects.toMatchObject({ code: 'conflict' });
    expect(h.executed.mock.calls).toHaveLength(0);
  });
});

describe('NEO-15 permission revocation in runtime', () => {
  it('denies and consumes UI approval after the tool permission changes to deny', async () => {
    const h = fixture();
    const confirmation = await requestConfirmation(h);
    h.settings.update({ tools: { permissions: { delete_thing: 'deny' } } });
    const input = { ...h.input, confirmationToken: confirmation.token };
    await expect(h.runtime.handleUiAction(input)).rejects.toMatchObject({ code: 'tool_denied' });
    h.settings.update({ tools: { permissions: { delete_thing: 'confirm' } } });
    await expect(h.runtime.handleUiAction(input)).rejects.toMatchObject({ code: 'conflict' });
    expect(h.executed.mock.calls).toHaveLength(0);
  });

  it('rechecks permission after asynchronous UI input validation', async () => {
    const gate = deferred();
    let entered = false;
    const h = fixture({ ...standardTools()[1]!, inputSchema: z.object({ msg: z.string() }).refine(async () => { entered = true; await gate.promise; return true; }) });
    const pending = h.runtime.handleUiAction(h.input);
    await until(() => entered);
    h.tools.setPermission('delete_thing', 'deny');
    gate.resolve();
    await expect(pending).rejects.toMatchObject({ code: 'tool_denied' });
    expect(h.executed.mock.calls).toHaveLength(0);
  });

  it('cancels pending tool confirmations immediately when settings deny the tool', async () => {
    const h = harness({ settings: { agent: { autoTitle: false } } });
    h.model.script([ev.call('provider_call', 'delete_thing', { msg: 'x' }), ev.done('tool_use')], [ev.text('Done'), ev.done()]);
    const turn = await h.runtime.send({ conversationId: h.conv.id, parts: userText('delete') });
    try {
      await until(() => h.runtime.pendingConfirmations().length === 1);
      const confirmation = h.runtime.pendingConfirmations()[0]!;
      h.settings.update({ tools: { permissions: { delete_thing: 'deny' } } });
      expect(h.runtime.pendingConfirmations()).toEqual([]);
      expect(h.runtime.confirm(confirmation.id, { approve: true })).toBe(false);
      await settle();
      expect(h.events).toContainEqual(expect.objectContaining({ type: 'tool.confirmation_resolved', approved: false, reason: 'cancelled' }));
      const message = await turn.done;
      expect(message.parts).toContainEqual(expect.objectContaining({ type: 'tool_result', isError: true, summary: 'Cancelled' }));
      expect(h.tools.executed).toHaveLength(0);
    } finally { h.runtime.cancel(turn.turnId); }
  });
});
