import { randomHex } from './bytes.js';
import type { Role, TransactionIntent } from './types.js';

export interface DraftIntent {
  org_id: string;
  type: TransactionIntent['type'];
  payee: TransactionIntent['payee'];
  amount: TransactionIntent['amount'];
  purpose: string;
  deadline: string;
  originator: { user_id: string; role: Role };
  /** Digest of the file this payment was raised from, if any. */
  media_sha256?: string;
  /** Validity of the *signature*, not of the payment. Default 90 minutes. */
  validityMinutes?: number;
}

export function buildIntent(draft: DraftIntent, now = new Date()): TransactionIntent {
  const validity = (draft.validityMinutes ?? 90) * 60_000;
  return {
    v: 1,
    txn_id: `TX-${randomHex(3).toUpperCase()}`,
    org_id: draft.org_id,
    type: draft.type,
    payee: draft.payee,
    amount: draft.amount,
    purpose: draft.purpose,
    deadline: draft.deadline,
    originator: draft.originator,
    media_sha256: draft.media_sha256,
    nonce: randomHex(8),
    iat: now.toISOString(),
    exp: new Date(now.getTime() + validity).toISOString(),
  };
}
