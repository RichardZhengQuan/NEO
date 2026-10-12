import { createHash, createPublicKey, verify, type JsonWebKey } from 'node:crypto';
import { NeoError, chatgptSubscriptionError, type SecretStore } from '@neo/protocol';

export const CHATGPT_ISSUER = 'https://auth.openai.com';
export const CHATGPT_RESOURCE = 'https://api.openai.com/v1';
export const CHATGPT_SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';

export interface ChatGPTAuthOptions {
  authorizationUrl?: string;
  tokenUrl?: string;
  jwksUrl?: string;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface ChatGPTCredentials {
  clientId: string;
  sub: string;
  idToken: string;
  accessToken: string;
  refreshToken: string;
  scopes: string[];
  hostId: string;
  expiresAt: number;
  earliestRefreshAt: number;
  needsReauthorization?: boolean;
}

export type ChatGPTTokenManager = ReturnType<typeof createChatGPTTokenManager>;

export const chatGPTSecretName = (id: string) => `provider:${id}:chatgpt`;

export function readChatGPTCredentials(secrets: SecretStore, id: string): ChatGPTCredentials | undefined {
  const raw = secrets.get(chatGPTSecretName(id));
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isObject(value) || !isClientId(value['clientId'])) return undefined;
    for (const key of ['sub', 'idToken', 'accessToken', 'refreshToken', 'hostId']) if (!isString(value[key])) return undefined;
    if (!Array.isArray(value['scopes']) || !value['scopes'].every(isString)) return undefined;
    if (!isNumber(value['expiresAt']) || !isNumber(value['earliestRefreshAt'])) return undefined;
    if (value['needsReauthorization'] !== undefined && typeof value['needsReauthorization'] !== 'boolean') return undefined;
    return value as unknown as ChatGPTCredentials;
  } catch { return undefined; }
}

/** Dynamic registration currently returns its issued client ID in the callback's client_id query parameter. */
export function parseIssuedClientId(params: URLSearchParams): string {
  const value = params.get('client_id');
  if (params.getAll('client_id').length !== 1 || !isClientId(value)) throw new NeoError('provider_auth', 'ChatGPT did not return a valid app identity. Start sign-in again.');
  return value;
}

export function createChatGPTAuthorization(input: {
  hostId: string; state: string; nonce: string; verifier: string; redirectUri: string; previous?: ChatGPTCredentials;
}, options: ChatGPTAuthOptions = {}): string {
  validateRedirectUri(input.redirectUri);
  const url = new URL(options.authorizationUrl ?? `${CHATGPT_ISSUER}/api/accounts/authorize`);
  url.search = new URLSearchParams({
    client_id: input.previous?.clientId ?? 'dynamic_agent_client', response_type: 'code', scope: CHATGPT_SCOPES,
    resource: CHATGPT_RESOURCE, ext_agent_host_id: input.hostId, state: input.state, nonce: input.nonce,
    code_challenge_method: 'S256', code_challenge: createHash('sha256').update(input.verifier).digest('base64url'),
    redirect_uri: input.redirectUri,
    ...(input.previous ? { id_token_hint: input.previous.idToken } : { agent_name_hint: 'NEO' }),
  }).toString();
  return url.href;
}

export async function exchangeChatGPTCode(input: {
  code: string; clientId: string; verifier: string; redirectUri: string; nonce: string; hostId: string; signal?: AbortSignal;
}, options: ChatGPTAuthOptions = {}, clock: () => number = Date.now): Promise<ChatGPTCredentials> {
  validateRedirectUri(input.redirectUri);
  if (!isClientId(input.clientId)) throw new NeoError('provider_auth', 'ChatGPT did not return a valid app identity. Start sign-in again.');
  const result = await tokenRequest({
    grant_type: 'authorization_code', client_id: input.clientId, code: input.code, code_verifier: input.verifier,
    redirect_uri: input.redirectUri, resource: CHATGPT_RESOURCE,
  }, options, input.signal);
  const tokens = parseTokenResponse(result, clock());
  if (!tokens.idToken) throw invalidIdToken();
  const claims = await validateIdToken(tokens.idToken, input.clientId, options, clock, { nonce: input.nonce, signal: input.signal });
  return { ...tokens, idToken: tokens.idToken, clientId: input.clientId, sub: claims.sub, hostId: input.hostId };
}

/** Access tokens refresh on demand; concurrent model/list requests share one rotating refresh. */
export function createChatGPTTokenManager(secrets: SecretStore, options: ChatGPTAuthOptions = {}, clock: () => number = Date.now) {
  const active = new Map<string, { promise: Promise<string>; controller: AbortController }>();
  const generations = new Map<string, number>();
  let closed = false;
  const invalidate = (id: string) => {
    generations.set(id, (generations.get(id) ?? 0) + 1);
    active.get(id)?.controller.abort();
  };
  const markNeedsReauthorization = (id: string, expectedAccessToken?: string) => {
    const credentials = readChatGPTCredentials(secrets, id);
    if (expectedAccessToken !== undefined && credentials?.accessToken !== expectedAccessToken) return;
    invalidate(id);
    if (credentials) secrets.set(chatGPTSecretName(id), JSON.stringify({ ...credentials, needsReauthorization: true }));
  };
  async function refresh(id: string, previous: ChatGPTCredentials, generation: number, signal: AbortSignal): Promise<string> {
    try {
      const result = await tokenRequest({ grant_type: 'refresh_token', client_id: previous.clientId, refresh_token: previous.refreshToken, resource: CHATGPT_RESOURCE }, options, signal);
      const tokens = parseTokenResponse(result, clock());
      if (tokens.idToken) await validateIdToken(tokens.idToken, previous.clientId, options, clock, { sub: previous.sub, signal });
      const current = readChatGPTCredentials(secrets, id);
      // Disconnect and a new sign-in must win over an older refresh still completing.
      if (closed || generations.get(id) !== generation || current?.refreshToken !== previous.refreshToken || current.needsReauthorization) throw chatgptSubscriptionError('invalid_grant');
      const credentials: ChatGPTCredentials = { ...previous, ...tokens, idToken: tokens.idToken ?? previous.idToken, needsReauthorization: false };
      secrets.set(chatGPTSecretName(id), JSON.stringify(credentials));
      return credentials.accessToken;
    } catch (error) {
      if (error instanceof NeoError && isObject(error.details) && ['invalid_grant', 'subscription_sharing_invalid_user'].includes(String(error.details['reason']))) {
        if (!closed && generations.get(id) === generation && readChatGPTCredentials(secrets, id)?.refreshToken === previous.refreshToken) markNeedsReauthorization(id);
      }
      throw error;
    }
  }
  return {
    async accessToken(id: string): Promise<string> {
      if (closed) throw new NeoError('cancelled', 'ChatGPT connection is closed.');
      const credentials = readChatGPTCredentials(secrets, id);
      if (!credentials || credentials.needsReauthorization) throw chatgptSubscriptionError('invalid_grant');
      const now = clock();
      if (credentials.expiresAt > now + 60_000 || (credentials.expiresAt > now && now < credentials.earliestRefreshAt)) return credentials.accessToken;
      if (now < credentials.earliestRefreshAt) throw chatgptSubscriptionError('subscription_sharing_usage_unavailable');
      const pending = active.get(id);
      if (pending) return pending.promise;
      const generation = generations.get(id) ?? 0;
      generations.set(id, generation);
      const controller = new AbortController();
      const promise = refresh(id, credentials, generation, controller.signal).finally(() => {
        if (active.get(id)?.controller === controller) active.delete(id);
      });
      active.set(id, { promise, controller });
      return promise;
    },
    markNeedsReauthorization,
    credentialsChanged(id: string): void { invalidate(id); },
    disconnect(id: string): void { invalidate(id); secrets.delete(chatGPTSecretName(id)); },
    async close(): Promise<void> {
      closed = true;
      for (const { controller } of active.values()) controller.abort();
      await Promise.allSettled([...active.values()].map(({ promise }) => promise));
    },
  };
}

async function tokenRequest(body: Record<string, string>, options: ChatGPTAuthOptions, signal?: AbortSignal): Promise<unknown> {
  const response = await authFetch(options.tokenUrl ?? `${CHATGPT_ISSUER}/api/accounts/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body),
  }, options, signal);
  const result: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = isObject(result) ? result['error'] : undefined;
    const reason = typeof error === 'string' ? error : isObject(error) ? error['code'] : undefined;
    throw chatgptSubscriptionError(typeof reason === 'string' ? reason : '', response.status);
  }
  return result;
}

function parseTokenResponse(result: unknown, now: number): Omit<ChatGPTCredentials, 'clientId' | 'sub' | 'hostId' | 'idToken'> & { idToken?: string } {
  if (!isObject(result) || !isString(result['access_token']) || !isString(result['refresh_token']) || !isNumber(result['expires_in']) || result['expires_in'] <= 0 || String(result['token_type']).toLowerCase() !== 'bearer' || !isString(result['scope'])) {
    throw new NeoError('provider_error', 'ChatGPT returned an invalid token response. Start sign-in again.');
  }
  const scopes = result['scope'].split(/\s+/).filter(Boolean);
  if (!scopes.includes('resource.invoke') || !scopes.includes('chatgpt.tokens.use.direct')) throw new NeoError('provider_auth', 'ChatGPT did not grant access to your plan. Start sign-in again.');
  if (result['id_token'] !== undefined && !isString(result['id_token'])) throw invalidIdToken();
  const rawEarliest = result['earliest_refresh_at'];
  // OpenAI timestamps are absolute epoch seconds; accept ISO or milliseconds as well.
  const timestamp = typeof rawEarliest === 'number' ? rawEarliest : typeof rawEarliest === 'string' ? Number(rawEarliest) || Date.parse(rawEarliest) : NaN;
  if (!Number.isFinite(timestamp) || timestamp < 0) throw new NeoError('provider_error', 'ChatGPT returned an invalid refresh time. Start sign-in again.');
  return {
    accessToken: result['access_token'], refreshToken: result['refresh_token'], idToken: result['id_token'] as string | undefined,
    scopes, expiresAt: now + result['expires_in'] * 1000, earliestRefreshAt: timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000,
  };
}

async function validateIdToken(token: string, clientId: string, options: ChatGPTAuthOptions, clock: () => number, expected: { nonce?: string; sub?: string; signal?: AbortSignal }): Promise<{ sub: string }> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || token.length > 65_536 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) throw invalidIdToken();
    const header: unknown = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8'));
    const claims: unknown = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    if (!isObject(header) || header['alg'] !== 'RS256' || !isString(header['kid']) || !isObject(claims)) throw invalidIdToken();
    const response = await authFetch(options.jwksUrl ?? `${CHATGPT_ISSUER}/.well-known/jwks.json`, {}, options, expected.signal);
    const jwks: unknown = await response.json().catch(() => undefined);
    if (!response.ok || !isObject(jwks) || !Array.isArray(jwks['keys'])) throw invalidIdToken();
    const matches = jwks['keys'].filter(key => isObject(key) && key['kid'] === header['kid'] && key['kty'] === 'RSA' && (key['alg'] === undefined || key['alg'] === 'RS256') && (key['use'] === undefined || key['use'] === 'sig'));
    if (matches.length !== 1) throw invalidIdToken();
    const publicKey = createPublicKey({ key: matches[0] as JsonWebKey, format: 'jwk' });
    if (!verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2]!, 'base64url'))) throw invalidIdToken();
    const audiences = Array.isArray(claims['aud']) ? claims['aud'] : [claims['aud']];
    if (claims['iss'] !== CHATGPT_ISSUER || !audiences.includes(clientId) || !isNumber(claims['exp']) || claims['exp'] * 1000 <= clock() - 30_000 || !isString(claims['sub'])) throw invalidIdToken();
    if ((expected.nonce !== undefined && claims['nonce'] !== expected.nonce) || (expected.sub !== undefined && claims['sub'] !== expected.sub)) throw invalidIdToken();
    return { sub: claims['sub'] };
  } catch (error) {
    if (error instanceof NeoError) throw error;
    throw invalidIdToken();
  }
}

async function authFetch(url: string, init: RequestInit, options: ChatGPTAuthOptions, signal?: AbortSignal): Promise<Response> {
  try {
    return await (options.fetch ?? fetch)(url, { ...init, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? 15_000)]) : AbortSignal.timeout(options.timeoutMs ?? 15_000) });
  } catch {
    if (signal?.aborted) throw new NeoError('cancelled', 'ChatGPT sign-in was cancelled.');
    throw new NeoError('provider_error', 'Could not reach ChatGPT. Try again later.', { retryable: true });
  }
}

function validateRedirectUri(value: string): void {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/callback' || url.search || url.hash || url.username || url.password || url.href !== value) {
    throw new NeoError('config_error', 'ChatGPT sign-in needs a 127.0.0.1 loopback callback.');
  }
}
const invalidIdToken = () => new NeoError('provider_auth', 'ChatGPT could not validate your sign-in. Sign in again.', { details: { reason: 'invalid_id_token' } });
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isClientId = (value: unknown): value is string => typeof value === 'string' && /^oaiapp_[A-Za-z0-9_-]+$/.test(value) && value.length <= 256;
