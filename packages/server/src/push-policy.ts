import { NeoError } from '@neo/protocol';

/** Trusted browser push services. Wildcards match subdomains only. */
export const PUSH_ALLOWED_HOSTS = Object.freeze([
  'fcm.googleapis.com', '*.googleapis.com', 'updates.push.services.mozilla.com',
  '*.push.apple.com', 'web.push.apple.com', '*.notify.windows.com',
]);

/** Explicit administrator additions use hostnames, never URLs or arbitrary patterns. */
export function validatePushAllowedHosts(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(host => typeof host !== 'string' ||
    !/^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(host))) {
    throw new NeoError('config_error', 'push.allowedHosts must be an array of hostnames (optional *. prefix)');
  }
  return value.map(host => (host as string).toLowerCase());
}
function matches(host: string, pattern: string): boolean {
  return pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1 : host === pattern;
}

export function isAllowedPushEndpoint(endpoint: string, allowedHosts: readonly string[] = []): boolean {
  let url: URL;
  try { url = new URL(endpoint); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false;
  const host = url.hostname.toLowerCase();
  if (allowedHosts.some(pattern => matches(host, pattern))) return true;
  if (!PUSH_ALLOWED_HOSTS.some(pattern => matches(host, pattern))) return false;
  // Other Google API hosts must expose a known push path, not arbitrary APIs.
  if (host.endsWith('.googleapis.com') && host !== 'fcm.googleapis.com') {
    return /^\/(?:gcm|fcm|wp|wpush|push)(?:\/|$)/.test(url.pathname);
  }
  return true;
}

export function pushAllowedHosts(config: { push: object }): string[] {
  const push = config.push as { allowedHosts?: unknown };
  return push.allowedHosts === undefined ? [] : validatePushAllowedHosts(push.allowedHosts);
}
