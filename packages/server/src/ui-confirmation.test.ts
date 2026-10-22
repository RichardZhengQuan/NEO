import { expect, it } from 'vitest';
import { parseConfig, silentLogger, widgetActionId } from '@neo/protocol';
import type { Conversation, MemoryNode, UIPart, UiActionResponse } from '@neo/protocol';
import { createApp } from './app.js';
import { createServices } from './services.js';
import { scriptedProviderOptions } from './testing/mock-options.js';

it('real runtime: memory.forget widget confirms the named memory, deletes on approval and rejects replay', async () => {
  const clock = () => Date.UTC(2026, 9, 11, 12);
  const services = await createServices(parseConfig({
    dataDir: '/unwritten-neo-ui-confirmation',
    server: { authToken: 'ui-confirmation-owner-0123456789' },
    settings: { timezone: 'UTC', locale: 'en', memory: { enabled: false, consolidation: { enabled: false } } },
    log: { level: 'silent' },
  }), {
    ...scriptedProviderOptions(), inMemory: true, logger: silentLogger, clock,
    mockScript: (request) => request.messages.at(-1)?.role === 'tool'
      ? { text: 'Remembered.' }
      : { toolCalls: [{ id: 'remember-call', name: 'remember', input: { content: 'The user prefers window seats.', label: 'Window seats' } }] },
  });
  const { app } = createApp(services);
  const request = (path: string, body?: unknown) => app.request(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${services.ownerToken}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const read = async <T>(response: Response): Promise<T> => {
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json() as Promise<T>;
  };
  try {
    const conversation = services.conversations.createEpisode();
    const turn = await services.runtime.send({ conversationId: conversation.id, parts: [{ type: 'text', text: 'Remember my preferred seat.' }] });
    const message = await turn.done;
    expect(message.status).toBe('complete');
    const widget = message.parts.find((part): part is UIPart => part.type === 'ui' && part.block.type === 'memory');
    if (!widget || widget.block.type !== 'memory') throw new Error('Remember tool did not create a stored memory widget');
    const node = widget.block.nodes[0]!;
    expect(node.label).toBe('Window seats');
    const path = '/timeline/ui-action';
    const body = { messageId: message.id, uiId: widget.id, actionId: widgetActionId.memoryForget(node.id) };
    const result = await read<UiActionResponse>(await request(path, body));
    expect(result.kind).toBe('confirm');
    if (result.kind !== 'confirm') throw new Error('Expected server-written UI confirmation');
    expect(result.confirmation).toMatchObject({ tool: 'forget', title: 'Forget memories', description: 'Forget “Window seats”', risk: 'dangerous', expiresAt: clock() + services.settings.get().agent.confirmationTimeoutSec * 1000 });
    expect(result.confirmation.token).toBeTruthy();
    expect((await read<{ node: MemoryNode }>(await request(`/memory/${node.id}`))).node.id).toBe(node.id);

    const approved = { ...body, confirmationToken: result.confirmation.token };
    expect(await read<UiActionResponse>(await request(path, approved))).toMatchObject({ kind: 'tool', isError: false, output: { forgotten: ['Window seats'] } });
    expect((await request(`/memory/${node.id}`)).status).toBe(404);
    const replay = await request(path, approved);
    expect([400, 409]).toContain(replay.status);
    expect(await replay.json()).toMatchObject({ code: expect.stringMatching(/^(bad_request|conflict)$/), message: expect.stringMatching(/confirmation|token/i) });
  } finally {
    await services.close();
  }
});
