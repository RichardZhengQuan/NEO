/** Security regressions for stored memory context and tool approval races. Runs offline. */
import { describe, expect, it } from 'vitest';
import { SENSITIVE_CONTEXT_PLACEHOLDER, type ContentPart, type Message, type ToolConfirmation } from '@neo/protocol';

import { ConfirmationManager } from './confirmations.js';
import { EPOCH, ScriptedAdapter, deferred, ev, harness, memoryNode, recalled, runTurn, until } from './fakes.test-utils.js';

const SECRET = 'The private vault code is orchid-729.';

const resultFor = (message: Message, id: string) =>
  message.parts.find((part): part is Extract<ContentPart, { type: 'tool_result' }> => part.type === 'tool_result' && part.toolCallId === id);

function sensitiveMemory() {
  return recalled({ ...memoryNode('mem_private', SECRET), sensitivity: 'sensitive' });
}

describe('sensitive historical memory context', () => {
  it('withholds locally recalled sensitive context after switching the conversation to a cloud model', async () => {
    const local = new ScriptedAdapter({ id: 'local', isLocal: true });
    const cloud = new ScriptedAdapter({ id: 'cloud', isLocal: false });
    const h = harness({ adapters: [local, cloud], settings: { agent: { autoTitle: false } } });
    h.memory.recallItems = [sensitiveMemory()];
    const first = await runTurn(h, 'What do you remember?');
    expect(JSON.stringify(local.requests[0]!.messages)).toContain(SECRET);

    h.memory.recallItems = [];
    h.conversations.update(h.conv.id, { model: { provider: cloud.id, model: 'cloud-model' } });
    await runTurn(h, 'Continue using another model');

    expect(JSON.stringify(cloud.requests[0]!.messages)).not.toContain(SECRET);
    expect(JSON.stringify(cloud.requests[0]!.messages)).toContain(SENSITIVE_CONTEXT_PLACEHOLDER);
    expect(first.handle.userMessage.parts[0]).toMatchObject({ type: 'context', sensitive: true });
    expect(h.conversations.getMessage(first.handle.userMessage.id)!.parts[0]).toMatchObject({ sensitive: true, text: expect.stringContaining(SECRET) });
  });

  it.each([
    { destination: 'local', isLocal: true, sendSensitiveToCloud: false },
    { destination: 'cloud with explicit opt-in', isLocal: false, sendSensitiveToCloud: true },
  ])('retains sensitive history for $destination', async ({ isLocal, sendSensitiveToCloud }) => {
    const local = new ScriptedAdapter({ id: 'source', isLocal: true });
    const destination = new ScriptedAdapter({ id: 'destination', isLocal });
    const h = harness({ adapters: [local, destination], settings: { agent: { autoTitle: false } } });
    h.memory.recallItems = [sensitiveMemory()];
    await runTurn(h, 'Recall my private memory');
    h.memory.recallItems = [];
    h.settings.update({ memory: { sendSensitiveToCloud } });
    h.conversations.update(h.conv.id, { model: { provider: destination.id, model: 'destination-model' } });
    await runTurn(h, 'Continue');

    expect(JSON.stringify(destination.requests[0]!.messages)).toContain(SECRET);
    expect(JSON.stringify(destination.requests[0]!.messages)).not.toContain(SENSITIVE_CONTEXT_PLACEHOLDER);
  });

  it('rechecks sensitive sharing for every provider request when cloud sharing is revoked between steps', async () => {
    const h = harness({ settings: { agent: { autoTitle: false }, memory: { sendSensitiveToCloud: true } } });
    h.memory.recallItems = [sensitiveMemory()];
    h.model.script([ev.call('echo_call', 'echo', { msg: 'hello' }), ev.done('tool_use')], [ev.text('Finished'), ev.done()]);
    h.runtime.subscribe((event) => {
      if (event.type === 'tool.finished') h.settings.update({ memory: { sendSensitiveToCloud: false } });
    });
    await runTurn(h, 'Recall and echo');

    expect(JSON.stringify(h.model.requests[0]!.messages)).toContain(SECRET);
    expect(JSON.stringify(h.model.requests[1]!.messages)).not.toContain(SECRET);
    expect(JSON.stringify(h.model.requests[1]!.messages)).toContain(SENSITIVE_CONTEXT_PLACEHOLDER);
  });

  it('does not pass sensitive context parts into automatic title requests', async () => {
    const h = harness({ adapters: [new ScriptedAdapter({ isLocal: true })] });
    h.memory.recallItems = [sensitiveMemory()];
    await runTurn(h, 'Help me make a plan');
    await until(() => h.model.titleRequests.length === 1);

    expect(JSON.stringify(h.model.requests[0]!.messages)).toContain(SECRET);
    expect(JSON.stringify(h.model.titleRequests[0]!.messages)).not.toContain(SECRET);
  });
});

describe('permission revocation after tool approval', () => {
  it.each([false, true])('declines an approved call when permission is revoked before execution (always=%s)', async (always) => {
    const h = harness({ settings: { agent: { autoTitle: false } } });
    h.model.script([ev.call('delete_call', 'delete_thing', { msg: 'Groceries' }), ev.done('tool_use')]);
    h.runtime.subscribe((event) => {
      if (event.type === 'tool.confirmation') h.runtime.confirm(event.confirmation.id, { approve: true, always });
      if (event.type === 'tool.confirmation_resolved') h.tools.setPermission('delete_thing', 'deny');
    });
    const turn = await runTurn(h, 'Delete groceries');

    expect(h.tools.executed).toEqual([]);
    expect(turn.events.some((event) => event.type === 'tool.started')).toBe(false);
    expect(resultFor(turn.message, 'delete_call')).toMatchObject({ isError: true, summary: 'Declined', output: { error: 'The user declined this action.' } });
    expect(h.tools.permissionFor('delete_thing')).toBe('deny');
    expect(h.settings.get().tools.permissions.delete_thing).not.toBe('auto');
  });

  it('preserves a deny written synchronously while persisting an always approval', async () => {
    const h = harness({ settings: { agent: { autoTitle: false } } });
    h.settings.onChange((settings) => {
      if (settings.tools.permissions.delete_thing === 'auto') h.settings.update({ tools: { permissions: { delete_thing: 'deny' } } });
    });
    h.model.script([ev.call('delete_always_call', 'delete_thing', { msg: 'Groceries' }), ev.done('tool_use')]);
    h.runtime.subscribe((event) => {
      if (event.type === 'tool.confirmation') h.runtime.confirm(event.confirmation.id, { approve: true, always: true });
    });
    const turn = await runTurn(h, 'Delete groceries');

    expect(h.tools.permissionFor('delete_thing')).toBe('deny');
    expect(h.settings.get().tools.permissions.delete_thing).toBe('deny');
    expect(h.tools.executed).toEqual([]);
    expect(resultFor(turn.message, 'delete_always_call')).toMatchObject({ isError: true, summary: 'Declined' });
  });

  it.each(['confirm', 'auto'] as const)('cancels execution if %s permission becomes deny during asynchronous input validation', async (permission) => {
    const h = harness({ settings: { agent: { autoTitle: false } } });
    h.settings.update({ tools: { permissions: { delete_thing: permission } } });
    const def = h.tools.get('delete_thing')!;
    const parsing = deferred();
    const validationGate = deferred();
    const executionSettled = deferred();
    const parse = def.inputSchema.safeParseAsync.bind(def.inputSchema);
    def.inputSchema.safeParseAsync = async (input) => {
      parsing.resolve();
      await validationGate.promise;
      return parse(input);
    };
    // Match the real registry's asynchronous validation and post-validation
    // cancellation check; FakeTools normally validates synchronously.
    h.tools.execute = async (call, ctx) => {
      try {
        const parsed = await def.inputSchema.safeParseAsync(call.input);
        if (!parsed.success) return { isError: true, output: { error: 'Invalid input' } };
        if (ctx.signal.aborted) return { isError: true, output: { error: 'The operation was cancelled.', code: 'cancelled' } };
        h.tools.executed.push({ name: call.name, input: parsed.data, ctx });
        return await def.execute(parsed.data, ctx);
      } finally {
        executionSettled.resolve();
      }
    };
    h.model.script([ev.call('delete_async_call', 'delete_thing', { msg: 'Groceries' }), ev.done('tool_use')]);
    h.runtime.subscribe((event) => {
      if (event.type === 'tool.confirmation') h.runtime.confirm(event.confirmation.id, { approve: true });
    });
    const turnPromise = runTurn(h, 'Delete groceries');
    try {
      await parsing.promise;
      h.settings.update({ tools: { permissions: { delete_thing: 'deny' } } });
      validationGate.resolve();
      const turn = await turnPromise;
      await executionSettled.promise;

      expect(h.tools.executed).toEqual([]);
      expect(resultFor(turn.message, 'delete_async_call')).toMatchObject({
        isError: true,
        summary: 'Declined',
        output: { error: 'The user declined this action.' },
      });
      expect(h.tools.permissionFor('delete_thing')).toBe('deny');
    } finally {
      validationGate.resolve();
    }
  });
});

describe('tool-specific confirmation cancellation', () => {
  it('cancels only pending confirmations for the denied tool across turns', async () => {
    const manager = new ConfirmationManager();
    const signal = new AbortController().signal;
    const confirmation = (id: string, name: string, turnId: string): ToolConfirmation => ({
      id,
      name,
      turnId,
      conversationId: 'conv_test',
      messageId: 'msg_test',
      toolCallId: `call_${id}`,
      title: name,
      input: {},
      description: name,
      risk: 'dangerous',
      requestedAt: EPOCH,
      expiresAt: EPOCH + 60_000,
    });
    const first = manager.waitForDecision(confirmation('cnf_first', 'delete_thing', 'turn_first'), 60_000, signal);
    const second = manager.waitForDecision(confirmation('cnf_second', 'delete_thing', 'turn_second'), 60_000, signal);
    const other = manager.waitForDecision(confirmation('cnf_other', 'other_tool', 'turn_other'), 60_000, signal);
    try {
      expect(manager.cancelTool('delete_thing')).toBe(2);
      await expect(first).resolves.toEqual({ approve: false, reason: 'cancelled' });
      await expect(second).resolves.toEqual({ approve: false, reason: 'cancelled' });
      expect(manager.list().map((item) => item.id)).toEqual(['cnf_other']);
      expect(manager.resolve('cnf_first', { approve: true })).toBe(false);
      expect(manager.cancelTool('delete_thing')).toBe(0);
      expect(manager.resolve('cnf_other', { approve: true })).toBe(true);
      await expect(other).resolves.toEqual({ approve: true, reason: 'user' });
    } finally {
      manager.cancelAll();
    }
  });
});
