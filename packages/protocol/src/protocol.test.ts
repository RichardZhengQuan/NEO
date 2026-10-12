import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ContentPartSchema,
  DEFAULT_SETTINGS,
  MemoryPolicySchema,
  NeoConfigSchema,
  NeoSettingsSchema,
  NeoError,
  PROVIDER_PRESETS,
  ErrorShapeSchema,
  EpisodeSchema,
  ForgetBySourceRequestSchema,
  OffRecordStateSchema,
  StartOffRecordRequestSchema,
  EndOffRecordResponseSchema,
  TimelineOffRecordEventSchema,
  SendMessageRequestSchema,
  TimelineMessageSchema,
  applySettingsPatch,
  buildPairingLink,
  buildPairingUrl,
  collectChat,
  defineTool,
  describeRecurrence,
  extractInlineUI,
  hasPrefix,
  isLanAddress,
  isLocalUrl,
  newId,
  parsePairingLink,
  parsePairingUrl,
  toChatMessages,
  toolSpec,
  uiBlockToText,
  validateUIBlocks,
  type ChatStreamEvent,
  type Message,
  type TunnelRoute,
  type UIBlock,
} from './index.js';

const msg = (role: Message['role'], parts: Message['parts'], i = 0): Message => ({
  id: `msg_${i}`,
  conversationId: 'conv_1',
  role,
  parts,
  createdAt: i,
  status: 'complete',
});

describe('off-record contract', () => {
  it('validates private state, empty starts, cleanup counts and the global event', () => {
    expect(OffRecordStateSchema.parse({ active: false, episodeId: null, startedAt: null }).active).toBe(false);
    expect(OffRecordStateSchema.parse({ active: true, episodeId: 'private', startedAt: 1 }).episodeId).toBe('private');
    expect(StartOffRecordRequestSchema.parse({})).toEqual({});
    expect(StartOffRecordRequestSchema.safeParse({ active: false }).success).toBe(false);
    expect(EndOffRecordResponseSchema.safeParse({ deleted: -1 }).success).toBe(false);
    expect(TimelineOffRecordEventSchema.parse({ type: 'timeline.off_record', active: true })).toEqual({ type: 'timeline.off_record', active: true });
    expect(TimelineOffRecordEventSchema.safeParse({ type: 'timeline.off_record', active: 'true' }).success).toBe(false);
  });
});

describe('pairing links', () => {
  const code = 'abcdefghijklmnopqrstuvwxyzABCDEF';
  const tunnel: TunnelRoute = {
    serverId: '0123456789abcdef0123456789abcdef',
    publicKey: 'a'.repeat(43),
    lan: ['192.168.1.20:7778', '[fe80::1]:7778', 'mac.local:7778'],
    relay: 'wss://relay.example/neo',
  };
  const v2 = (fields: Record<string, string>) => `neo://pair?${new URLSearchParams({ v: '2', code, ...fields })}`;

  it('still parses v1 neo and https hash links', () => {
    expect(parsePairingLink(buildPairingUrl('http://computer.local:7777', 'legacy-token'))).toEqual({
      version: 1, serverUrl: 'http://computer.local:7777', token: 'legacy-token',
    });
    expect(parsePairingLink('https://neo.example/#/pair?token=legacy-token')).toEqual({
      version: 1, serverUrl: 'https://neo.example', token: 'legacy-token',
    });
  });

  it('round-trips a v2 direct server route', () => {
    const link = buildPairingLink({ code, serverUrl: 'https://neo.example/' });
    expect(parsePairingLink(link)).toEqual({ version: 2, code, serverUrl: 'https://neo.example', tunnel: null });
    expect(parsePairingUrl(link)).toBeNull();
  });

  it.each([
    { ...tunnel, relay: null },
    { ...tunnel, lan: [] },
    tunnel,
  ])('round-trips a tunnel-only route with LAN and/or relay', (route) => {
    expect(parsePairingLink(buildPairingLink({ code, tunnel: route }))).toEqual({
      version: 2, code, serverUrl: null, tunnel: route,
    });
  });

  it('round-trips direct and tunnel routes together', () => {
    expect(parsePairingLink(buildPairingLink({ code, serverUrl: 'https://neo.example', tunnel }))).toEqual({
      version: 2, code, serverUrl: 'https://neo.example', tunnel,
    });
  });

  it('defaults a v2 https pairing hash to its origin', () => {
    expect(parsePairingLink(`https://neo.example:7777/#/pair?v=2&code=${code}`)).toEqual({
      version: 2, code, serverUrl: 'https://neo.example:7777', tunnel: null,
    });
  });

  it.each<Record<string, string>>([
    { v: '3', server: 'https://neo.example' },
    { code: 'short', server: 'https://neo.example' },
    { code: `${code}!`, server: 'https://neo.example' },
    { id: tunnel.serverId, lan: 'mac.local:7778' },
    { id: tunnel.serverId, pk: 'short', lan: 'mac.local:7778' },
    { id: tunnel.serverId, pk: tunnel.publicKey, lan: 'mac.local' },
    { id: tunnel.serverId, pk: tunnel.publicKey, lan: 'mac.local:0' },
    { id: tunnel.serverId, pk: tunnel.publicKey, lan: 'mac.local:70000' },
    { id: tunnel.serverId, pk: tunnel.publicKey, lan: 'bad host:7778' },
    { id: tunnel.serverId, pk: tunnel.publicKey, lan: Array.from({ length: 9 }, (_, i) => `host${i}.local:7778`).join(',') },
    { id: tunnel.serverId, pk: tunnel.publicKey, relay: 'https://relay.example' },
    {},
  ])('rejects malformed or unroutable v2 fields: %j', (fields) => {
    expect(parsePairingLink(v2(fields))).toBeNull();
  });

  it.each([
    ['192.168.1.20:7778', true],
    ['127.0.0.1:1', true],
    ['mac.local:65535', true],
    ['localhost:7778', true],
    ['[fe80::1]:7778', true],
    ['[::1]:7778', true],
    ['192.168.1.20', false],
    ['mac.local:0', false],
    ['mac.local:70000', false],
    ['bad host:7778', false],
    ['http://mac.local:7778', false],
    ['[not-ipv6]:7778', false],
    ['fe80::1:7778', false],
    ['', false],
  ])('validates LAN address %s as %s', (address, valid) => {
    expect(isLanAddress(address as string)).toBe(valid);
  });
});

describe('ids', () => {
  it('creates prefixed, unique, time-sortable ids', () => {
    const a = newId('mem', 1000);
    const b = newId('mem', 2000);
    expect(hasPrefix(a, 'mem')).toBe(true);
    expect(a).not.toBe(newId('mem', 1000));
    expect(a < b).toBe(true);
  });
});

describe('generative UI', () => {
  const card: UIBlock = {
    type: 'card',
    title: 'Trip to Kyoto',
    children: [
      { type: 'stat', label: 'Budget', value: 1200, unit: 'USD' },
      { type: 'buttons', actions: [{ id: 'book', label: 'Book it', kind: 'message', text: 'Book the trip' }] },
    ],
    actions: [{ id: 'open', label: 'Open map', kind: 'link', url: 'https://maps.example.com' }],
  };

  it('accepts a nested valid tree', () => {
    const r = validateUIBlocks([card]);
    expect(r.ok).toBe(true);
  });

  it('rejects javascript: links and svg data images', () => {
    expect(validateUIBlocks({ type: 'link', url: 'javascript:alert(1)', title: 'x' }).ok).toBe(false);
    expect(validateUIBlocks({ type: 'image', url: 'data:image/svg+xml;base64,PHN2Zz4=', alt: 'x' }).ok).toBe(false);
    expect(validateUIBlocks({ type: 'image', url: 'data:image/png;base64,iVBORw0KGgo=', alt: 'x' }).ok).toBe(true);
  });

  it('rejects unknown block types and excessive depth', () => {
    expect(validateUIBlocks({ type: 'script', code: 'x' }).ok).toBe(false);
    let deep: UIBlock = { type: 'text', text: 'leaf' };
    for (let i = 0; i < 10; i++) deep = { type: 'stack', children: [deep] };
    const r = validateUIBlocks(deep);
    expect(r.ok).toBe(false);
  });

  it('rejects duplicate action ids', () => {
    const r = validateUIBlocks({
      type: 'buttons',
      actions: [
        { id: 'a', label: 'A', kind: 'event' },
        { id: 'a', label: 'B', kind: 'event' },
      ],
    });
    expect(r.ok).toBe(false);
  });

  it('renders text fallback', () => {
    const text = uiBlockToText(card);
    expect(text).toContain('Trip to Kyoto');
    expect(text).toContain('Budget: 1200 USD');
    expect(text).toContain('[Book it]');
  });

  it('extracts inline neo-ui fences', () => {
    const r = extractInlineUI('Here you go:\n```neo-ui\n{"type":"callout","tone":"info","text":"Hi"}\n```\nDone.');
    expect(r.blocks).toHaveLength(1);
    expect(r.text).toBe('Here you go:\n\nDone.');
  });
});

describe('transcript', () => {
  it('splits assistant steps and closes unfinished tool calls', () => {
    const history: Message[] = [
      msg('user', [{ type: 'context', text: '<neo_context>t</neo_context>' }, { type: 'text', text: 'remind me' }], 1),
      msg(
        'assistant',
        [
          { type: 'reasoning', text: 'thinking', provider: 'anthropic', data: { signature: 's' } },
          { type: 'text', text: 'Sure.' },
          { type: 'tool_call', id: 't1', name: 'create_reminder', input: { title: 'x' } },
          { type: 'tool_call', id: 't2', name: 'get_datetime', input: {} },
          { type: 'tool_result', toolCallId: 't1', name: 'create_reminder', output: { ok: true } },
          { type: 'ui', id: 'ui_1', block: { type: 'text', text: 'shown' } },
          { type: 'text', text: 'Done!' },
        ],
        2,
      ),
      msg('user', [{ type: 'ui_event', messageId: 'msg_2', uiId: 'ui_1', actionId: 'snooze', label: 'Snooze' }], 3),
    ];
    const chat = toChatMessages(history);
    expect(chat.map((c) => c.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user']);
    expect(chat[0]!.parts).toHaveLength(2);
    const tool = chat[2]!;
    expect(tool.parts).toHaveLength(2);
    expect(tool.parts[1]).toMatchObject({ type: 'tool_result', toolCallId: 't2', isError: true });
    expect(JSON.stringify(chat[4])).toContain('Snooze');
    expect(toChatMessages(history, { dropReasoning: true })[1]!.parts[0]).toMatchObject({ type: 'text' });
  });

  it('merges consecutive user messages and drops reasoning-only steps', () => {
    const chat = toChatMessages([
      msg('user', [{ type: 'text', text: 'a' }], 1),
      msg('assistant', [{ type: 'reasoning', text: 'hmm' }], 2),
      msg('user', [{ type: 'text', text: 'b' }], 3),
    ]);
    expect(chat).toHaveLength(1);
    expect(chat[0]!.parts).toHaveLength(2);
  });

  it('validates content parts', () => {
    expect(ContentPartSchema.safeParse({ type: 'image', mediaType: 'image/png' }).success).toBe(false);
    expect(ContentPartSchema.safeParse({ type: 'image', mediaType: 'image/png', data: 'AAAA' }).success).toBe(true);
  });
});

describe('config & settings', () => {
  it('carries no_provider as a typed HTTP bad request', () => {
    const error = new NeoError('no_provider', 'Connect an AI to start chatting.');
    expect(error.status).toBe(400);
    expect(ErrorShapeSchema.parse(error.toJSON()).code).toBe('no_provider');
  });

  it('fills nested defaults', () => {
    expect(DEFAULT_SETTINGS.persona).toEqual({ avatar: null });
    expect(DEFAULT_SETTINGS.memory).not.toHaveProperty('mode');
    expect(DEFAULT_SETTINGS.memory.consolidation.intervalHours).toBe(6);
    expect(DEFAULT_SETTINGS.agent.maxSteps).toBe(8);
    expect(DEFAULT_SETTINGS.timeline.episodeGapMinutes).toBe(60);
    expect(DEFAULT_SETTINGS.agent).not.toHaveProperty('autoTitle');
    const cfg = NeoConfigSchema.parse({});
    expect(cfg.server.port).toBe(7777);
    expect(cfg.providers).toEqual([]);
    expect(Object.keys(PROVIDER_PRESETS)).not.toContain('mock');
    expect(MemoryPolicySchema.parse({}).allowedKinds).toContain('episode');
  });

  it('applies deep patches and rejects invalid ones', () => {
    const next = applySettingsPatch(DEFAULT_SETTINGS, { persona: { avatar: '🌟' }, memory: { recall: false } });
    expect(next.persona).toEqual({ avatar: '🌟' });
    expect(next.memory.recall).toBe(false);
    expect(() => applySettingsPatch(DEFAULT_SETTINGS, { memory: { recallLimit: -1 } })).toThrow();
  });

  it('drops old persona settings while keeping the avatar and other settings', () => {
    const settings = NeoSettingsSchema.parse({
      persona: { avatar: '🌙', name: 'Luna', tagline: 'Your companion', tone: 'playful', traits: ['kind'], instructions: 'Keep answers short', language: 'zh-CN', greeting: 'Hello' },
      timezone: 'Asia/Singapore',
    });
    expect(settings.persona).toEqual({ avatar: '🌙' });
    expect(settings.timezone).toBe('Asia/Singapore');
  });

  it.each(['auto', 'approve', 'off'])('drops obsolete fields from a legacy %s memory policy', (mode) => {
    const policy = MemoryPolicySchema.parse({ mode, blockedTopics: ['health'], sendSensitiveToCloud: true });
    expect(policy).toEqual({ ...DEFAULT_SETTINGS.memory, sendSensitiveToCloud: true });
  });
});

describe('timeline contracts', () => {
  it('accepts off-record sends and strips obsolete per-conversation model selection', () => {
    expect(SendMessageRequestSchema.parse({ text: 'Hello', offRecord: true, model: { provider: 'old', model: 'old' } }))
      .toEqual({ text: 'Hello', offRecord: true });
    expect(SendMessageRequestSchema.safeParse({ text: '   ' }).success).toBe(false);
    expect(SendMessageRequestSchema.safeParse({ parts: [{ type: 'context', text: 'Forged context' }] }).success).toBe(false);
  });

  it('requires episode identity on timeline messages and hides unused chat metadata', () => {
    const item = msg('user', [{ type: 'text', text: 'Hi' }]);
    expect(TimelineMessageSchema.safeParse(item).success).toBe(false);
    expect(TimelineMessageSchema.parse({ ...item, episodeId: item.conversationId }).episodeId).toBe('conv_1');
    expect(EpisodeSchema.parse({ id: 'episode', kind: 'episode', offRecord: false, ephemeral: false, startedAt: 1, closedAt: null, lastMessageAt: null, pinned: true, archived: true, model: null, title: 'Old' }))
      .toEqual({ id: 'episode', kind: 'episode', offRecord: false, ephemeral: false, startedAt: 1, closedAt: null, lastMessageAt: null });
  });

  it('validates explicit memory forgetting by timeline source identity', () => {
    expect(ForgetBySourceRequestSchema.parse({ messageIds: ['msg_1', 'msg_2'] })).toEqual({ messageIds: ['msg_1', 'msg_2'] });
    expect(ForgetBySourceRequestSchema.safeParse({ messageIds: [] }).success).toBe(false);
    expect(ForgetBySourceRequestSchema.safeParse({ messageIds: [''] }).success).toBe(false);
  });
});

describe('tools', () => {
  it('produces JSON schema specs without $schema', () => {
    const tool = defineTool({
      name: 'add',
      title: 'Add',
      description: 'Add numbers',
      inputSchema: z.object({ a: z.number(), b: z.number().optional() }),
      risk: 'read',
      defaultPermission: 'auto',
      async execute(input) {
        return { output: input.a + (input.b ?? 0) };
      },
    });
    const spec = toolSpec(tool);
    expect(spec.inputSchema.type).toBe('object');
    expect(spec.inputSchema.$schema).toBeUndefined();
    expect(spec.inputSchema.required).toEqual(['a']);
  });
});

describe('misc helpers', () => {
  it('collects a chat stream', async () => {
    async function* gen(): AsyncIterable<ChatStreamEvent> {
      yield { type: 'text', text: 'Hel' };
      yield { type: 'text', text: 'lo' };
      yield { type: 'tool_call', id: 'x', name: 'n', input: { a: 1 } };
      yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } };
      yield { type: 'done', stopReason: 'tool_use' };
    }
    const r = await collectChat(gen());
    expect(r.text).toBe('Hello');
    expect(r.toolCalls).toHaveLength(1);
    expect(r.stopReason).toBe('tool_use');
  });

  it('detects local urls', () => {
    expect(isLocalUrl('http://127.0.0.1:11434')).toBe(true);
    expect(isLocalUrl('http://192.168.1.5:8080/v1')).toBe(true);
    expect(isLocalUrl('http://nas.local')).toBe(true);
    expect(isLocalUrl('https://api.openai.com/v1')).toBe(false);
  });

  it('round-trips pairing urls', () => {
    const url = buildPairingUrl('https://neo.example.com', 'tok_123');
    expect(parsePairingUrl(url)).toEqual({ serverUrl: 'https://neo.example.com', token: 'tok_123' });
    expect(parsePairingUrl('https://neo.example.com/#/pair?token=abc')).toEqual({ serverUrl: 'https://neo.example.com', token: 'abc' });
    expect(parsePairingUrl('nonsense')).toBeNull();
  });

  it('describes recurrence', () => {
    expect(describeRecurrence({ freq: 'weekly', interval: 2, byWeekday: [3, 1] })).toBe('every 2 weeks on Mon, Wed');
    expect(describeRecurrence(null)).toBe('once');
  });

  it('normalizes errors', () => {
    const e = NeoError.from(Object.assign(new Error('x'), { name: 'AbortError' }));
    expect(e.code).toBe('cancelled');
    expect(new NeoError('not_found', 'nope').status).toBe(404);
  });
});

describe('widget actions', () => {
  it('resolves task, reminder and memory widget actions against the stored block', async () => {
    const { resolveWidgetAction, widgetActionId } = await import('./index.js');
    const tasks: UIBlock = { type: 'tasks', tasks: [{ id: 'task_1', title: 'Milk', done: false }] };
    expect(resolveWidgetAction(tasks, widgetActionId.taskToggle('task_1'))).toMatchObject({ kind: 'tool', tool: 'update_task', input: { id: 'task_1', done: true } });
    expect(resolveWidgetAction(tasks, widgetActionId.taskToggle('task_1'), { done: false })).toMatchObject({ input: { done: false } });
    expect(resolveWidgetAction(tasks, widgetActionId.taskToggle('task_other'))).toBeNull();
    const card: UIBlock = {
      type: 'card',
      children: [{ type: 'reminder', reminderId: 'rem_1', title: 'Water', dueAt: 0, status: 'fired' }],
    };
    expect(resolveWidgetAction(card, widgetActionId.reminderSnooze(10))).toMatchObject({ tool: 'snooze_reminder', input: { id: 'rem_1', minutes: 10 } });
    expect(resolveWidgetAction(card, 'reminder.snooze:999999')).toBeNull();
    const mem: UIBlock = { type: 'memory', nodes: [{ id: 'mem_1', kind: 'fact', label: 'x' }] };
    expect(resolveWidgetAction(mem, widgetActionId.memoryForget('mem_1'))).toMatchObject({ tool: 'forget', confirm: expect.any(String) });
    expect(resolveWidgetAction(mem, widgetActionId.memoryForget('mem_2'))).toBeNull();
  });
});

describe('privacy helpers', () => {
  it('only treats IPv6 literals (not DNS names) as unique-local/link-local', () => {
    expect(isLocalUrl('https://fd-collector.example.com/v1')).toBe(false);
    expect(isLocalUrl('https://fe80.example.com')).toBe(false);
    expect(isLocalUrl('http://[fd12:3456::1]:8080')).toBe(true);
    expect(isLocalUrl('http://[fe80::1]')).toBe(true);
    expect(isLocalUrl('http://[::1]:11434')).toBe(true);
    expect(isLocalUrl('http://[2001:db8::1]')).toBe(false);
  });

  it('withholds sensitive context parts when asked', () => {
    const history: Message[] = [
      msg('user', [{ type: 'context', text: '<neo_context>diagnosis</neo_context>', sensitive: true }, { type: 'text', text: 'hi' }], 1),
    ];
    expect(JSON.stringify(toChatMessages(history))).toContain('diagnosis');
    const redacted = JSON.stringify(toChatMessages(history, { omitSensitiveContext: true }));
    expect(redacted).not.toContain('diagnosis');
    expect(redacted).toContain('withheld');
  });

  it('withholds private-derived tool arguments, opaque payloads and summaries while retaining call/result pairing', () => {
    const secret = 'private-orchid-729';
    const message: Message = {
      ...msg('assistant', [
        { type: 'reasoning', text: secret, data: { signature: secret } },
        { type: 'tool_call', id: 'private_call', name: 'create_note', input: { body: secret }, data: { private: secret } },
        { type: 'tool_result', toolCallId: 'private_call', name: 'create_note', output: { body: secret }, summary: `Saved ${secret}` },
        { type: 'ui', id: 'private_ui', block: { type: 'text', text: secret } },
        { type: 'text', text: secret },
      ]),
      sensitive: true,
    };
    const original = structuredClone(message);
    const projected = toChatMessages([message], { omitSensitiveContext: true });
    expect(JSON.stringify(projected)).not.toContain(secret);
    expect(projected[0]).toMatchObject({ role: 'assistant', parts: [{ type: 'tool_call', id: 'private_call', name: 'create_note', input: {} }] });
    expect(projected[1]).toMatchObject({ role: 'tool', parts: [{ type: 'tool_result', toolCallId: 'private_call', name: 'create_note' }] });
    expect(toChatMessages([message])[0]?.parts).toContainEqual(message.parts[1]);
    expect(message).toEqual(original);
  });

  it('does not retain the summary of a flagged tool result even without a message flag', () => {
    const message = msg('assistant', [
      { type: 'tool_call', id: 'recall_call', name: 'recall', input: {} },
      { type: 'tool_result', toolCallId: 'recall_call', name: 'recall', output: 'private-orchid-729', summary: 'private-orchid-729', sensitive: true },
    ]);
    expect(JSON.stringify(toChatMessages([message], { omitSensitiveContext: true }))).not.toContain('private-orchid-729');
  });
});
