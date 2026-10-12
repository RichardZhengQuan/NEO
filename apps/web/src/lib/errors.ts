/**
 * Turning thrown values into short, human messages for toasts and inline errors.
 */
import { NeoError } from '@neo/protocol';
import type { TranslateFn } from '@neo/ui';

export function errorCode(err: unknown): string | null {
  if (err instanceof NeoError) return err.code;
  if (typeof err === 'object' && err !== null && 'code' in err && typeof (err as { code: unknown }).code === 'string') return (err as { code: string }).code;
  return null;
}

export function httpStatus(err: unknown): number | null {
  if (typeof err === 'object' && err !== null && 'httpStatus' in err && typeof (err as { httpStatus: unknown }).httpStatus === 'number') {
    return (err as { httpStatus: number }).httpStatus;
  }
  return null;
}

/** True when the request never reached the server (offline, DNS, CORS, timeout). */
export function isNetworkError(err: unknown): boolean {
  const status = httpStatus(err);
  if (status === 0) return true;
  if (err instanceof TypeError) return true;
  const code = errorCode(err);
  return code === 'timeout' || (err instanceof NeoError && err.message === 'Failed to fetch');
}

export function errorMessage(err: unknown, t: TranslateFn): string {
  if (isNetworkError(err)) return t('error.network');
  const details = typeof err === 'object' && err !== null && 'details' in err ? err.details : undefined;
  const reason = typeof details === 'object' && details !== null && 'reason' in details ? details.reason : undefined;
  switch (reason) {
    case 'subscription_sharing_usage_limit_exceeded': return t('provider.chatgpt_limit');
    case 'subscription_sharing_usage_unavailable': return t('provider.chatgpt_unavailable');
    case 'subscription_sharing_user_not_eligible': return t('provider.chatgpt_ineligible');
    case 'subscription_sharing_invalid_user':
    case 'invalid_grant': return t('provider.chatgpt_disconnected');
    default: break;
  }
  const code = errorCode(err);
  switch (code) {
    case 'no_provider':
      return t('chat.connect_ai');
    case 'unauthorized':
      return t('error.unauthorized');
    case 'rate_limited':
      return t('error.rate_limited');
    case 'provider_auth':
      return t('error.provider_auth');
    case 'config_error':
      return err instanceof Error && err.message ? err.message : t('error.config');
    default:
      break;
  }
  if (err instanceof Error && err.message) return err.message;
  return t('common.error');
}
