import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NeoConfigSchema,
  SENSITIVE_ASSISTANT_PLACEHOLDER,
  SENSITIVE_TOOL_PLACEHOLDER,
  silentLogger,
  type ChatRequest,
  type Message,
} from '@neo/protocol';
import { createServices } from './services.js';
import type { NeoServices } from './index.js';

const SECRET = 'The private atlas project is named orchid-729.';
const resources: NeoServices[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const service of resources.splice(0)) await service.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function setup(sharing = false) {
  const directory = mkdtempSync(join(tmpdir(), 'neo-memory-replay-'));
  directories.push(directory);
  const requests: { model: string; messages: ChatRequest['messages'] }[] = [];
  const service = await createServices(NeoConfigSchema.parse({
    dataDir: directory,
    log: { level: 'silent' },
    settings: { memory: { storeEpisodes: false, sendSensitiveToCloud: sharing } },
  }), {
    mockProviders: [
      { id: 'local', kind: 'mock', local: true, enabled: true },
      { id: 'cloud', kind: 'mock', local: false, enabled: true },
    ],
    inMemory: true,
    logger: silentLogger,
    mockScript(request, callIndex) {
      requests.push({ model: request.model, messages: structuredClone(request.messages) });
      if ((request.model === 'local-model' || sharing) && callIndex === 0) {
        return { toolCalls: [{ id: 'private_recall', name: 'recall', input: { query: 'private atlas project' } }] };
      }
      if (request.model === 'local-model' || (sharing && callIndex === 1)) {
        return { text: `I found ${SECRET}`, reasoning: `My private reasoning is based on ${SECRET}` };
      }
      return { text: 'A normal answer', reasoning: 'Normal reasoning' };
    },
  });
  resources.push(service);
  // Exercise redaction with a destination that can replay reasoning too.
  for (const adapter of service.providers.list()) {
    const caps = adapter.capabilities('test');
    vi.spyOn(adapter, 'capabilities').mockReturnValue({ ...caps, reasoning: true });
  }
  const memory = await service.memory.remember({ content: SECRET, label: 'Private atlas', sensitivity: 'sensitive' });
  return { service, requests, memory };
}

async function send(service: NeoServices, conversationId: string, text: string) {
  const turn = await service.runtime.send({ conversationId, parts: [{ type: 'text', text }] });
  return turn.done;
}

function expectRecallPair(messages: ChatRequest['messages']) {
  const parts = messages.flatMap((message) => message.parts);
  const call = parts.find((part) => part.type === 'tool_call' && part.id === 'private_recall');
  const result = parts.find((part) => part.type === 'tool_result' && part.toolCallId === 'private_recall');
  expect(call).toMatchObject({ type: 'tool_call', name: 'recall' });
  expect(result).toMatchObject({ type: 'tool_result', name: 'recall', output: SENSITIVE_TOOL_PLACEHOLDER });
}

describe('sensitive memory replay through the real services', () => {
  it('keeps ordinary cloud answers unflagged when sharing is off despite sensitive memories in storage', async () => {
    const { service, requests, memory } = await setup();
    expect((await service.memory.get(memory.id))?.node.sensitivity).toBe('sensitive');
    service.settings.update({ ai: { capabilities: { text: { provider: 'cloud', model: 'cloud-model' } } } });
    const conversation = service.conversations.createEpisode();
    const first = await send(service, conversation.id, 'Tell me about the private atlas project');
    expect(first.sensitive).not.toBe(true);
    expect(service.conversations.getMessage(first.id)?.sensitive).not.toBe(true);
    expect(JSON.stringify(requests[0])).not.toContain(SECRET);
    const second = await send(service, conversation.id, 'Continue');
    expect(second.sensitive).not.toBe(true);
    expect(JSON.stringify(requests[1])).toContain('A normal answer');
    expect(JSON.stringify(requests[1])).not.toContain(SENSITIVE_ASSISTANT_PLACEHOLDER);
  });

  it('withholds actual local recall output, quoted answers and reasoning after switching to cloud', async () => {
    const { service, requests } = await setup();
    service.settings.update({ ai: { capabilities: { text: { provider: 'local', model: 'local-model' } } } });
    const conversation = service.conversations.createEpisode();
    const first = await send(service, conversation.id, 'Look deeper into my saved memories');
    const stored = service.conversations.getMessage(first.id)!;
    expect(stored.sensitive).toBe(true);
    expect(stored.parts.find((part) => part.type === 'tool_result')).toMatchObject({ sensitive: true });
    expect(stored.parts.some((part) => part.type === 'reasoning' && part.text.includes(SECRET))).toBe(true);
    expect(JSON.stringify(requests[1])).toContain(SECRET);

    service.settings.update({ ai: { capabilities: { text: { provider: 'cloud', model: 'cloud-model' } } } });
    const recall = vi.spyOn(service.memory, 'recall');
    const next = await send(service, conversation.id, 'Continue');
    const request = requests.find((item) => item.model === 'cloud-model')!;
    expect(JSON.stringify(request)).not.toContain(SECRET);
    expect(JSON.stringify(request)).toContain(SENSITIVE_ASSISTANT_PLACEHOLDER);
    expect(request.messages.flatMap((message) => message.parts).filter((part) => part.type === 'reasoning')).toEqual([]);
    expectRecallPair(request.messages);
    expect(next.sensitive).not.toBe(true);
    expect(recall.mock.calls[0]?.[0].context).toBeUndefined();
    // Redaction is a request projection; the persisted transcript remains append-only.
    expect(service.conversations.getMessage(first.id)).toEqual(stored);
  });

  it('withholds previously shared cloud turns on the next request after sharing is revoked', async () => {
    const { service, requests } = await setup(true);
    service.settings.update({ ai: { capabilities: { text: { provider: 'cloud', model: 'cloud-model' } } } });
    const conversation = service.conversations.createEpisode();
    const first: Message = await send(service, conversation.id, 'Look deeper into my saved memories');
    expect(first.sensitive).toBe(true);
    expect(JSON.stringify(requests[1])).toContain(SECRET);
    service.settings.update({ memory: { sendSensitiveToCloud: false } });
    const next = await send(service, conversation.id, 'Continue');
    const request = requests[2]!;
    expect(JSON.stringify(request)).not.toContain(SECRET);
    expect(JSON.stringify(request)).toContain(SENSITIVE_ASSISTANT_PLACEHOLDER);
    expectRecallPair(request.messages);
    expect(next.sensitive).not.toBe(true);
  });
});
