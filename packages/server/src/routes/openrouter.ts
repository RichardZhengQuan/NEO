import { createHash, randomBytes } from 'node:crypto';
import type { Hono } from 'hono';
import { CancelOpenRouterRequestSchema, NeoError, OPENROUTER_PRESET } from '@neo/protocol';
import type { NeoServices } from '../index.js';
import { ownerOnly } from '../auth.js';
import { connectSimpleProvider } from '../provider-connections.js';
import { validateBody } from './helpers.js';

const TTL_MS = 10 * 60 * 1000;
const SUCCESS_HTML = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NEO · OpenRouter</title><style>html{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111219;color:#f4f4f7;font:16px system-ui,sans-serif}main{max-width:420px;margin:24px;padding:36px;border:1px solid #ffffff20;border-radius:24px;background:#ffffff08;box-shadow:0 24px 80px #0005}h1{font-size:24px;line-height:1.35}p{color:#b5b5c1;line-height:1.6}</style><main><h1>NEO is connected to OpenRouter.</h1><p>You can close this tab.</p><p lang="zh">NEO 已连接到 OpenRouter。你可以关闭此标签页。</p></main></html>`;

/** Keep the browser callback public; the owner alone can create or cancel its state. */
export function openRouterRoutes(services: NeoServices) {
  const pending = new Map<string, { verifier: string; expiresAt: number }>();
  const active = new Map<string, AbortController>();
  const prune = () => {
    for (const [state, attempt] of pending) if (attempt.expiresAt <= services.clock()) pending.delete(state);
  };
  const baseUrl = (services.openRouter?.baseUrl ?? OPENROUTER_PRESET.baseUrl!).replace(/\/+$/, '');

  function registerPublic(app: Hono): void {
    app.get('/api/auth/openrouter/callback', async (c) => {
      const state = c.req.query('state') ?? '';
      const attempt = pending.get(state);
      // Consume before the first await, including failed exchanges: codes are single-use.
      pending.delete(state);
      if (!attempt || attempt.expiresAt <= services.clock()) throw new NeoError('bad_request', 'This OpenRouter sign-in has expired or is invalid. Start again in NEO.');
      const code = c.req.query('code');
      if (!code || code.length > 4096) throw new NeoError('bad_request', 'OpenRouter did not return a valid sign-in code. Start again in NEO.');
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
      active.set(state, controller);
      try {
        let response: Response;
        try {
          response = await fetch(`${baseUrl}/auth/keys`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, code_verifier: attempt.verifier, code_challenge_method: 'S256' }),
            signal,
          });
        } catch {
          if (controller.signal.aborted) throw new NeoError('cancelled', 'OpenRouter sign-in was cancelled.');
          throw new NeoError('provider_error', 'Could not reach OpenRouter. Start sign-in again.', { retryable: true });
        }
        // Upstream bodies may contain credentials or the verifier; never reflect or log them.
        if (!response.ok) throw new NeoError(response.status === 403 ? 'provider_auth' : 'provider_error', 'OpenRouter could not complete sign-in. The code may be invalid or expired. Start again in NEO.', { details: { status: response.status } });
        const result: unknown = await response.json().catch(() => null);
        if (!result || typeof result !== 'object' || !('key' in result) || typeof result.key !== 'string' || !result.key.trim()) {
          throw new NeoError('provider_error', 'OpenRouter did not return an API key. Start sign-in again.');
        }
        await connectSimpleProvider(services, { id: 'openrouter', kind: OPENROUTER_PRESET.kind, label: OPENROUTER_PRESET.label, baseUrl, enabled: true, local: false }, result.key, { state, autoIdPrefix: 'openrouter', signal });
        c.header('Cache-Control', 'no-store');
        c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
        return c.html(SUCCESS_HTML);
      } finally { active.delete(state); }
    });
  }

  function registerPrivate(app: Hono): void {
    app.post('/api/auth/openrouter/start', ownerOnly(), (c) => {
      prune();
      if (pending.size >= 100) throw new NeoError('rate_limited', 'Too many pending sign-ins. Cancel one or try again later.');
      const state = randomBytes(32).toString('base64url');
      const verifier = randomBytes(48).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const expiresAt = services.clock() + TTL_MS;
      const callback = new URL('/api/auth/openrouter/callback', services.config.server.publicUrl ?? new URL(c.req.url).origin);
      if (!['http:', 'https:'].includes(callback.protocol)) throw new NeoError('config_error', 'The public server URL must use HTTP or HTTPS for OpenRouter sign-in.');
      const url = new URL(services.openRouter?.authorizationUrl ?? 'https://openrouter.ai/auth');
      url.search = new URLSearchParams({ callback_url: callback.href, code_challenge: challenge, code_challenge_method: 'S256', key_label: 'NEO', state }).toString();
      pending.set(state, { verifier, expiresAt });
      c.header('Cache-Control', 'no-store');
      return c.json({ url: url.href, state, expiresAt });
    });
    app.post('/api/auth/openrouter/cancel', ownerOnly(), async (c) => {
      const body = await validateBody(c, CancelOpenRouterRequestSchema);
      prune();
      const cancelled = pending.delete(body.state);
      const controller = active.get(body.state);
      controller?.abort();
      return c.json({ cancelled: cancelled || Boolean(controller) });
    });
  }
  return { registerPublic, registerPrivate };
}
