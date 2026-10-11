/** Single-use pairing codes, scoped to one HTTP app and held only as hashes. */
import { createHash } from 'node:crypto';
import { MAX_ACTIVE_PAIRING_CODES, PAIRING_CODE_TTL_MS, newId, randomToken } from '@neo/protocol';
import type { Clock, PairingSession } from '@neo/protocol';

export class PairingService {
  private readonly _codes = new Map<string, { id: string; expiresAt: number }>();

  constructor(private readonly clock: Clock) {}

  create(): Omit<PairingSession, 'pairingUrl'> {
    const now = this.clock();
    this.prune(now);
    const code = randomToken(24);
    const id = newId('pair', now);
    const expiresAt = now + PAIRING_CODE_TTL_MS;
    this._codes.set(this.hash(code), { id, expiresAt });
    if (this._codes.size > MAX_ACTIVE_PAIRING_CODES) {
      this._codes.delete(this._codes.keys().next().value!);
    }
    return { id, code, expiresAt };
  }

  cancel(id: string): boolean {
    this.prune(this.clock());
    for (const [hash, entry] of this._codes) {
      if (entry.id === id) return this._codes.delete(hash);
    }
    return false;
  }

  claim(code: string): { id: string } | null {
    this.prune(this.clock());
    const hash = this.hash(code);
    const entry = this._codes.get(hash);
    if (!entry) return null;
    this._codes.delete(hash);
    return { id: entry.id };
  }

  private hash(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }

  private prune(now: number): void {
    for (const [hash, entry] of this._codes) {
      if (entry.expiresAt <= now) this._codes.delete(hash);
    }
  }
}
