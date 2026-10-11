import { afterEach, describe, expect, it } from 'vitest';
import { NeoConfigSchema, silentLogger } from '@neo/protocol';
import type { ChatRequest, ImagePart, SendMessageRequest, UserInputPart } from '@neo/protocol';
import { createApp } from './app.js';
import { createServices } from './services.js';
import type { NeoServices } from './index.js';

const resources: NeoServices[] = [];
afterEach(async () => { for (const services of resources.splice(0)) await services.close(); });

const images: ImagePart[] = [
  { type: 'image', mediaType: 'image/png', data: 'aW1hZ2UtZml4dHVyZQ==', alt: 'First image' },
  { type: 'image', mediaType: 'image/jpeg', url: 'https://images.example/second.jpg', alt: 'Second image' },
];
const text: UserInputPart = { type: 'text', text: 'What is different in these pictures?' };
const cases: { name: string; body: SendMessageRequest; expected: UserInputPart[] }[] = [
  { name: 'text only', body: { text: text.text }, expected: [text] },
  { name: 'images only', body: { parts: images }, expected: images },
  { name: 'legacy text alongside images', body: { text: text.text, parts: images }, expected: [text, ...images] },
  { name: 'composed text and images', body: { parts: [text, ...images] }, expected: [text, ...images] },
];

describe('message parts through HTTP, runtime and storage', () => {
  it.each(cases)('preserves $name on the first send and a retry', async ({ body, expected }) => {
    const requests: ChatRequest[] = [];
    const services = await createServices(NeoConfigSchema.parse({
      providers: [{ id: 'fixture', kind: 'mock', defaultModel: 'fixture-model' }],
      settings: { memory: { mode: 'off' }, agent: { autoTitle: false } },
      plugins: { enabled: false }, log: { level: 'silent' },
    }), {
      inMemory: true, logger: silentLogger,
      mockScript: request => { requests.push(structuredClone(request)); return { text: 'Received all parts.' }; },
    });
    resources.push(services);
    const conversation = services.conversations.create({ title: 'Message parts fixture', incognito: true });
    const { app } = createApp(services);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await app.request(`/api/conversations/${conversation.id}/messages`, {
        method: 'POST', headers: { Authorization: `Bearer ${services.ownerToken}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      const events = await response.text();
      expect(events).toContain('event: turn.finished');
      expect(events).not.toContain('event: turn.failed');
      const stored = services.conversations.messages(conversation.id).filter(message => message.role === 'user');
      expect(stored).toHaveLength(attempt + 1);
      for (const message of stored) expect(message.parts.filter(part => part.type !== 'context')).toEqual(expected);
      const lastUser = requests[attempt]?.messages.findLast(message => message.role === 'user');
      expect(lastUser?.parts.filter(part => part.type !== 'text' || !part.text.startsWith('<neo_context>'))).toEqual(expected);
    }
    expect(requests).toHaveLength(2);
  });
});
