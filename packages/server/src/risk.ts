import { DEVICE_ASSURANCE, POLICY, TIER_CONFIG, toPaise } from '@seal/shared';
import type { DeviceKind, RiskResult, RiskTier, TransactionIntent } from '@seal/shared';
import { db } from './db.js';

/**
 * Rules, not a model. Every score is explainable to an auditor and every rule
 * that fired is written into the escrow and into the audit chain.
 *
 * Urgency raises the score. It never shortens the clock -- manufactured time
 * pressure is the attacker's primary tool, so it is treated as a risk input,
 * never as a reason to relax the control.
 */
interface Rule {
  id: string;
  weight: number;
  why: string;
}

/**
 * Recent impersonation activity around a person.
 *
 * A denied caller challenge is the single strongest signal this system can
 * produce that an attack is in progress *right now*: someone was on a call
 * claiming to be this executive, and the executive said it was not them.
 */
export function impersonationSignal(userId: string, withinMs = 24 * 3600_000) {
  const since = new Date(Date.now() - withinMs).toISOString();
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN state = 'DENIED' THEN 1 ELSE 0 END) AS denied,
         SUM(CASE WHEN state = 'EXPIRED' THEN 1 ELSE 0 END) AS unanswered,
         SUM(CASE WHEN state = 'PENDING' THEN 1 ELSE 0 END) AS pending
       FROM caller_challenges
       WHERE claimed_user_id = ? AND created_at > ?`,
    )
    .get(userId, since) as {
    denied: number | null;
    unanswered: number | null;
    pending: number | null;
  };
  return { denied: row.denied ?? 0, unanswered: row.unanswered ?? 0, pending: row.pending ?? 0 };
}

export interface RiskInput {
  intent: TransactionIntent;
  deviceKind: DeviceKind;
  now?: Date;
}

export function scoreRisk({ intent, deviceKind, now = new Date() }: RiskInput): RiskResult {
  const fired: Rule[] = [];
  const notes: string[] = [];
  const amount = toPaise(intent.amount.value);

  const vendor = db
    .prepare(`SELECT * FROM vendor_master WHERE account = ? AND active = 1`)
    .get(intent.payee.account) as { name: string; ifsc: string } | undefined;

  if (!vendor) {
    fired.push({
      id: 'NEW_BENEFICIARY',
      weight: 35,
      why: 'Payee account is not in the verified vendor master',
    });
  } else if (vendor.ifsc !== intent.payee.ifsc) {
    fired.push({
      id: 'VENDOR_IFSC_CHANGED',
      weight: 30,
      why: `Vendor is known but the IFSC differs from the verified record (${vendor.ifsc})`,
    });
  }

  // Known vendor NAME paired with an unknown ACCOUNT is the classic
  // beneficiary-swap: the invoice looks familiar, the money does not go there.
  const nameMatch = db
    .prepare(`SELECT account FROM vendor_master WHERE lower(name) = lower(?) AND active = 1`)
    .all(intent.payee.name) as unknown as Array<{ account: string }>;
  if (nameMatch.length > 0 && !nameMatch.some((v) => v.account === intent.payee.account)) {
    fired.push({
      id: 'BENEFICIARY_ACCOUNT_SWAP',
      weight: 40,
      why: 'Vendor name matches the master but the account number does not',
    });
  }

  if (amount > toPaise(POLICY.LARGE_THRESHOLD)) {
    fired.push({ id: 'LARGE_AMOUNT', weight: 25, why: 'Above the large-payment threshold' });
  } else if (amount > toPaise(POLICY.MEDIUM_THRESHOLD)) {
    fired.push({ id: 'ABOVE_THRESHOLD', weight: 15, why: 'Above the single-approver threshold' });
  }

  const hour = now.getHours();
  const weekend = now.getDay() === 0 || now.getDay() === 6;
  const offHours = weekend || hour < POLICY.BUSINESS_HOURS.startHour || hour >= POLICY.BUSINESS_HOURS.endHour;
  if (offHours) {
    fired.push({ id: 'OFF_HOURS', weight: 15, why: 'Raised outside business hours' });
  }

  const hoursToDeadline = (Date.parse(intent.deadline) - now.getTime()) / 3_600_000;
  if (Number.isFinite(hoursToDeadline) && hoursToDeadline < 4) {
    fired.push({
      id: 'URGENT_DEADLINE',
      weight: 10,
      why: 'Deadline is under four hours away',
    });
    notes.push('Urgency raised the risk tier. It did not shorten the escrow window.');
  }

  // A payee that already had an escrow time out is the single best fraud
  // signal this system produces. Retrying against the clock costs the attacker.
  const priorExpiry = db
    .prepare(
      `SELECT COUNT(*) AS n FROM escrows e
       JOIN intents i ON i.txn_id = e.txn_id
       WHERE e.state = 'EXPIRED'
         AND json_extract(i.intent_json, '$.payee.account') = ?
         AND e.expires_at > datetime('now', '-1 day')`,
    )
    .get(intent.payee.account) as { n: number };
  if (priorExpiry.n > 0) {
    fired.push({
      id: 'RETRY_AFTER_EXPIRY',
      weight: 30,
      why: `${priorExpiry.n} escrow(s) to this account expired in the last 24h`,
    });
  }

  // Custody is priced, not assumed. A console-resident key is the weakest tier
  // and is barred outright for executives; an authenticator app is out of band
  // but still copyable software; a FIDO2 key cannot be exported at all and
  // needs a physical gesture, so it carries no premium.
  const assurance = DEVICE_ASSURANCE[deviceKind];
  if (assurance.riskPremium > 0) {
    fired.push({
      id: deviceKind === 'console' ? 'CONSOLE_RESIDENT_KEY' : 'SOFTWARE_BOUND_CREDENTIAL',
      weight: assurance.riskPremium,
      why: `Signed with a ${assurance.label}; no hardware user-presence proof`,
    });
    notes.push(
      deviceKind === 'authenticator'
        ? 'Signed out of band on the executive device. A hardware key would remove the remaining premium.'
        : 'Console-resident custody is the weakest tier available.',
    );
  } else {
    notes.push('Signed with a hardware-bound credential: the key cannot be exported or copied.');
  }

  // Someone has been impersonating this executive recently. That is a fact
  // about the world right now, not a property of this payment, and it should
  // colour every payment they originate until it is understood.
  const impersonation = impersonationSignal(intent.originator.user_id);
  if (impersonation.denied > 0) {
    fired.push({
      id: 'ACTIVE_IMPERSONATION',
      weight: 45,
      why: `${impersonation.denied} caller challenge(s) denied by this executive in the last 24h`,
    });
    notes.push(
      'This executive has told us, from their own device, that someone was impersonating them recently.',
    );
  } else if (impersonation.unanswered > 0) {
    fired.push({
      id: 'UNANSWERED_CALLER_CHALLENGE',
      weight: 20,
      why: `${impersonation.unanswered} caller challenge(s) went unanswered in the last 24h`,
    });
    notes.push('A caller claiming to be this executive was challenged and never answered.');
  }

  const score = Math.min(100, fired.reduce((s, r) => s + r.weight, 0));

  let tier: RiskTier =
    score >= 75 ? 'CRITICAL' : score >= 45 ? 'HIGH' : score >= 20 ? 'MEDIUM' : 'LOW';

  const has = (id: string) => fired.some((r) => r.id === id);

  // Hard floors that a score alone must never undercut.
  if (has('NEW_BENEFICIARY') || has('BENEFICIARY_ACCOUNT_SWAP') || has('VENDOR_IFSC_CHANGED')) {
    tier = rank(tier) < rank('HIGH') ? 'HIGH' : tier;
  }
  // A live impersonation outranks any score arithmetic.
  if (has('ACTIVE_IMPERSONATION')) {
    tier = 'CRITICAL';
    notes.push('Someone is impersonating this executive. No fast-track path exists.');
  }
  if ((has('NEW_BENEFICIARY') || has('BENEFICIARY_ACCOUNT_SWAP')) && has('LARGE_AMOUNT') && has('OFF_HOURS')) {
    tier = 'CRITICAL';
    notes.push('New beneficiary + large amount + off-hours: no fast-track path exists.');
  }

  const cfg = TIER_CONFIG[tier];
  if (tier === 'HIGH' || tier === 'CRITICAL') {
    notes.push(
      'Lane A: the executive signature required at this tier is already present by construction.',
    );
  }
  if (tier === 'CRITICAL') {
    notes.push('One approval must come from the treasury head.');
  }

  return {
    tier,
    score,
    rules_fired: fired.map((r) => r.id),
    required_approvals: cfg.approvals,
    window_minutes: cfg.windowMinutes,
    notes: [...notes, ...fired.map((r) => `${r.id}: ${r.why}`)],
  };
}

function rank(t: RiskTier): number {
  return { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 }[t];
}
