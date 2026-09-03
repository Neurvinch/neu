import { POLICY, approvalHash, canonicalize, envelopeDeviceKind, toPaise } from '@seal/shared';
import { verifyAnyEnvelope } from '@seal/shared/webauthn';
import type {
  ApprovalAssertion,
  ApprovalBundle,
  BankReceipt,
  EscrowView,
  SignatureEnvelope,
  TransactionIntent,
} from '@seal/shared';
import { CONFIG } from '../config.js';
import { appendAudit } from '../audit.js';
import { db, tx } from '../db.js';
import { broadcast } from '../events.js';
import { hashCanonical, randomId } from '../hash.js';
import { scoreRisk } from '../risk.js';
import { assertCustodyAllowed } from './enrollment.js';
import { bad, conflict, denied, missing } from './errors.js';
import {
  approvalRecords,
  approvalsFor,
  escrowForTxn,
  getCredential,
  getEscrowRow,
  getIntentRow,
  getUser,
  parseAssertion,
  parseIntent,
  parseSignature,
  type EscrowRow,
  type IntentRow,
  type UserRow,
} from './repo.js';

const ORIGINATOR_ROLES = new Set(['CFO', 'CEO', 'TREASURY']);
const APPROVER_ROLES = new Set(['CEO', 'CTO', 'TREASURY', 'CFO']);
const CLOCK_SKEW_MS = 60_000;

/* ===========================================================================
 * Stage 1 -- the executive signs the transaction
 * ========================================================================= */

export async function submitSignedIntent(params: {
  intent: TransactionIntent;
  signature: SignatureEnvelope;
  actorId: string;
}): Promise<{ txn_id: string; intent_hash: string }> {
  const { intent, signature } = params;
  const now = Date.now();

  const fail = (code: string, message: string): never => {
    // A rejected signature is evidence, so it is chained like anything else.
    appendAudit({
      txn_id: intent?.txn_id ?? null,
      type: 'INTENT_VERIFY_FAILED',
      actor: params.actorId,
      payload: { code, message, credential_id: signature?.credential_id ?? null },
    });
    broadcast('intent.rejected', { txn_id: intent?.txn_id, code });
    throw bad(code, message);
  };

  if (intent?.v !== 1) fail('UNSUPPORTED_INTENT_VERSION', 'Only intent version 1 is accepted');
  if (intent.org_id !== CONFIG.orgId) fail('WRONG_ORG', 'Intent is for a different organisation');
  if (getIntentRow(intent.txn_id)) fail('TXN_ID_REUSED', 'That transaction id already exists');

  const credential = getCredential(signature.credential_id);
  if (!credential) fail('UNKNOWN_CREDENTIAL', 'No such credential is enrolled');
  if (credential!.state !== 'ACTIVE') fail('CREDENTIAL_NOT_ACTIVE', 'Credential is not active');

  const signer = getUser(credential!.user_id)!;
  if (!ORIGINATOR_ROLES.has(signer.role)) {
    fail('ROLE_CANNOT_ORIGINATE', `Role ${signer.role} may not originate a payment intent`);
  }

  // Custody: an executive's signature must not come from the same browser that
  // composes payments. Enforced here as well as at enrolment, so a credential
  // issued before the policy existed cannot slip through.
  if (credential!.device_kind === 'console') {
    fail(
      'CONSOLE_KEY_NOT_PERMITTED',
      'This intent was signed by a console-resident key. Executives sign on the Authenticator app or with a hardware key.',
    );
  }
  // The custody tier is covered by the signature, so it cannot be swapped in
  // transit -- but it must also match what was actually enrolled.
  if (envelopeDeviceKind(signature) !== credential!.device_kind) {
    fail('DEVICE_KIND_MISMATCH', 'The signature claims a different custody tier than the credential');
  }

  // The signature must come from the person the intent claims wrote it.
  if (intent.originator.user_id !== signer.id) {
    fail('ORIGINATOR_MISMATCH', 'Intent originator does not match the signing credential');
  }
  if (intent.originator.role !== signer.role) {
    fail('ORIGINATOR_ROLE_MISMATCH', 'Intent claims a role the signer does not hold');
  }

  let amount = 0n;
  try {
    amount = toPaise(intent.amount.value);
  } catch {
    fail('BAD_AMOUNT', 'Amount must be a decimal string with at most two places');
  }
  if (amount <= 0n) fail('BAD_AMOUNT', 'Amount must be positive');
  if (intent.amount.currency !== 'INR') fail('BAD_CURRENCY', 'Only INR is configured');
  if (amount > BigInt(signer.approval_limit_paise)) {
    fail('OVER_SIGNER_MANDATE', 'Amount exceeds the registered mandate for this executive');
  }

  // Replay defence #1: bounded validity.
  const iat = Date.parse(intent.iat);
  const exp = Date.parse(intent.exp);
  if (!Number.isFinite(iat) || !Number.isFinite(exp)) fail('BAD_TIMESTAMPS', 'iat/exp unparseable');
  if (iat > now + CLOCK_SKEW_MS) fail('INTENT_FROM_FUTURE', 'Intent iat is in the future');
  if (exp <= now) fail('INTENT_EXPIRED', 'Signed intent has already expired');
  if (now - iat > POLICY.MAX_INTENT_AGE_MS) fail('INTENT_TOO_OLD', 'Signed intent is too old');

  // Replay defence #2: the nonce is single-use, forever.
  const burned = db.prepare(`SELECT txn_id FROM consumed_nonces WHERE nonce = ?`).get(intent.nonce);
  if (burned) fail('NONCE_REPLAY', 'This intent nonce has already been used');

  // The hash the server computes -- never one supplied by the client.
  const intent_hash = hashCanonical(intent);

  const verdict = await verifyAnyEnvelope(signature, credential!, {
    purpose: 'INTENT',
    payloadHash: intent_hash,
  });
  if (!verdict.ok) fail(`SIGNATURE_${verdict.reason}`, 'Intent signature did not verify');

  // Replay defence #3: cloned-key detection. For a software key the counter is
  // inside the signed assertion; for hardware it comes out of the
  // authenticator's own signed data, which is stronger.
  const counter = verdict.counter ?? 0;
  if (counter <= credential!.counter) {
    fail('COUNTER_REPLAY', 'Signature counter did not advance; possible cloned credential');
  }

  tx(() => {
    db.prepare(
      `INSERT INTO intents (txn_id, org_id, intent_json, intent_hash, signature_json,
                            credential_id, signer_id, lane, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'A', 'SIGNED', ?)`,
    ).run(
      intent.txn_id,
      intent.org_id,
      canonicalize(intent),
      intent_hash,
      JSON.stringify(signature),
      credential!.credential_id,
      signer.id,
      new Date().toISOString(),
    );
    db.prepare(`INSERT INTO consumed_nonces (nonce, txn_id, at) VALUES (?, ?, ?)`).run(
      intent.nonce,
      intent.txn_id,
      new Date().toISOString(),
    );
    db.prepare(`UPDATE credentials SET counter = ? WHERE credential_id = ?`).run(
      counter,
      credential!.credential_id,
    );
    appendAudit({
      txn_id: intent.txn_id,
      type: 'INTENT_SIGNED',
      actor: signer.id,
      payload: {
        lane: 'A',
        intent_hash,
        credential_id: credential!.credential_id,
        binding: credential!.binding,
        device_kind: credential!.device_kind,
        counter,
        user_presence: verdict.userVerified ?? true,
        amount: intent.amount,
        payee: intent.payee,
        origin: 'EXECUTIVE_SIGNED',
      },
    });
  });

  broadcast('intent.signed', { txn_id: intent.txn_id, intent_hash });
  return { txn_id: intent.txn_id, intent_hash };
}

/* ===========================================================================
 * Stage 2 -- the employee accepts, and an escrow opens
 * ========================================================================= */

export function acceptIntent(txnId: string, actor: UserRow): EscrowView {
  const row = getIntentRow(txnId);
  if (!row) throw missing('NO_SUCH_INTENT');
  if (row.state !== 'SIGNED') throw conflict('INTENT_NOT_PENDING', `Intent is ${row.state}`);

  const intent = parseIntent(row);
  if (Date.parse(intent.exp) <= Date.now()) {
    throw conflict('INTENT_EXPIRED', 'The signature window closed before it was accepted');
  }

  const credential = getCredential(row.credential_id)!;
  const risk = scoreRisk({ intent, deviceKind: credential.device_kind });

  const escrow_id = randomId('ESC');
  const openedAt = new Date();
  const windowMs =
    CONFIG.demoWindowSeconds !== null
      ? CONFIG.demoWindowSeconds * 1000
      : risk.window_minutes * 60_000;
  const expiresAt = new Date(openedAt.getTime() + windowMs);

  tx(() => {
    db.prepare(
      `INSERT INTO escrows (escrow_id, txn_id, intent_hash, lane, state, opened_by, opened_at,
                            expires_at, risk_json, required_approvals)
       VALUES (?, ?, ?, 'A', 'PENDING_QUORUM', ?, ?, ?, ?, ?)`,
    ).run(
      escrow_id,
      txnId,
      row.intent_hash,
      actor.id,
      openedAt.toISOString(),
      expiresAt.toISOString(),
      JSON.stringify(risk),
      risk.required_approvals,
    );
    db.prepare(`UPDATE intents SET state = 'ACCEPTED' WHERE txn_id = ?`).run(txnId);
    appendAudit({
      txn_id: txnId,
      type: 'INTENT_ACCEPTED',
      actor: actor.id,
      payload: { escrow_id, intent_hash: row.intent_hash, fields_editable: false },
    });
    appendAudit({
      txn_id: txnId,
      type: 'ESCROW_OPENED',
      actor: actor.id,
      payload: {
        escrow_id,
        risk,
        required_approvals: risk.required_approvals,
        expires_at: expiresAt.toISOString(),
        demo_window_override: CONFIG.demoWindowSeconds,
      },
    });
  });

  const view = escrowView(escrow_id);
  broadcast('escrow.opened', view);
  return view;
}

export function rejectIntent(txnId: string, actor: UserRow, reason: string): void {
  const row = getIntentRow(txnId);
  if (!row) throw missing('NO_SUCH_INTENT');
  if (row.state !== 'SIGNED') throw conflict('INTENT_NOT_PENDING', `Intent is ${row.state}`);

  tx(() => {
    db.prepare(`UPDATE intents SET state = 'REJECTED' WHERE txn_id = ?`).run(txnId);
    appendAudit({
      txn_id: txnId,
      type: 'INTENT_REJECTED',
      actor: actor.id,
      payload: { reason, intent_hash: row.intent_hash },
    });
  });
  broadcast('intent.rejected', { txn_id: txnId, reason });
}

/* ===========================================================================
 * Stage 3 -- quorum inside the window
 * ========================================================================= */

export async function recordApproval(params: {
  escrowId: string;
  actor: UserRow;
  assertion: ApprovalAssertion;
  signature: SignatureEnvelope;
}): Promise<EscrowView> {
  const { escrowId, actor, assertion, signature } = params;
  const escrow = getEscrowRow(escrowId);
  if (!escrow) throw missing('NO_SUCH_ESCROW');

  const intentRow = getIntentRow(escrow.txn_id)!;
  const intent = parseIntent(intentRow);

  if (escrow.state !== 'PENDING_QUORUM') {
    throw conflict('ESCROW_NOT_PENDING', `Escrow is ${escrow.state}`);
  }
  // The window is closed by the server clock, never by the caller's.
  if (Date.parse(escrow.expires_at) <= Date.now()) {
    expireEscrow(escrow);
    throw conflict('ESCROW_EXPIRED', 'The approval window has closed');
  }

  if (!APPROVER_ROLES.has(actor.role)) throw denied('ROLE_CANNOT_APPROVE');
  if (actor.id === intentRow.signer_id) {
    throw denied('SELF_APPROVAL', 'The signer of an intent cannot also approve it');
  }
  if (actor.id === escrow.opened_by) {
    throw denied('OPENER_CANNOT_APPROVE', 'The employee who opened the escrow cannot approve it');
  }
  if (toPaise(intent.amount.value) > BigInt(actor.approval_limit_paise)) {
    throw denied('OVER_APPROVER_LIMIT', 'Amount exceeds the authority limit for this approver');
  }
  if (approvalsFor(escrowId).some((a) => a.approver_id === actor.id)) {
    throw conflict('ALREADY_APPROVED', 'This approver has already responded');
  }

  // What-you-see-is-what-you-sign: the assertion must bind to *this* escrow and
  // *this* intent hash, so an approval can never be moved onto another payment.
  if (assertion.type !== 'approval' || assertion.v !== 1) throw bad('BAD_ASSERTION');
  if (assertion.escrow_id !== escrowId) throw bad('ASSERTION_ESCROW_MISMATCH');
  if (assertion.intent_hash !== escrow.intent_hash) throw bad('ASSERTION_HASH_MISMATCH');
  if (assertion.approver_id !== actor.id) throw bad('ASSERTION_APPROVER_MISMATCH');

  const credential = getCredential(signature.credential_id);
  if (!credential) throw bad('UNKNOWN_CREDENTIAL');
  if (credential.state !== 'ACTIVE') throw denied('CREDENTIAL_NOT_ACTIVE');
  if (credential.user_id !== actor.id) throw denied('CREDENTIAL_NOT_OWNED_BY_APPROVER');
  assertCustodyAllowed(actor.role, credential.device_kind);
  if (envelopeDeviceKind(signature) !== credential.device_kind) {
    throw bad('DEVICE_KIND_MISMATCH', 'The signature claims a different custody tier');
  }

  const payloadHash = await approvalHash(assertion);
  const verdict = await verifyAnyEnvelope(signature, credential, {
    purpose: 'APPROVAL',
    payloadHash,
  });
  if (!verdict.ok) throw bad(`SIGNATURE_${verdict.reason}`, 'Approval signature did not verify');
  const approvalCounter = verdict.counter ?? 0;
  if (approvalCounter <= credential.counter) {
    throw bad('COUNTER_REPLAY', 'Signature counter did not advance');
  }

  tx(() => {
    db.prepare(
      `INSERT INTO approvals (escrow_id, approver_id, decision, assertion_json, envelope_json,
                              credential_id, binding, device_kind, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      escrowId,
      actor.id,
      assertion.decision,
      canonicalize(assertion),
      JSON.stringify(signature),
      credential.credential_id,
      credential.binding,
      credential.device_kind,
      new Date().toISOString(),
    );
    db.prepare(`UPDATE credentials SET counter = ? WHERE credential_id = ?`).run(
      approvalCounter,
      credential.credential_id,
    );
    appendAudit({
      txn_id: escrow.txn_id,
      type: assertion.decision === 'APPROVE' ? 'APPROVAL_RECORDED' : 'APPROVAL_REJECTED',
      actor: actor.id,
      payload: {
        escrow_id: escrowId,
        role: actor.role,
        decision: assertion.decision,
        intent_hash: escrow.intent_hash,
        credential_id: credential.credential_id,
        binding: credential.binding,
        device_kind: credential.device_kind,
      },
    });

    if (assertion.decision === 'REJECT') {
      db.prepare(`UPDATE escrows SET state = 'REJECTED', closed_at = ? WHERE escrow_id = ?`).run(
        new Date().toISOString(),
        escrowId,
      );
      db.prepare(`UPDATE intents SET state = 'REJECTED' WHERE txn_id = ?`).run(escrow.txn_id);
    }
  });

  const quorum = quorumStatus(escrowId);
  if (assertion.decision === 'APPROVE' && quorum.met) {
    tx(() => {
      db.prepare(`UPDATE escrows SET state = 'APPROVED' WHERE escrow_id = ?`).run(escrowId);
      appendAudit({
        txn_id: escrow.txn_id,
        type: 'QUORUM_MET',
        actor: null,
        payload: {
          escrow_id: escrowId,
          approvals: quorum.approvals,
          required: quorum.required,
          within_window: true,
        },
      });
    });
    broadcast('escrow.updated', escrowView(escrowId));
    await executePayment(escrowId);
  }

  const view = escrowView(escrowId);
  broadcast('escrow.updated', view);
  return view;
}

export function quorumStatus(escrowId: string) {
  const escrow = getEscrowRow(escrowId)!;
  const risk = JSON.parse(escrow.risk_json);
  const approvals = approvalsFor(escrowId).filter((a) => a.decision === 'APPROVE');
  const roles = approvals.map((a) => getUser(a.approver_id)?.role);
  const treasuryPresent = roles.includes('TREASURY');
  const enough = approvals.length >= escrow.required_approvals;
  const met = risk.tier === 'CRITICAL' ? enough && treasuryPresent : enough;
  return { met, approvals: approvals.length, required: escrow.required_approvals, treasuryPresent };
}

/* ===========================================================================
 * Expiry -- a voided escrow is the best fraud signal the system produces,
 * so it is never deleted.
 * ========================================================================= */

export function expireEscrow(escrow: EscrowRow, reason = 'WINDOW_CLOSED'): void {
  if (escrow.state !== 'PENDING_QUORUM') return;
  tx(() => {
    db.prepare(`UPDATE escrows SET state = 'EXPIRED', closed_at = ? WHERE escrow_id = ?`).run(
      new Date().toISOString(),
      escrow.escrow_id,
    );
    db.prepare(`UPDATE intents SET state = 'CONSUMED' WHERE txn_id = ?`).run(escrow.txn_id);
    appendAudit({
      txn_id: escrow.txn_id,
      type: 'ESCROW_EXPIRED',
      actor: null,
      payload: {
        escrow_id: escrow.escrow_id,
        approvals_collected: approvalsFor(escrow.escrow_id).length,
        required: escrow.required_approvals,
        reason,
        alert: reason === 'WINDOW_CLOSED' ? 'CFO_NOTIFIED' : 'ACTIVE_IMPERSONATION',
        retained: true,
      },
    });
  });
  broadcast('escrow.expired', escrowView(escrow.escrow_id));
}

export function sweepExpired(): number {
  const due = db
    .prepare(`SELECT * FROM escrows WHERE state = 'PENDING_QUORUM' AND expires_at <= ?`)
    .all(new Date().toISOString()) as unknown as EscrowRow[];
  for (const e of due) expireEscrow(e);
  return due.length;
}

/* ===========================================================================
 * The approval bundle and the enforcement point
 * ========================================================================= */

export function buildBundle(escrowId: string): ApprovalBundle {
  const escrow = getEscrowRow(escrowId);
  if (!escrow) throw missing('NO_SUCH_ESCROW');
  const intentRow = getIntentRow(escrow.txn_id)!;

  return {
    v: 1,
    escrow_id: escrow.escrow_id,
    intent: parseIntent(intentRow),
    intent_hash: escrow.intent_hash,
    lane: escrow.lane,
    intent_signature: parseSignature(intentRow),
    approvals: approvalsFor(escrowId)
      .filter((a) => a.decision === 'APPROVE')
      .map((a) => ({ assertion: parseAssertion(a), envelope: JSON.parse(a.envelope_json) })),
    risk: JSON.parse(escrow.risk_json),
    issued_at: new Date().toISOString(),
  };
}

export async function executePayment(escrowId: string): Promise<BankReceipt> {
  const escrow = getEscrowRow(escrowId)!;
  if (escrow.state !== 'APPROVED') {
    throw conflict('ESCROW_NOT_APPROVED', `Escrow is ${escrow.state}`);
  }
  const bundle = buildBundle(escrowId);

  appendAudit({
    txn_id: escrow.txn_id,
    type: 'PAYMENT_SUBMITTED',
    actor: null,
    payload: {
      escrow_id: escrowId,
      rail: CONFIG.bankUrl,
      approvals: bundle.approvals.length,
      intent_hash: bundle.intent_hash,
    },
  });

  let receipt: BankReceipt;
  try {
    const res = await fetch(`${CONFIG.bankUrl}/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bundle),
    });
    receipt = (await res.json()) as BankReceipt;
  } catch (e) {
    receipt = { ok: false, error: `RAIL_UNREACHABLE: ${(e as Error).message}` };
  }

  tx(() => {
    db.prepare(
      `UPDATE escrows SET state = ?, receipt_json = ?, closed_at = ? WHERE escrow_id = ?`,
    ).run(
      receipt.ok ? 'EXECUTED' : 'REJECTED',
      JSON.stringify(receipt),
      new Date().toISOString(),
      escrowId,
    );
    db.prepare(`UPDATE intents SET state = 'CONSUMED' WHERE txn_id = ?`).run(escrow.txn_id);
    appendAudit({
      txn_id: escrow.txn_id,
      type: receipt.ok ? 'EXECUTED' : 'PAYMENT_REFUSED',
      actor: null,
      payload: { escrow_id: escrowId, receipt },
    });
  });

  broadcast('escrow.updated', escrowView(escrowId));
  return receipt;
}

/* ===========================================================================
 * Views
 * ========================================================================= */

export function escrowView(escrowId: string): EscrowView {
  const escrow = getEscrowRow(escrowId);
  if (!escrow) throw missing('NO_SUCH_ESCROW');
  const intentRow = getIntentRow(escrow.txn_id)!;
  const credential = getCredential(intentRow.credential_id)!;
  const signer = getUser(intentRow.signer_id)!;
  const remaining = Math.max(0, Math.floor((Date.parse(escrow.expires_at) - Date.now()) / 1000));

  return {
    escrow_id: escrow.escrow_id,
    txn_id: escrow.txn_id,
    intent_hash: escrow.intent_hash,
    lane: escrow.lane,
    state: escrow.state as EscrowView['state'],
    opened_by: escrow.opened_by,
    opened_at: escrow.opened_at,
    expires_at: escrow.expires_at,
    seconds_remaining: escrow.state === 'PENDING_QUORUM' ? remaining : 0,
    risk: JSON.parse(escrow.risk_json),
    required_approvals: escrow.required_approvals,
    approvals: approvalRecords(escrowId),
    intent: parseIntent(intentRow),
    signer: {
      user_id: signer.id,
      role: signer.role,
      binding: credential.binding,
      device_kind: credential.device_kind,
      credential_id: credential.credential_id,
    },
    receipt: escrow.receipt_json ? JSON.parse(escrow.receipt_json) : null,
  };
}

export function listEscrows(): EscrowView[] {
  const rows = db
    .prepare(`SELECT escrow_id FROM escrows ORDER BY opened_at DESC LIMIT 100`)
    .all() as unknown as Array<{ escrow_id: string }>;
  return rows.map((r) => escrowView(r.escrow_id));
}

export function signedQueue() {
  const rows = db
    .prepare(`SELECT * FROM intents WHERE state = 'SIGNED' ORDER BY created_at DESC`)
    .all() as unknown as IntentRow[];
  return rows.map((row) => {
    const credential = getCredential(row.credential_id)!;
    const signer = getUser(row.signer_id)!;
    return {
      txn_id: row.txn_id,
      lane: row.lane,
      intent: parseIntent(row),
      intent_hash: row.intent_hash,
      signature: parseSignature(row),
      state: row.state,
      created_at: row.created_at,
      signer: {
        user_id: signer.id,
        name: signer.name,
        role: signer.role,
        binding: credential.binding,
        device_kind: credential.device_kind,
        credential_id: credential.credential_id,
        key_age_days: Math.floor(
          (Date.now() - Date.parse(credential.activated_at ?? credential.created_at)) / 86_400_000,
        ),
      },
    };
  });
}

export function txnSummary(txnId: string) {
  const row = getIntentRow(txnId);
  if (!row) throw missing('NO_SUCH_TXN');
  const escrow = escrowForTxn(txnId);
  return {
    txn_id: txnId,
    intent: parseIntent(row),
    intent_hash: row.intent_hash,
    lane: row.lane,
    state: row.state,
    signature: parseSignature(row),
    escrow: escrow ? escrowView(escrow.escrow_id) : null,
  };
}
