import type { AuditEntry, AuditType, ChainVerification } from '@seal/shared';
import { db } from './db.js';
import { sha256Sync } from './hash.js';
import { canonicalize } from '@seal/shared';

const GENESIS = '0'.repeat(64);

/**
 * entry_hash = SHA256(JCS({ seq, txn_id, type, at, actor, payload, prev_hash }))
 * prev_hash  = entry_hash of seq-1
 *
 * Any retroactive edit changes that entry's hash, which no longer matches the
 * prev_hash stored in the next entry -- so the break is detectable *and* its
 * position is pinpointed. There is no transition anywhere in this system that
 * deletes a row from this table.
 */
export interface AppendInput {
  txn_id?: string | null;
  type: AuditType;
  actor?: string | null;
  payload: Record<string, unknown>;
}

const insertStmt = db.prepare(
  `INSERT INTO audit_chain (seq, txn_id, type, at, actor, payload_json, prev_hash, entry_hash)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);
const headStmt = db.prepare(`SELECT seq, entry_hash FROM audit_chain ORDER BY seq DESC LIMIT 1`);

export function appendAudit(input: AppendInput): AuditEntry {
  const head = headStmt.get() as { seq: number; entry_hash: string } | undefined;
  const seq = (head?.seq ?? 0) + 1;
  const prev_hash = head?.entry_hash ?? GENESIS;
  const at = new Date().toISOString();
  const txn_id = input.txn_id ?? null;
  const actor = input.actor ?? null;

  const entry_hash = computeEntryHash({
    seq,
    txn_id,
    type: input.type,
    at,
    actor,
    payload: input.payload,
    prev_hash,
  });

  insertStmt.run(
    seq,
    txn_id,
    input.type,
    at,
    actor,
    JSON.stringify(input.payload),
    prev_hash,
    entry_hash,
  );

  return { seq, txn_id, type: input.type, at, actor, payload: input.payload, prev_hash, entry_hash };
}

function computeEntryHash(e: Omit<AuditEntry, 'entry_hash'>): string {
  return sha256Sync(
    canonicalize({
      seq: e.seq,
      txn_id: e.txn_id,
      type: e.type,
      at: e.at,
      actor: e.actor,
      payload: e.payload,
      prev_hash: e.prev_hash,
    }),
  );
}

interface Row {
  seq: number;
  txn_id: string | null;
  type: AuditType;
  at: string;
  actor: string | null;
  payload_json: string;
  prev_hash: string;
  entry_hash: string;
}

function toEntry(r: Row): AuditEntry {
  return {
    seq: r.seq,
    txn_id: r.txn_id,
    type: r.type,
    at: r.at,
    actor: r.actor,
    payload: JSON.parse(r.payload_json),
    prev_hash: r.prev_hash,
    entry_hash: r.entry_hash,
  };
}

export function chainForTxn(txn_id: string): AuditEntry[] {
  const rows = db
    .prepare(`SELECT * FROM audit_chain WHERE txn_id = ? ORDER BY seq ASC`)
    .all(txn_id) as unknown as Row[];
  return rows.map(toEntry);
}

export function recentChain(limit = 200): AuditEntry[] {
  const rows = db
    .prepare(`SELECT * FROM audit_chain ORDER BY seq DESC LIMIT ?`)
    .all(limit) as unknown as Row[];
  return rows.map(toEntry).reverse();
}

/**
 * Replay the *whole* chain, not just this transaction's slice. Verifying only
 * one transaction's entries would miss an insertion or deletion elsewhere, and
 * the point of a chain is that it is global.
 */
export function verifyChain(): ChainVerification {
  const rows = db.prepare(`SELECT * FROM audit_chain ORDER BY seq ASC`).all() as unknown as Row[];
  let prev = GENESIS;
  let expectedSeq = 1;

  for (const r of rows) {
    if (r.seq !== expectedSeq) {
      return {
        ok: false,
        entries_checked: expectedSeq - 1,
        break_at_seq: r.seq,
        reason: `sequence gap: expected ${expectedSeq}, found ${r.seq}`,
      };
    }
    if (r.prev_hash !== prev) {
      return {
        ok: false,
        entries_checked: expectedSeq - 1,
        break_at_seq: r.seq,
        reason: 'prev_hash does not match the previous entry hash',
      };
    }
    const recomputed = computeEntryHash(toEntry(r));
    if (recomputed !== r.entry_hash) {
      return {
        ok: false,
        entries_checked: expectedSeq - 1,
        break_at_seq: r.seq,
        reason: 'entry contents do not hash to the stored entry_hash',
      };
    }
    prev = r.entry_hash;
    expectedSeq++;
  }

  return { ok: true, entries_checked: rows.length, break_at_seq: null, reason: null };
}
