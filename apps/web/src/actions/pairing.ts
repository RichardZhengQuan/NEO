/**
 * Exchange a pairing link and switch sessions only after the new server works.
 */
import { parsePairingLink } from '@neo/protocol';
import { claimPairingCode, consumePairingLink, normalizeServerUrl, verifyCredentials } from '../connection.js';
import { httpStatus } from '../lib/errors.js';
import { currentSessionEpoch, isCurrentSession } from '../state/session.js';
import { connectWith } from './session.js';

export type PairOutcome = 'ok' | 'bad-link' | 'invalid' | 'rate-limited' | 'unreachable' | 'duplicate';

export async function pairWithLink(url: string): Promise<PairOutcome> {
  const link = parsePairingLink(url);
  if (!link) return 'bad-link';
  const serverUrl = link.serverUrl ? normalizeServerUrl(link.serverUrl) : null;
  if (!serverUrl) return 'unreachable';
  if (!consumePairingLink(link)) return 'duplicate';
  const epoch = currentSessionEpoch();
  let token: string;
  if (link.version === 1) {
    const result = await verifyCredentials(serverUrl, link.token);
    if (result !== 'ok') return result === 'unauthorized' ? 'invalid' : 'unreachable';
    token = link.token;
  } else {
    const result = await claimPairingCode(serverUrl, link.code);
    if (result.kind !== 'ok') return result.kind;
    token = result.token;
  }
  if (!isCurrentSession(epoch)) return 'unreachable';
  try {
    await connectWith(serverUrl, token, 'pair', { preserveSessionOnFailure: true });
    return 'ok';
  } catch (err) {
    const status = httpStatus(err);
    if (status === 429) return 'rate-limited';
    if (status === 400 || status === 401 || status === 403 || status === 404) return 'invalid';
    return 'unreachable';
  }
}

/** The UI uses the same messages for scans, pasted links and deep links. */
export function pairingOutcomeKey(outcome: PairOutcome): string {
  switch (outcome) {
    case 'ok': return 'pairing.ok';
    case 'bad-link': return 'pairing.bad_link';
    case 'invalid': return 'pairing.invalid';
    case 'rate-limited': return 'pairing.rate_limited';
    case 'unreachable': return 'pairing.unreachable';
    case 'duplicate': return 'pairing.duplicate';
  }
}
