import { toPaise } from '@seal/shared';
import { db } from './db.js';
import { verifyChain } from './audit.js';

/**
 * The scoring criteria, computed from the audit chain rather than asserted on a
 * slide. Every number here is derivable from data the system already had to
 * keep, which is the point of putting everything in one chain.
 */
export function metrics() {
  const count = (sql: string, ...args: unknown[]) =>
    (db.prepare(sql).get(...(args as never[])) as { n: number }).n;

  const executed = count(`SELECT COUNT(*) AS n FROM escrows WHERE state = 'EXECUTED'`);
  const expired = count(`SELECT COUNT(*) AS n FROM escrows WHERE state = 'EXPIRED'`);
  const rejected = count(`SELECT COUNT(*) AS n FROM escrows WHERE state = 'REJECTED'`);
  const pending = count(`SELECT COUNT(*) AS n FROM escrows WHERE state = 'PENDING_QUORUM'`);

  // Every attempt that never became a valid authorization.
  const blocked = count(
    `SELECT COUNT(*) AS n FROM audit_chain
     WHERE type IN ('INTENT_VERIFY_FAILED','PAYMENT_REFUSED','ATTACK_BLOCKED','APPROVAL_REJECTED')`,
  );
  const blockedAtRail = count(
    `SELECT COUNT(*) AS n FROM audit_chain WHERE type = 'ATTACK_BLOCKED'`,
  );

  // Signature -> execution, per transaction, from the chain itself.
  const durations = (
    db
      .prepare(
        `SELECT s.txn_id AS txn_id,
                (julianday(x.at) - julianday(s.at)) * 86400.0 AS secs
         FROM audit_chain s
         JOIN audit_chain x ON x.txn_id = s.txn_id AND x.type = 'EXECUTED'
         WHERE s.type = 'INTENT_SIGNED'`,
      )
      .all() as unknown as Array<{ txn_id: string; secs: number }>
  ).map((r) => r.secs);

  durations.sort((a, b) => a - b);
  const median =
    durations.length === 0
      ? null
      : durations.length % 2
        ? durations[(durations.length - 1) / 2]
        : (durations[durations.length / 2 - 1] + durations[durations.length / 2]) / 2;

  const preventedRows = db
    .prepare(
      `SELECT json_extract(i.intent_json, '$.amount.value') AS value
       FROM escrows e JOIN intents i ON i.txn_id = e.txn_id
       WHERE e.state IN ('EXPIRED','REJECTED')`,
    )
    .all() as unknown as Array<{ value: string }>;
  const preventedPaise = preventedRows.reduce((s, r) => s + toPaise(r.value ?? '0'), 0n);

  const settledRows = db
    .prepare(
      `SELECT json_extract(i.intent_json, '$.amount.value') AS value
       FROM escrows e JOIN intents i ON i.txn_id = e.txn_id
       WHERE e.state = 'EXECUTED'`,
    )
    .all() as unknown as Array<{ value: string }>;
  const settledPaise = settledRows.reduce((s, r) => s + toPaise(r.value ?? '0'), 0n);

  const closed = executed + expired + rejected;
  const chain = verifyChain();
  // Completeness = accepted transactions that have an unbroken chain behind
  // them. Counting distinct txn_ids in the chain would overcount: rejected and
  // forged attempts are chained too, and they never became transactions.
  const chainedTxns = count(
    `SELECT COUNT(*) AS n FROM intents i
     WHERE EXISTS (SELECT 1 FROM audit_chain a WHERE a.txn_id = i.txn_id)`,
  );
  const totalTxns = count(`SELECT COUNT(*) AS n FROM intents`);

  return {
    escrows: { executed, expired, rejected, pending, total: closed + pending },
    attack_block: { blocked_attempts: blocked, blocked_at_rail: blockedAtRail },
    legitimate_success_rate: closed === 0 ? null : +((executed / closed) * 100).toFixed(1),
    median_verification_seconds: median === null ? null : +median.toFixed(1),
    prevented_value: paiseToDecimal(preventedPaise),
    settled_value: paiseToDecimal(settledPaise),
    audit: {
      chain_ok: chain.ok,
      entries: chain.entries_checked,
      break_at_seq: chain.break_at_seq,
      completeness_pct: totalTxns === 0 ? 100 : +((chainedTxns / totalTxns) * 100).toFixed(1),
    },
  };
}

function paiseToDecimal(p: bigint): string {
  const sign = p < 0n ? '-' : '';
  const abs = p < 0n ? -p : p;
  return `${sign}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}
