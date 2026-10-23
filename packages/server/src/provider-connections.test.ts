import { describe, it, expect, vi } from 'vitest';
import { createProviderRegistry } from '@neo/providers';
import type { ProviderConfig, SecretStore } from '@neo/protocol'

/** Minimal in-memory SecretStore. */
function makeSecrets(): SecretStore {
  const m = new Map<string, string>();
  return {
    get: (n) => m.get(n),
    set: (n, v) => { m.set(n, v); },
    delete: (n) => m.delete(n),
    list: () => [...m.keys()],
  };
}

/** Collect all events from an async iterable. */
async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iterable) out.push(v);
  return out;
}

describe('createProviderRegistry — credential isolation', () => {
  it.each(['initial configuration', 'upsert'] as const)(
    'retained adapter does not send the new key to the old endpoint after a PATCH (created by %s)',
    async (creation) => {
      const secrets = makeSecrets();
      secrets.set('provider:x', 'key-A');

      const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(
        'data: [DONE]\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ));
      const config: ProviderConfig = {
        id: 'x', kind: 'openai-compatible', label: 'X',
        baseUrl: 'https://host-a.example.com', apiKeySecret: 'provider:x', enabled: true,
      };
      const registry = createProviderRegistry(
        creation === 'initial configuration' ? [config] : [],
        { fetch, resolveSecret: (name) => secrets.get(name) },
      );
      const retainedAdapter = creation === 'initial configuration' ? registry.get('x')! : registry.upsert(config);

      // Simulate PATCH: save the new secret before replacing the adapter.
      secrets.set('provider:x', 'key-B');
      registry.upsert({ ...config, baseUrl: 'https://host-b.example.com' });

      await drain(retainedAdapter.chat({
        model: 'gpt-4o',
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      }));

      expect(fetch).toHaveBeenCalledOnce();
      const [url, init] = fetch.mock.calls[0]!;
      expect(url).toBe('https://host-a.example.com/chat/completions');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer key-A');
    },
  );
});
