import { createHash, randomBytes } from 'node:crypto';
import { canonicalize } from '@seal/shared';

/**
 * Synchronous SHA-256. The audit chain must be appended inside one synchronous
 * SQLite transaction -- an `await` in the middle would let a second append
 * interleave and read a stale `prev_hash`. WebCrypto's digest is async, so the
 * chain uses node:crypto instead.
 */
export function sha256Sync(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function hashCanonical(value: unknown): string {
  return sha256Sync(canonicalize(value));
}

export function randomId(prefix: string, bytes = 4): string {
  return `${prefix}-${randomBytes(bytes).toString('hex')}`;
}

export function randomToken(): string {
  return randomBytes(24).toString('hex');
}
