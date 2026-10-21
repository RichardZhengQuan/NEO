import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Hono } from 'hono';
import { NeoError, pickDefaultCapabilities, type ChatGPTStatusResponse, type ProviderConfig } from '@neo/protocol';
import { createProvider } from '@neo/providers';
import type { NeoServices } from '../index.js';
import { ownerOnly } from '../auth.js';
import { deriveProviderId, providerView, saveProvider } from '../provider-connections.js';
import {
  chatGPTSecretName, createChatGPTAuthorization, exchangeChatGPTCode,
  parseIssuedClientId, readChatGPTCredentials, type ChatGPTCredentials,
} from '../chatgpt-auth.js';

const TTL_MS = 10 * 60_000;
const SUCCESS_HTML = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NEO · ChatGPT</title><body><main><h1>Connected, you can close this tab.</h1><p lang="zh">已连接，你可以关闭此标签页。</p></main></body></html>';
const FAILURE_HTML = '<!doctype html><html lang="en"><meta charset="utf-8"><title>NEO · ChatGPT</title><body><h1>Sign-in could not be completed. Return to NEO.</h1><p lang="zh">登录未完成，请返回 NEO。</p></body></html>';

interface Attempt {
  state: string;
  nonce: string;
  verifier: string;
  hostId: string;
  expiresAt: number;
  redirectUri: string;
  authorizationUrl: string;
  previous?: ChatGPTCredentials;
  providerId?: string;
  server: Server;
  timer: ReturnType<typeof setTimeout>;
  controller: AbortController;
  consumed: boolean;
  launched: boolean;
  result: ChatGPTStatusResponse;
}

/** Each attempt owns a loopback listener; none of its credentials cross the NEO API. */
export function registerChatGPT(app: Hono, services: NeoServices): void {
  const attempts = new Map<string, Attempt>();
  const active = new Set<Promise<void>>();
  let closing = false;
  const stopListener = (attempt: Attempt) => {
    clearTimeout(attempt.timer);
    attempt.server.close();
    attempt.server.closeIdleConnections();
  };
  const cancel = (attempt: Attempt, expired = false) => {
    if (attempt.result.status !== 'waiting') return false;
    attempt.consumed = true;
    attempt.controller.abort();
    attempt.result = expired
      ? { status: 'failed', error: new NeoError('timeout', 'ChatGPT sign-in expired. Start again in NEO.').toJSON() }
      : { status: 'cancelled' };
    stopListener(attempt);
    return true;
  };
  services.cancelChatGPTSignIns = (providerId) => {
    for (const attempt of attempts.values()) if (attempt.providerId === providerId) cancel(attempt);
  };
  const prune = () => {
    for (const [state, attempt] of attempts) {
      if (attempt.expiresAt <= services.clock()) cancel(attempt, true);
      if (attempt.expiresAt + TTL_MS <= services.clock()) attempts.delete(state);
    }
  };
  const close = services.close.bind(services);
  services.close = async () => {
    closing = true;
    for (const attempt of attempts.values()) {
      cancel(attempt);
      attempt.server.closeAllConnections();
    }
    await Promise.allSettled([...active]);
    attempts.clear();
    delete services.cancelChatGPTSignIns;
    await close();
  };

  async function connect(attempt: Attempt, params: URLSearchParams): Promise<void> {
    const clientId = parseIssuedClientId(params);
    if (attempt.previous && clientId !== attempt.previous.clientId) throw new NeoError('provider_auth', 'ChatGPT returned a different app registration. Start sign-in again.');
    const code = params.get('code');
    if (!code || code.length > 4096) throw new NeoError('bad_request', 'ChatGPT did not return a valid sign-in code.');
    const credentials = await exchangeChatGPTCode({
      code, clientId, verifier: attempt.verifier, redirectUri: attempt.redirectUri,
      nonce: attempt.nonce, hostId: attempt.hostId, signal: attempt.controller.signal,
    }, services.chatGPT, services.clock);
    if (attempt.previous && credentials.sub !== attempt.previous.sub) throw new NeoError('provider_auth', 'Sign in with the same ChatGPT account to reconnect.');
    const draft: ProviderConfig = { id: 'chatgpt', kind: 'chatgpt', label: 'ChatGPT', enabled: true, local: false, baseUrl: services.chatGPT?.apiBaseUrl ?? 'https://api.openai.com/v1' };
    const models = await createProvider(draft, { getChatGPTAccessToken: async () => credentials.accessToken, ...(services.chatGPT?.fetch ? { fetch: services.chatGPT.fetch } : {}) }).listModels(attempt.controller.signal);
    if (attempt.controller.signal.aborted || closing) throw new NeoError('cancelled', 'ChatGPT sign-in was cancelled.');
    // Identity is issuer + issued client id + sub. Match it only from encrypted credentials.
    const existing = services.providerConfigs.list();
    const previous = attempt.providerId ? services.providerConfigs.get(attempt.providerId) : existing.find(config => {
      const saved = config.kind === 'chatgpt' && readChatGPTCredentials(services.secrets, config.id);
      return saved && saved.clientId === credentials.clientId && saved.sub === credentials.sub;
    }) ?? null;
    if (attempt.providerId && (!previous || previous.kind !== 'chatgpt')) throw new NeoError('conflict', 'This ChatGPT connection was removed. Start sign-in again.');
    const currentCredentials = previous && readChatGPTCredentials(services.secrets, previous.id);
    if (attempt.previous && (!currentCredentials || currentCredentials.clientId !== attempt.previous.clientId || currentCredentials.sub !== attempt.previous.sub)) {
      throw new NeoError('conflict', 'This ChatGPT connection changed. Start sign-in again.');
    }
    const id = previous?.id ?? deriveProviderId('chatgpt', [...services.config.providers, ...existing]);
    const config = { ...draft, id };
    const capabilities = pickDefaultCapabilities(config, models);
    if (!capabilities.text) throw new NeoError('provider_error', 'ChatGPT did not offer a text model. Try signing in again later.');
    const current = services.settings.get().ai;
    const ai = current.mode === 'simple' ? { mode: 'simple' as const, capabilities, search: current.search } : undefined;
    const secretName = chatGPTSecretName(id);
    const oldSecret = services.secrets.get(secretName);
    try {
      const commit = () => {
        services.chatGPTTokens?.credentialsChanged(id);
        services.secrets.set(secretName, JSON.stringify(credentials));
        return saveProvider(services, { ...config, defaultModel: capabilities.text!.model }, undefined, previous, ai);
      };
      const saved = services.db ? services.db.transaction(commit) : commit();
      const provider = providerView(saved, services.secrets);
      attempt.result = { status: 'connected', provider };
      services.events.publish({ type: 'provider.connected', provider, state: attempt.state });
    } catch {
      if (oldSecret === undefined) services.secrets.delete(secretName);
      else services.secrets.set(secretName, oldSecret);
      throw new NeoError('provider_error', 'The ChatGPT connection could not be saved. Try again.');
    }
  }

  app.post('/api/auth/chatgpt/start', ownerOnly(), async (c) => {
    if (services.config.mode !== 'local') throw new NeoError('forbidden', 'Available when NEO runs on this computer; use an API key or OpenRouter on a remote server.');
    prune();
    if (closing || attempts.size >= 100) throw new NeoError('rate_limited', 'Too many pending sign-ins. Cancel one or try again later.');
    let body: unknown = {};
    const ct = c.req.header('content-type');
    const mediaType = ct ? ct.split(';')[0]!.trim().toLowerCase() : '';
    if (mediaType === 'application/json') body = await c.req.json().catch(() => { throw new NeoError('bad_request', 'Invalid ChatGPT sign-in request.'); });
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'providerId')) throw new NeoError('bad_request', 'Invalid ChatGPT sign-in request.');
    const providerId = 'providerId' in body ? body.providerId : undefined;
    if (providerId !== undefined && (typeof providerId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(providerId))) throw new NeoError('bad_request', 'Invalid ChatGPT provider id.');
    const config = typeof providerId === 'string' ? services.providerConfigs.get(providerId) : services.providerConfigs.list().find(config => config.kind === 'chatgpt');
    if (providerId && config?.kind !== 'chatgpt') throw new NeoError('not_found', 'ChatGPT provider not found.');
    const previous = config ? readChatGPTCredentials(services.secrets, config.id) : undefined;
    const hostId = services.secrets.get('chatgpt:host-id') ?? randomBytes(32).toString('base64url');
    services.secrets.set('chatgpt:host-id', hostId);
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const controller = new AbortController();
    let attempt: Attempt;
    const server = createServer((req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      let url: URL;
      try { url = new URL(req.url ?? '/', attempt.redirectUri); }
      catch { res.statusCode = 400; res.end(FAILURE_HTML); return; }
      if (req.method !== 'GET' || url.pathname !== '/callback') { res.statusCode = 404; res.end(FAILURE_HTML); return; }
      if (attempt.expiresAt <= services.clock()) cancel(attempt, true);
      // Re-authorisation launches here so id_token_hint is sent only to the browser, never in API JSON.
      if (url.searchParams.get('launch') === state && previous && !attempt.launched && !attempt.consumed) {
        attempt.launched = true;
        res.statusCode = 302;
        res.setHeader('Location', attempt.authorizationUrl);
        res.end();
        return;
      }
      if (attempt.consumed || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== state) { res.statusCode = 400; res.end(FAILURE_HTML); return; }
      // Single use, including failed callbacks; consume synchronously before token exchange.
      attempt.consumed = true;
      const completing = (async () => {
        try {
          if (url.searchParams.has('error')) throw new NeoError('provider_auth', 'ChatGPT sign-in was not authorised. Start again in NEO.');
          await connect(attempt, url.searchParams);
          res.end(SUCCESS_HTML);
        } catch (error) {
          const neo = error instanceof NeoError ? error : new NeoError('provider_error', 'ChatGPT sign-in could not be completed. Try again.');
          const reason = neo.details && typeof neo.details === 'object' && 'reason' in neo.details ? neo.details.reason : undefined;
          if (attempt.providerId && attempt.previous && (reason === 'subscription_sharing_invalid_user' || reason === 'invalid_grant')) {
            services.chatGPTTokens?.markNeedsReauthorization(attempt.providerId, attempt.previous.accessToken);
          }
          if (attempt.result.status === 'waiting') attempt.result = { status: 'failed', error: neo.toJSON() };
          res.statusCode = neo.status;
          res.end(FAILURE_HTML);
        } finally { stopListener(attempt); }
      })();
      active.add(completing);
      void completing.finally(() => active.delete(completing));
    });
    server.requestTimeout = 15_000;
    server.headersTimeout = 15_000;
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    } catch {
      server.close();
      throw new NeoError('provider_error', 'Could not start the local ChatGPT sign-in listener. Try again.');
    }
    if (closing) {
      server.close();
      server.closeAllConnections();
      throw new NeoError('cancelled', 'NEO closed before ChatGPT sign-in could start.');
    }
    const redirectUri = `http://127.0.0.1:${(server.address() as { port: number }).port}/callback`;
    let authorizationUrl: string;
    try { authorizationUrl = createChatGPTAuthorization({ hostId, state, nonce, verifier, redirectUri, ...(previous ? { previous } : {}) }, services.chatGPT); }
    catch {
      server.close();
      throw new NeoError('config_error', 'ChatGPT sign-in configuration is invalid.');
    }
    const expiresAt = services.clock() + TTL_MS;
    const timer = setTimeout(() => cancel(attempt, true), services.chatGPT?.timeoutMs ?? TTL_MS);
    timer.unref();
    attempt = { state, nonce, verifier, hostId, expiresAt, redirectUri, authorizationUrl, ...(previous ? { previous } : {}), ...(config ? { providerId: config.id } : {}), server, timer, controller, consumed: false, launched: false, result: { status: 'waiting' } };
    attempts.set(state, attempt);
    c.header('Cache-Control', 'no-store');
    return c.json({ url: previous ? `${redirectUri}?${new URLSearchParams({ launch: state })}` : authorizationUrl, state, expiresAt });
  });

  app.get('/api/auth/chatgpt/status', ownerOnly(), (c) => {
    prune();
    const attempt = attempts.get(c.req.query('state') ?? '');
    c.header('Cache-Control', 'no-store');
    if (!attempt) throw new NeoError('not_found', 'ChatGPT sign-in attempt not found. Start again.');
    return c.json(attempt.result);
  });
  app.post('/api/auth/chatgpt/cancel', ownerOnly(), async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object' || !('state' in body) || typeof body.state !== 'string') throw new NeoError('bad_request', 'Invalid ChatGPT sign-in state.');
    prune();
    const attempt = attempts.get(body.state);
    return c.json({ cancelled: attempt ? cancel(attempt) : false });
  });
}
