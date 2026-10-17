import { describe, expect, it } from 'vitest';
import { AgentRuntime } from './runtime.js';
import { z } from 'zod';
import { estimateMessageTokens, type ContentPart, type Message, type ToolDefinition } from '@neo/protocol';
import { collect, deferred, ev, harness, memoryNode, recalled, ScriptedAdapter, settle, standardTools, until, userText, waitsForAbort, type Harness } from './fakes.test-utils.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

async function send(h: Harness, text: string, offRecord = false) {
  const handle = await h.runtime.sendTimeline({ parts: userText(text), offRecord });
  const events = await collect(handle);
  const message = await handle.done;
  return { handle, events, message };
}

function recent(parts: ContentPart[]): string | undefined {
  return parts.find((part) => part.type === 'context' && part.text.includes('Quoted recent conversation'))?.type === 'context'
    ? parts.filter((part) => part.type === 'context').map((part) => part.text).find((text) => text.includes('Quoted recent conversation'))
    : undefined;
}

function stored(h: Harness, episodeId: string, text: string, createdAt = h.clock(), sensitive = false): Message {
  return h.conversations.appendMessage({ id: `msg_fixture_${h.conversations.writes}`, conversationId: episodeId, role: 'assistant', parts: userText(text), status: 'complete', createdAt, ...(sensitive ? { sensitive: true } : {}) });
}

describe('timeline episode selection', () => {
  it('starts an episode, emits its public boundary and puts episodeId on every turn event', async () => {
    const h = harness();
    h.conversations.delete(h.conv.id);
    const first = await send(h, 'hello');
    const episode = h.conversations.get(first.handle.episodeId)!;
    expect(first.handle.conversationId).toBe(episode.id);
    expect(h.events[0]).toMatchObject({ type: 'episode.started', episodeId: episode.id, episode: { id: episode.id, offRecord: false } });
    expect(h.events[0]).not.toHaveProperty('episode.pinned');
    expect(h.events[0]).not.toHaveProperty('episode.model');
    expect(first.events.every((event) => 'episodeId' in event && event.episodeId === episode.id)).toBe(true);
    const second = await send(h, 'still here');
    expect(second.handle.episodeId).toBe(episode.id);
    expect(h.events.filter((event) => event.type === 'episode.started')).toHaveLength(1);
  });

  it('breaks at the default 60-minute gap and reuses the episode immediately below it', async () => {
    const h = harness();
    const first = await send(h, 'one');
    h.advance(60 * MINUTE - 1);
    const second = await send(h, 'two');
    expect(second.handle.episodeId).toBe(first.handle.episodeId);
    h.advance(60 * MINUTE);
    const third = await send(h, 'three');
    expect(third.handle.episodeId).not.toBe(first.handle.episodeId);
    expect(h.conversations.get(first.handle.episodeId)!.closedAt).not.toBeNull();
  });

  it('uses the configurable gap in minutes', async () => {
    const h = harness({ settings: { timeline: { episodeGapMinutes: 5 } } });
    const first = await send(h, 'one');
    h.advance(5 * MINUTE);
    expect((await send(h, 'two')).handle.episodeId).not.toBe(first.handle.episodeId);
  });

  it('breaks when history plus the persisted incoming context exceeds the token budget', async () => {
    const h = harness({ settings: { agent: { contextTokenBudget: 2000 } } });
    const first = await send(h, 'one');
    stored(h, first.handle.episodeId, 'x'.repeat(7500));
    const history = h.conversations.messages(first.handle.episodeId);
    const historyTokens = history.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
    expect(historyTokens).toBeLessThan(2000);
    h.memory.recallItems = [recalled(memoryNode('mem_recalled', 'r'.repeat(1000)))];
    const second = await send(h, 'two');
    expect(second.handle.episodeId).not.toBe(first.handle.episodeId);
    expect(second.handle.userMessage.parts.filter((part) => part.type === 'context')).toHaveLength(2);
    expect(h.memory.recallCalls).toHaveLength(3);
    expect(h.memory.recallCalls[1]).toMatchObject({ conversationId: first.handle.episodeId, reinforce: false });
    expect(h.memory.recallCalls[2]).toMatchObject({ conversationId: second.handle.episodeId });
    expect(h.memory.recallCalls[2]).not.toHaveProperty('reinforce', false);
    expect(h.conversations.messages(first.handle.episodeId)).toEqual(history);
  });

  it('starts a new episode after the user deletes one of its messages', async () => {
    const h = harness();
    const first = await send(h, 'message to delete');
    h.conversations.deleteMessage(first.handle.userMessage.id);
    const second = await send(h, 'continue');
    expect(second.handle.episodeId).not.toBe(first.handle.episodeId);
    expect(recent(second.handle.userMessage.parts)).not.toContain('message to delete');
  });

  it('conflicts before any transcript writes when another timeline send is recalling', async () => {
    const h = harness();
    const gate = deferred();
    h.memory.recallGate = gate.promise;
    const pending = h.runtime.sendTimeline({ parts: userText('one') });
    await expect(h.runtime.sendTimeline({ parts: userText('two') })).rejects.toMatchObject({ code: 'conflict' });
    expect(h.conversations.messages(h.conv.id)).toEqual([]);
    gate.resolve();
    await (await pending).done;
  });

  it('cancels preflight recall without persisting either message', async () => {
    const h = harness();
    h.conversations.delete(h.conv.id);
    const gate = deferred();
    h.memory.recallGate = gate.promise;
    const pending = h.runtime.sendTimeline({ parts: userText('cancel this') });
    const failed = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(h.runtime.cancelTimeline()).toBe(true);
    gate.resolve();
    await failed;
    await h.runtime.waitForIdle();
    expect(h.conversations.list()).toEqual([]);
  });
});

describe('episode continuity', () => {
  it('keeps quoted continuity within the remaining budget by dropping whole older messages', async () => {
    const h = harness({ settings: { agent: { contextTokenBudget: 2000 } } });
    await send(h, 'ordinary');
    stored(h, h.conv.id, 'very large old answer '.repeat(1000), h.clock() + 2);
    stored(h, h.conv.id, 'brief latest answer', h.clock() + 3);
    h.advance(HOUR + 3);
    const next = await send(h, 'continue');
    expect(recent(next.handle.userMessage.parts)).toContain('brief latest answer');
    expect(recent(next.handle.userMessage.parts)).not.toContain('very large old answer');
    expect(estimateMessageTokens(next.handle.userMessage)).toBeLessThanOrEqual(2000);
  });

  it('quotes only the last six visible messages, with their timestamps, exactly once', async () => {
    const h = harness();
    for (let index = 0; index < 4; index++) {
      h.model.script([ev.text(`answer ${index}`), ev.done()]);
      await send(h, `question ${index}`);
      h.advance(1);
    }
    const previous = h.conversations.messages(h.conv.id);
    h.advance(HOUR);
    const next = await send(h, 'new episode');
    const context = recent(next.handle.userMessage.parts)!;
    expect(context).toContain('<neo_context>');
    expect(context).not.toContain('question 0');
    expect(context).not.toContain('answer 0');
    for (const message of previous.slice(-6)) {
      expect(context).toContain(new Date(message.createdAt).toISOString());
      expect(context).toContain(message.role);
      expect(context).toContain(message.parts.filter((part) => part.type === 'text').map((part) => part.text).join(''));
    }
    const snapshot = JSON.stringify(next.handle.userMessage.parts);
    const request = h.model.requests.at(-1)!;
    expect(request.system).not.toContain('question 3');
    await send(h, 'another turn');
    expect(recent(h.conversations.messages(next.handle.episodeId).at(-2)!.parts)).toBeUndefined();
    expect(JSON.stringify(h.conversations.getMessage(next.handle.userMessage.id)!.parts)).toBe(snapshot);
    expect(h.model.requests.at(-1)!.messages[0]).toEqual(request.messages[0]);
  });

  it.each([24 * HOUR - 1, 24 * HOUR, 25 * HOUR])('carries continuity only below 24 hours (%i ms)', async (gap) => {
    const h = harness();
    await send(h, 'remember our recent chat');
    h.advance(gap);
    const next = await send(h, 'continue');
    expect(recent(next.handle.userMessage.parts) !== undefined).toBe(gap < 24 * HOUR);
  });

  it('excludes private-derived messages from cloud continuity when sensitive sharing is off', async () => {
    const h = harness();
    await send(h, 'ordinary');
    stored(h, h.conv.id, 'private derived secret', h.clock() + 2, true);
    h.advance(HOUR + 2);
    const next = await send(h, 'continue');
    expect(recent(next.handle.userMessage.parts)).toContain('ordinary');
    expect(JSON.stringify(h.model.requests.at(-1)!.messages)).not.toContain('private derived secret');
  });

  it('flags sensitive continuity so switching to cloud later withholds it without rewriting storage', async () => {
    const local = new ScriptedAdapter({ id: 'local', isLocal: true });
    const cloud = new ScriptedAdapter({ id: 'cloud' });
    const h = harness({ adapters: [local, cloud] });
    await send(h, 'ordinary');
    stored(h, h.conv.id, 'private derived secret', h.clock() + 2, true);
    h.advance(HOUR + 2);
    const next = await send(h, 'continue locally');
    const snapshot = JSON.stringify(next.handle.userMessage.parts);
    expect(next.handle.userMessage.parts.find((part) => part.type === 'context' && part.text.includes('Quoted recent'))).toMatchObject({ sensitive: true });
    expect(JSON.stringify(h.model.requests.at(-1)!.messages)).toContain('private derived secret');
    h.settings.update({ ai: { capabilities: { text: { provider: 'cloud', model: 'cloud-model' } } } });
    await send(h, 'now in cloud');
    expect(JSON.stringify(cloud.requests.at(-1)!.messages)).not.toContain('private derived secret');
    expect(JSON.stringify(h.conversations.getMessage(next.handle.userMessage.id)!.parts)).toBe(snapshot);
  });
});

describe('off-record lifecycle', () => {
  it('carries the sensitive flag onto the public prefix when going off-record mid-stream', async () => {
    const local = new ScriptedAdapter({ id: 'local', isLocal: true });
    const cloud = new ScriptedAdapter({ id: 'cloud' });
    const h = harness({ adapters: [local, cloud] });
    stored(h, h.conv.id, 'orchid memory', h.clock() - HOUR, true);

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    local.script(async function* () {
      yield ev.text('The code is orchid-729');
      await gate;
      yield ev.done();
    });

    let seenDelta!: () => void;
    const sawDelta = new Promise<void>((r) => { seenDelta = r; });
    const off = h.runtime.subscribe((e) => { if (e.type === 'text.delta') seenDelta(); });
    const handle = await h.runtime.sendTimeline({ parts: userText('what is the code?') });
    const originalEpisodeId = handle.episodeId;
    const originalMessageId = handle.assistantMessageId;
    await sawDelta;
    off();

    await h.runtime.startOffRecord();
    release();
    await handle.done;

    const persisted = h.conversations.getMessage(originalMessageId);
    expect(persisted).not.toBeNull();
    expect(persisted!.conversationId).toBe(originalEpisodeId);
    expect.soft(persisted!.sensitive).toBe(true);

    await h.runtime.endOffRecord();
    h.advance(HOUR + 2);
    h.settings.update({ ai: { capabilities: { text: { provider: 'cloud', model: 'cloud-model' } } } });
    await send(h, 'now what did I say earlier?');
    expect(JSON.stringify(cloud.requests.at(-1)!.messages)).not.toContain('orchid-729');
  });

  it('breaks on each toggle, allows recall without reinforcement, skips observation and deletes ephemeral history on exit', async () => {
    const h = harness();
    const normal = await send(h, 'normal context');
    const off = await send(h, 'off-record secret', true);
    expect(off.handle.episodeId).not.toBe(normal.handle.episodeId);
    expect(h.conversations.get(off.handle.episodeId)).toMatchObject({ offRecord: true, ephemeral: true });
    expect(recent(off.handle.userMessage.parts)).toContain('normal context');
    expect(h.memory.recallCalls.at(-1)).toMatchObject({ reinforce: false });
    await settle();
    expect(h.memory.observeCalls).toHaveLength(1);
    await h.runtime.endOffRecord();
    const next = await send(h, 'back to normal');
    expect(next.handle.episodeId).not.toBe(normal.handle.episodeId);
    expect(next.handle.episodeId).not.toBe(off.handle.episodeId);
    expect(h.conversations.get(off.handle.episodeId)).toBeNull();
    expect(h.conversations.getMessage(off.handle.userMessage.id)).toBeNull();
    expect(h.events).toContainEqual({ type: 'conversation.deleted', conversationId: off.handle.episodeId, episodeId: off.handle.episodeId });
    expect(JSON.stringify(next.handle.userMessage.parts)).not.toContain('off-record secret');
    expect(h.conversations.get(normal.handle.episodeId)).not.toBeNull();
    await settle();
    expect(h.memory.observeCalls).toHaveLength(2);
  });

  it('removes every ephemeral off-record episode on exit, including an automatic gap break', async () => {
    const h = harness();
    const first = await send(h, 'private one', true);
    h.advance(HOUR);
    const second = await send(h, 'private two', true);
    expect(second.handle.episodeId).not.toBe(first.handle.episodeId);
    expect(recent(second.handle.userMessage.parts)).toBeUndefined();
    await h.runtime.endOffRecord();
    await send(h, 'normal');
    expect(h.conversations.get(first.handle.episodeId)).toBeNull();
    expect(h.conversations.get(second.handle.episodeId)).toBeNull();
    expect(h.events.filter((event) => event.type === 'conversation.deleted').map((event) => event.episodeId)).toEqual([first.handle.episodeId, second.handle.episodeId]);
  });

  it('ends off-record explicitly even when no provider remains connected', async () => {
    const h = harness();
    const off = await send(h, 'private', true);
    h.model.config.enabled = false;
    await h.runtime.endOffRecord();
    await expect(h.runtime.sendTimeline({ parts: userText('normal') })).rejects.toMatchObject({ code: 'no_provider' });
    expect(h.conversations.get(off.handle.episodeId)).toBeNull();
    expect(h.conversations.getMessage(off.handle.userMessage.id)).toBeNull();
    expect(h.events).toContainEqual({ type: 'conversation.deleted', conversationId: off.handle.episodeId, episodeId: off.handle.episodeId });
    expect(h.conversations.list().flatMap((episode) => h.conversations.messages(episode.id))).toEqual([]);
  });

  it('refuses remember and forget while preserving the recall tool', async () => {
    const memoryTool = (name: string) => ({ ...standardTools()[0]!, name }) as ToolDefinition;
    const h = harness({ tools: ['remember', 'recall', 'forget'].map(memoryTool) });
    h.model.script([ev.call('remember_private', 'remember', { msg: 'secret' }), ev.call('forget_private', 'forget', { msg: 'old' }), ev.call('recall_private', 'recall', { msg: 'history' }), ev.done('tool_use')], [ev.text('Done'), ev.done()]);
    const off = await send(h, 'private', true);
    expect(h.conversations.get(off.handle.episodeId)!.toolset).toEqual(['recall']);
    expect(h.tools.executed.map((call) => call.name)).toEqual(['recall']);
    expect(h.tools.executed[0]!.ctx).toMatchObject({ offRecord: true });
    expect(off.message.parts.filter((part) => part.type === 'tool_result' && part.isError)).toHaveLength(2);
  });

  it('explicitly ends an active turn before deleting its off-record episode', async () => {
    const h = harness();
    h.model.script(waitsForAbort([ev.text('partial')]));
    const handle = await h.runtime.sendTimeline({ parts: userText('private'), offRecord: true });
    await until(() => h.model.requests.length === 1);
    expect(await h.runtime.endOffRecord()).toEqual({ deleted: 1 });
    expect((await handle.done).status).toBe('cancelled');
    expect(h.conversations.get(handle.episodeId)).toBeNull();
    expect(h.events).toContainEqual({ type: 'conversation.deleted', conversationId: handle.episodeId, episodeId: handle.episodeId });
    expect(h.runtime.activeTurns()).toEqual([]);
  });

  it('ending waits for a cancelled off-record turn before a normal send', async () => {
    const h = harness();
    h.model.script(waitsForAbort([ev.text('partial')]), [ev.text('normal answer'), ev.done()]);
    const off = await h.runtime.sendTimeline({ parts: userText('private'), offRecord: true });
    await h.runtime.endOffRecord();
    const normal = await send(h, 'normal');
    expect((await off.done).status).toBe('cancelled');
    expect(normal.message.status).toBe('complete');
    expect(h.conversations.get(off.episodeId)).toBeNull();
    expect(h.warnings.filter((warning) => warning.msg.includes('persist'))).toEqual([]);
  });

  it('purges the entire 12-hour private session including newer episodes while retaining legacy data', async () => {
    const h = harness();
    const legacy = h.conversations.create({ incognito: true, closedAt: h.clock() });
    const old = await send(h, 'old private', true);
    h.advance(12 * HOUR + 1);
    const fresh = await send(h, 'fresh private', true);
    expect(await h.runtime.purgeOffRecord(h.clock() - 12 * HOUR)).toBe(2);
    expect(h.conversations.get(old.handle.episodeId)).toBeNull();
    expect(h.events).toContainEqual({ type: 'conversation.deleted', conversationId: old.handle.episodeId, episodeId: old.handle.episodeId });
    expect(h.conversations.get(fresh.handle.episodeId)).toBeNull();
    expect(h.runtime.offRecordState().active).toBe(false);
    expect(h.conversations.get(legacy.id)).not.toBeNull();
    await h.runtime.endOffRecord();
    expect(h.conversations.get(legacy.id)).not.toBeNull();
  });

  it('purging cancels an expired active turn before deleting it even after recent activity', async () => {
    const h = harness();
    const old = await send(h, 'private', true);
    h.advance(12 * HOUR + 1);
    h.settings.update({ timeline: { episodeGapMinutes: 24 * 60 } });
    h.model.script(waitsForAbort());
    const handle = await h.runtime.sendTimeline({ parts: userText('still private'), offRecord: true });
    expect(handle.episodeId).toBe(old.handle.episodeId);
    expect(await h.runtime.purgeOffRecord(h.clock() - 12 * HOUR)).toBe(1);
    expect((await handle.done).status).toBe('cancelled');
    expect(h.conversations.get(handle.episodeId)).toBeNull();
  });

  it('ending off-record does not cancel a normal running turn', async () => {
    const h = harness();
    h.model.script(waitsForAbort());
    const normal = await h.runtime.sendTimeline({ parts: userText('normal') });
    expect(await h.runtime.endOffRecord()).toEqual({ deleted: 0 });
    expect(h.runtime.activeTurns()).toHaveLength(1);
    h.runtime.cancelTimeline();
    await normal.done;
  });

  it('ending off-record waits for a normal preflight without cancelling its send', async () => {
    const h = harness();
    const gate = deferred();
    h.memory.recallGate = gate.promise;
    const pending = h.runtime.sendTimeline({ parts: userText('normal pending turn') });
    const ending = h.runtime.endOffRecord();
    gate.resolve();
    const handle = await pending;
    expect(await ending).toEqual({ deleted: 0 });
    expect((await handle.done).status).toBe('complete');
    expect(h.conversations.getMessage(handle.userMessage.id)).not.toBeNull();
  });

  it('ending off-record cancels a private preflight before it writes a message', async () => {
    const h = harness();
    const gate = deferred();
    h.memory.recallGate = gate.promise;
    const pending = h.runtime.sendTimeline({ parts: userText('private pending turn'), offRecord: true });
    const failed = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    const ending = h.runtime.endOffRecord();
    gate.resolve();
    await failed;
    await ending;
    expect(h.conversations.list().flatMap((episode) => h.conversations.messages(episode.id))).toEqual([]);
    expect(h.conversations.offRecordEpisodes()).toEqual([]);
  });
});

describe('authoritative off-record state', () => {
  it('starts without a provider, closes the normal episode and is idempotent without renewing expiry', async () => {
    const h = harness();
    h.model.config.enabled = false;
    const state = await h.runtime.startOffRecord();
    expect(state).toEqual({ active: true, episodeId: expect.any(String), startedAt: h.clock() });
    expect(h.conversations.get(h.conv.id)?.closedAt).toBe(h.clock());
    expect(h.conversations.get(state.episodeId!)).toMatchObject({ offRecord: true, ephemeral: true });
    expect(h.conversations.messages(state.episodeId!)).toEqual([]);
    h.advance(HOUR);
    expect(await h.runtime.startOffRecord()).toEqual(state);
    expect(h.events.filter((event) => event.type === 'timeline.off_record')).toEqual([{ type: 'timeline.off_record', active: true }]);
  });

  it('restores persisted mode in a new runtime and sends privately even when the request says false', async () => {
    const h = harness();
    const state = await h.runtime.startOffRecord();
    const reloaded = new AgentRuntime({ conversations: h.conversations, settings: h.settings, providers: h.providers, tools: h.tools, memory: h.memory, clock: h.clock });
    expect(reloaded.offRecordState()).toEqual(state);
    const handle = await reloaded.sendTimeline({ parts: userText('reload private'), offRecord: false });
    await handle.done;
    expect(handle.episodeId).toBe(state.episodeId);
    expect(h.memory.recallCalls.at(-1)).toMatchObject({ reinforce: false });
    await settle();
    expect(h.memory.observeCalls).toEqual([]);
    await reloaded.endOffRecord();
    expect(h.conversations.getMessage(handle.userMessage.id)).toBeNull();
  });

  it('broadcasts mode changes to every subscriber and ending without start is a no-op', async () => {
    const h = harness();
    const second: boolean[] = [];
    h.runtime.subscribe((event) => { if (event.type === 'timeline.off_record') second.push(event.active); });
    expect(await h.runtime.endOffRecord()).toEqual({ deleted: 0 });
    expect(h.conversations.get(h.conv.id)?.closedAt).toBeNull();
    await h.runtime.startOffRecord();
    await h.runtime.endOffRecord();
    expect(await h.runtime.endOffRecord()).toEqual({ deleted: 0 });
    expect(second).toEqual([true, false]);
  });

  it('expires an empty private session and announces its inactive state', async () => {
    const h = harness();
    const state = await h.runtime.startOffRecord();
    h.advance(12 * HOUR + 1);
    expect(await h.runtime.purgeOffRecord(h.clock() - 12 * HOUR)).toBe(1);
    expect(h.runtime.offRecordState()).toEqual({ active: false, episodeId: null, startedAt: null });
    expect(h.conversations.get(state.episodeId!)).toBeNull();
    expect(h.events).toContainEqual({ type: 'timeline.off_record', active: false });
  });

  it.each(['message', 'event'] as const)('routes an older normal %s UI action to the active private episode', async (kind) => {
    const h = harness();
    const source = stored(h, h.conv.id, 'choose');
    const action = kind === 'message'
      ? { id: 'reply', label: 'Reply', kind, text: 'private UI reply' }
      : { id: 'reply', label: 'Reply', kind, payload: { choice: 'private' } };
    h.conversations.updateMessage(source.id, { parts: [{ type: 'ui', id: 'ui_private_reply', block: { type: 'buttons', actions: [action] } }] });
    const state = await h.runtime.startOffRecord();
    const result = await h.runtime.handleTimelineUiAction({ messageId: source.id, uiId: 'ui_private_reply', actionId: 'reply' });
    if (result.kind !== 'turn') throw new Error('Expected a turn');
    const final = await result.turn.done;
    expect(result.turn.episodeId).toBe(state.episodeId);
    expect(final.episodeId).toBe(state.episodeId);
    expect(h.memory.recallCalls.at(-1)).toMatchObject({ reinforce: false });
    await settle();
    expect(h.memory.observeCalls).toEqual([]);
    await h.runtime.endOffRecord();
    expect(h.conversations.getMessage(result.turn.userMessage.id)).toBeNull();
    expect(h.conversations.getMessage(final.id)).toBeNull();
    expect(h.conversations.getMessage(source.id)).not.toBeNull();
  });

  it('rechecks a normal model memory-write confirmation after start and keeps its continuation ephemeral', async () => {
    const remember = { ...standardTools()[1]!, name: 'remember' } as ToolDefinition;
    const h = harness({ tools: [remember] });
    h.model.script([ev.call('remember_confirmed', 'remember', { msg: 'secret' }), ev.done('tool_use')], [ev.text('private confirmation reply'), ev.done()]);
    const handle = await h.runtime.sendTimeline({ parts: userText('normal request') });
    await until(() => h.runtime.pendingConfirmations().length === 1);
    const confirmation = h.runtime.pendingConfirmations()[0]!;
    const state = await h.runtime.startOffRecord();
    expect(h.runtime.confirm(confirmation.id, { approve: true })).toBe(true);
    const final = await handle.done;
    expect(final.id).not.toBe(handle.assistantMessageId);
    expect(final.episodeId).toBe(state.episodeId);
    expect(final.parts).toContainEqual(expect.objectContaining({ type: 'tool_result', name: 'remember', isError: true }));
    expect(h.tools.executed).toEqual([]);
    await settle();
    expect(h.memory.observeCalls).toEqual([]);
    const normal = h.conversations.getMessage(handle.assistantMessageId)!;
    expect(normal.status).toBe('complete');
    expect(JSON.stringify(normal.parts)).not.toContain('private confirmation reply');
    await h.runtime.endOffRecord();
    expect(h.conversations.getMessage(final.id)).toBeNull();
    expect(h.conversations.getMessage(handle.userMessage.id)).not.toBeNull();
  });

  it('executes an approved normal recall confirmation privately and deletes its resulting messages', async () => {
    const recall = { ...standardTools()[1]!, name: 'recall' } as ToolDefinition;
    const h = harness({ tools: [recall] });
    h.model.script([ev.call('recall_confirmed', 'recall', { msg: 'history' }), ev.done('tool_use')], [ev.text('private recall answer'), ev.done()]);
    const handle = await h.runtime.sendTimeline({ parts: userText('normal request') });
    await until(() => h.runtime.pendingConfirmations().length === 1);
    const confirmation = h.runtime.pendingConfirmations()[0]!;
    const state = await h.runtime.startOffRecord();
    h.runtime.confirm(confirmation.id, { approve: true });
    const final = await handle.done;
    expect(h.tools.executed[0]!.ctx).toMatchObject({ offRecord: true, conversationId: state.episodeId });
    expect(final.episodeId).toBe(state.episodeId);
    await settle();
    expect(h.memory.observeCalls).toEqual([]);
    await h.runtime.endOffRecord();
    expect(h.conversations.getMessage(final.id)).toBeNull();
  });

  it('rechecks a UI approval requested on a normal message before private mode was started', async () => {
    const remember = { ...standardTools()[1]!, name: 'remember' } as ToolDefinition;
    const h = harness({ tools: [remember] });
    const source = stored(h, h.conv.id, 'choose');
    h.conversations.updateMessage(source.id, { parts: [{ type: 'ui', id: 'ui_old_approval', block: { type: 'buttons', actions: [{ id: 'remember', label: 'Remember', kind: 'tool', tool: 'remember', input: { msg: 'secret' } }] } }] });
    const input = { messageId: source.id, uiId: 'ui_old_approval', actionId: 'remember' };
    const result = await h.runtime.handleTimelineUiAction(input);
    if (result.kind !== 'confirm') throw new Error('Expected confirmation');
    await h.runtime.startOffRecord();
    await expect(h.runtime.handleTimelineUiAction({ ...input, confirmationToken: result.confirmation.token })).rejects.toMatchObject({ code: 'forbidden' });
    expect(h.tools.executed).toEqual([]);
  });

  it('stores an approved UI widget result in the private episode and leaves its normal source unchanged', async () => {
    const updateTask = { ...standardTools()[1]!, name: 'update_task', inputSchema: z.object({ id: z.string(), done: z.boolean() }), execute: async ({ id, done }: { id: string; done: boolean }) => ({ output: { task: { id, done } } }) } as ToolDefinition;
    const h = harness({ tools: [updateTask] });
    const source = stored(h, h.conv.id, 'task');
    h.conversations.updateMessage(source.id, { parts: [{ type: 'ui', id: 'ui_private_task', block: { type: 'tasks', tasks: [{ id: 'task_private', title: 'Task', done: false }] } }] });
    const original = h.conversations.getMessage(source.id)!;
    const input = { messageId: source.id, uiId: 'ui_private_task', actionId: 'task.toggle:task_private' };
    const result = await h.runtime.handleTimelineUiAction(input);
    if (result.kind !== 'confirm') throw new Error('Expected confirmation');
    const state = await h.runtime.startOffRecord();
    await h.runtime.handleTimelineUiAction({ ...input, confirmationToken: result.confirmation.token });
    expect(h.conversations.getMessage(source.id)).toEqual(original);
    const messages = h.conversations.messages(state.episodeId!);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.parts).toContainEqual(expect.objectContaining({ type: 'ui', block: expect.objectContaining({ tasks: [expect.objectContaining({ done: true })] }) }));
    expect(h.tools.executed).toEqual([]); // protected execution uses the already validated definition
    await h.runtime.endOffRecord();
    expect(h.conversations.getMessage(messages[0]!.id)).toBeNull();
  });
});

describe('timeline UI actions', () => {
  it('cancels private-source recall on end and retains its nonreinforcing context', async () => {
    const recall = { ...standardTools()[0]!, name: 'recall' } as ToolDefinition;
    const h = harness({ tools: [recall] });
    const off = await send(h, 'private', true);
    const source = stored(h, off.handle.episodeId, 'recall');
    h.conversations.updateMessage(source.id, { parts: [{ type: 'ui', id: 'ui_delayed_recall', block: { type: 'buttons', actions: [{ id: 'recall', label: 'Recall', kind: 'tool', tool: 'recall', input: { msg: 'existing' } }] } }] });
    const validation = deferred();
    let validating = false;
    let offRecordAtExecution: boolean | undefined;
    h.tools.execute = async (_call, ctx) => {
      validating = true;
      await validation.promise;
      offRecordAtExecution = ctx.offRecord;
      return { output: { recalled: true } };
    };
    const action = h.runtime.handleTimelineUiAction({ messageId: source.id, uiId: 'ui_delayed_recall', actionId: 'recall' });
    await until(() => validating);
    await h.runtime.endOffRecord();
    expect(h.conversations.get(source.conversationId)).toBeNull();
    validation.resolve();
    expect(await action).toMatchObject({ kind: 'tool', result: { isError: true } });
    expect(offRecordAtExecution).toBe(true);
  });

  it('rechecks memory-write privacy after approved UI validation waits across a mode switch', async () => {
    const gate = deferred();
    let waitForValidation = false;
    let validating = false;
    const remember = {
      ...standardTools()[0]!,
      name: 'remember',
      risk: 'dangerous',
      defaultPermission: 'confirm',
      inputSchema: z.object({ msg: z.string() }).superRefine(async () => {
        if (!waitForValidation) return;
        validating = true;
        await gate.promise;
      }),
    } as ToolDefinition;
    const h = harness({ tools: [remember] });
    const source = stored(h, h.conv.id, 'choose');
    h.conversations.updateMessage(source.id, { parts: [{ type: 'ui', id: 'ui_remember', block: { type: 'buttons', actions: [{ id: 'remember', label: 'Remember', kind: 'tool', tool: 'remember', input: { msg: 'private' } }] } }] });
    const input = { messageId: source.id, uiId: 'ui_remember', actionId: 'remember' };
    const confirmation = await h.runtime.handleTimelineUiAction(input);
    if (confirmation.kind !== 'confirm') throw new Error('Expected confirmation');
    waitForValidation = true;
    const action = h.runtime.handleTimelineUiAction({ ...input, confirmationToken: confirmation.confirmation.token });
    const rejected = expect(action).rejects.toMatchObject({ code: 'forbidden' });
    await until(() => validating);
    await send(h, 'off the record', true);
    gate.resolve();
    await rejected;
    expect(h.tools.executed).toEqual([]);
  });

  it('resolves an older message action in storage and sends into the current timeline episode', async () => {
    const h = harness();
    const first = await send(h, 'first');
    const source = stored(h, first.handle.episodeId, 'choose');
    h.conversations.updateMessage(source.id, { parts: [{ type: 'ui', id: 'ui_timeline', block: { type: 'buttons', actions: [{ id: 'reply', label: 'Reply', kind: 'message', text: 'reply from old UI' }, { id: 'event', label: 'Pick', kind: 'event', payload: { choice: 'one' } }] } }] });
    h.advance(HOUR);
    const current = await send(h, 'current');
    const reply = await h.runtime.handleTimelineUiAction({ messageId: source.id, uiId: 'ui_timeline', actionId: 'reply' });
    expect(reply.kind).toBe('turn');
    if (reply.kind !== 'turn') throw new Error('Expected a turn');
    await reply.turn.done;
    expect(reply.turn.episodeId).toBe(current.handle.episodeId);
    expect(reply.turn.userMessage.parts).toContainEqual({ type: 'text', text: 'reply from old UI' });
    const event = await h.runtime.handleTimelineUiAction({ messageId: source.id, uiId: 'ui_timeline', actionId: 'event' });
    if (event.kind !== 'turn') throw new Error('Expected a turn');
    await event.turn.done;
    expect(event.turn.episodeId).toBe(current.handle.episodeId);
    expect(event.turn.userMessage.parts).toContainEqual({ type: 'ui_event', messageId: source.id, uiId: 'ui_timeline', actionId: 'event', label: 'Pick', payload: { choice: 'one' } });
  });

  it('retains the stored source message in direct tool provenance', async () => {
    const h = harness();
    await send(h, 'first');
    const source = stored(h, h.conv.id, 'choose');
    h.conversations.updateMessage(source.id, { parts: [{ type: 'ui', id: 'ui_tool_source', block: { type: 'buttons', actions: [{ id: 'echo', label: 'Echo', kind: 'tool', tool: 'echo', input: { msg: 'old action' } }] } }] });
    h.advance(HOUR);
    await send(h, 'current');
    const result = await h.runtime.handleTimelineUiAction({ messageId: source.id, uiId: 'ui_tool_source', actionId: 'echo' });
    expect(result.kind).toBe('tool');
    expect(h.tools.executed[0]!.ctx).toMatchObject({ conversationId: h.conv.id, messageId: source.id, origin: 'ui' });
  });

  it('blocks memory writes from old UI while the timeline is off the record and makes recall nonreinforcing', async () => {
    const memoryTool = (name: string) => ({ ...standardTools()[0]!, name }) as ToolDefinition;
    const h = harness({ tools: ['remember', 'recall'].map(memoryTool) });
    await send(h, 'normal');
    const source = stored(h, h.conv.id, 'choose');
    h.conversations.updateMessage(source.id, { parts: [{ type: 'ui', id: 'ui_memory_source', block: { type: 'buttons', actions: [{ id: 'remember', label: 'Remember', kind: 'tool', tool: 'remember', input: { msg: 'private' } }, { id: 'recall', label: 'Recall', kind: 'tool', tool: 'recall', input: { msg: 'existing' } }] } }] });
    await send(h, 'private', true);
    await expect(h.runtime.handleTimelineUiAction({ messageId: source.id, uiId: 'ui_memory_source', actionId: 'remember' })).rejects.toMatchObject({ code: 'forbidden' });
    await h.runtime.handleTimelineUiAction({ messageId: source.id, uiId: 'ui_memory_source', actionId: 'recall' });
    expect(h.tools.executed.map((tool) => tool.name)).toEqual(['recall']);
    expect(h.tools.executed[0]!.ctx).toMatchObject({ offRecord: true, messageId: source.id });
  });
});

describe('timeline mutation boundary', () => {
  it('cancels pending preflight, waits for it, and blocks sends until the mutation releases', async () => {
    const h = harness();
    const recallGate = deferred();
    h.memory.recallGate = recallGate.promise;
    const pending = h.runtime.sendTimeline({ parts: userText('will be cancelled') });
    const failed = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    const mutationGate = deferred();
    let entered = false;
    const mutation = h.runtime.mutateTimeline(async () => {
      entered = true;
      expect(h.conversations.messages(h.conv.id)).toEqual([]);
      await mutationGate.promise;
      return 'deleted';
    });
    expect(entered).toBe(false);
    await expect(h.runtime.sendTimeline({ parts: userText('concurrent') })).rejects.toMatchObject({ code: 'conflict' });
    recallGate.resolve();
    await failed;
    await until(() => entered);
    await expect(h.runtime.sendTimeline({ parts: userText('still concurrent') })).rejects.toMatchObject({ code: 'conflict' });
    mutationGate.resolve();
    expect(await mutation).toBe('deleted');
    h.memory.recallGate = null;
    expect((await send(h, 'after deletion')).message.status).toBe('complete');
  });

  it('leaves active turns alone until the mutation selects which episodes to cancel', async () => {
    const h = harness();
    h.model.script(waitsForAbort());
    const handle = await h.runtime.sendTimeline({ parts: userText('normal active turn') });
    const mutationGate = deferred();
    const mutation = h.runtime.mutateTimeline(async () => {
      expect(h.runtime.activeTurns()).toHaveLength(1);
      await mutationGate.promise;
      h.runtime.cancelConversation(handle.episodeId);
      await h.runtime.waitForIdle([handle.episodeId]);
      h.conversations.deleteMessage(handle.userMessage.id);
    });
    expect(h.runtime.activeTurns()).toHaveLength(1);
    await expect(h.runtime.mutateTimeline(async () => undefined)).rejects.toMatchObject({ code: 'conflict' });
    mutationGate.resolve();
    await mutation;
    expect((await handle.done).status).toBe('cancelled');
    expect(h.conversations.getMessage(handle.userMessage.id)).toBeNull();
    expect(h.conversations.get(handle.episodeId)!.closedAt).not.toBeNull();
  });

  it('releases the mutation boundary after an error and defers purge while it is held', async () => {
    const h = harness();
    await expect(h.runtime.mutateTimeline(async () => {
      expect(await h.runtime.purgeOffRecord(Number.MAX_SAFE_INTEGER)).toBe(0);
      throw new Error('failed deletion');
    })).rejects.toThrow('failed deletion');
    expect((await send(h, 'try again')).message.status).toBe('complete');
  });
});
