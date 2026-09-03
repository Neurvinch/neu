import { POLICY, canonicalize, formatINR, toPaise } from '@seal/shared';
import type {
  ApprovalAssertion,
  SignatureEnvelope,
  SigningAction,
  SigningRequest,
  SigningRequestState,
  TransactionIntent,
} from '@seal/shared';
import { verifyAnyEnvelope } from '@seal/shared/webauthn';
import { appendAudit } from '../audit.js';
import { db, tx } from '../db.js';
import { broadcast } from '../events.js';
import { hashCanonical, randomId } from '../hash.js';
import { impersonationSignal } from '../risk.js';
import { bad, conflict, denied, missing } from './errors.js';
import { assertCustodyAllowed, enrollmentApprovalPayload, approveEnrollment } from './enrollment.js';
import {
  credentialsFor,
  getCredential,
  getEscrowRow,
  getIntentRow,
  parseIntent,
  type UserRow,
} from './repo.js';
import { recordApproval, submitSignedIntent } from './service.js';

/**
 * The out-of-band signing channel.
 *
 * This is what turns the Authenticator app into something that behaves like a
 * hardware token. The console has no key and cannot sign; all it can do is
 * write down exactly what it wants signed. The request appears on the
 * executive's own device, which renders the real fields, and only that device
 * can return a signature.
 *
 * Three properties make this worth more than a "confirm" button:
 *
 *   1. The payload hash is fixed when the request is created and re-checked
 *      when the signature returns. The console cannot show one thing on the
 *      phone and submit another.
 *   2. The signature is produced on a different device, at a different origin,
 *      with its own key store. Compromising the console is no longer enough.
 *   3. The human sees payee, account and amount on the device that holds the
 *      key -- which is the only place "what you see is what you sign" can
 *      actually be true.
 */

const DEFAULT_TTL_MS = 5 * 60_000;

interface RequestRow {
  id: string;
  purpose: 'INTENT' | 'APPROVAL' | 'ENROLLMENT';
  subject_user_id: string;
  title: string;
  subtitle: string;
  rows_json: string;
  payload_json: string;
  payload_hash: string;
  action_json: string;
  tier: string | null;
  warnings_json: string;
  state: SigningRequestState;
  requested_by: string;
  requested_from: string;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
  envelope_json: string | null;
  error: string | null;
  result_json: string | null;
}

function toView(r: RequestRow): SigningRequest {
  return {
    id: r.id,
    purpose: r.purpose,
    subject_user_id: r.subject_user_id,
    title: r.title,
    subtitle: r.subtitle,
    rows: JSON.parse(r.rows_json),
    payload: JSON.parse(r.payload_json),
    payload_hash: r.payload_hash,
    action: JSON.parse(r.action_json),
    tier: (r.tier as SigningRequest['tier']) ?? null,
    warnings: JSON.parse(r.warnings_json ?? '[]'),
    state: r.state,
    requested_by: r.requested_by,
    requested_from: r.requested_from,
    created_at: r.created_at,
    expires_at: r.expires_at,
    seconds_remaining:
      r.state === 'PENDING'
        ? Math.max(0, Math.floor((Date.parse(r.expires_at) - Date.now()) / 1000))
        : 0,
    resolved_at: r.resolved_at,
    error: r.error,
    result: r.result_json ? JSON.parse(r.result_json) : null,
  };
}

export function getRequest(id: string): SigningRequest {
  const row = db.prepare(`SELECT * FROM signing_requests WHERE id = ?`).get(id) as
    | RequestRow
    | undefined;
  if (!row) throw missing('NO_SUCH_SIGNING_REQUEST');
  return toView(row);
}

export function listRequestsFor(userId: string, includeResolved = true): SigningRequest[] {
  const rows = db
    .prepare(
      `SELECT * FROM signing_requests
       WHERE subject_user_id = ? ${includeResolved ? '' : "AND state = 'PENDING'"}
       ORDER BY created_at DESC LIMIT 40`,
    )
    .all(userId) as unknown as RequestRow[];
  return rows.map(toView);
}

/* --------------------------------------------------------------------------
 * Creating a request
 * ------------------------------------------------------------------------ */

export interface CreateRequestInput {
  requester: UserRow;
  purpose: 'INTENT' | 'APPROVAL' | 'ENROLLMENT';
  payload: unknown;
  action: SigningAction;
  title: string;
  subtitle: string;
  rows: Array<[string, string]>;
  tier?: string | null;
  warnings?: string[];
  ttlMs?: number;
}

/**
 * What is unusual about this request, in words, computed here and rendered on
 * the signing device.
 *
 * This is the other half of defeating a convincing impersonation. A CFO
 * glancing at her phone while someone talks urgently at her should not have to
 * hold the vendor master in her head -- the prompt itself should say "this
 * account has never been paid before". The strongest social-engineering
 * pressure in the world does not change what these lines say.
 */
function intentWarnings(intent: TransactionIntent): string[] {
  const out: string[] = [];

  const byAccount = db
    .prepare(`SELECT * FROM vendor_master WHERE account = ? AND active = 1`)
    .get(intent.payee.account) as { name: string; ifsc: string } | undefined;

  const byName = db
    .prepare(`SELECT account FROM vendor_master WHERE lower(name) = lower(?) AND active = 1`)
    .all(intent.payee.name) as unknown as Array<{ account: string }>;

  if (!byAccount && byName.length > 0) {
    out.push(
      `The name matches a known vendor but the account does not. On file: ${byName[0].account}.`,
    );
  } else if (!byAccount) {
    out.push('This account is not in your vendor master. It has never been paid before.');
  } else if (byAccount.ifsc !== intent.payee.ifsc) {
    out.push(`The IFSC differs from the verified record for this vendor (${byAccount.ifsc}).`);
  }

  if (toPaise(intent.amount.value) > toPaise(POLICY.LARGE_THRESHOLD)) {
    out.push('This is above the large-payment threshold.');
  }

  const hours = (Date.parse(intent.deadline) - Date.now()) / 3_600_000;
  if (Number.isFinite(hours) && hours < 4) {
    out.push('The deadline is under four hours away. Urgency is the most common lever in this attack.');
  }

  const priorExpiry = db
    .prepare(
      `SELECT COUNT(*) AS n FROM escrows e JOIN intents i ON i.txn_id = e.txn_id
       WHERE e.state = 'EXPIRED'
         AND json_extract(i.intent_json, '$.payee.account') = ?
         AND e.expires_at > datetime('now', '-1 day')`,
    )
    .get(intent.payee.account) as { n: number };
  if (priorExpiry.n > 0) {
    out.push('A payment to this account already timed out in the last 24 hours.');
  }

  const impersonation = impersonationSignal(intent.originator.user_id);
  if (impersonation.denied > 0) {
    out.push('Someone was impersonating you recently. Be especially careful with this one.');
  }

  return out;
}

function create(input: CreateRequestInput): SigningRequest {
  const id = randomId('SIG');
  const now = new Date();
  const payload_hash = hashCanonical(input.payload);

  tx(() => {
    db.prepare(
      `INSERT INTO signing_requests
         (id, purpose, subject_user_id, title, subtitle, rows_json, payload_json, payload_hash,
          action_json, tier, warnings_json, state, requested_by, requested_from, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?)`,
    ).run(
      id,
      input.purpose,
      input.requester.id,
      input.title,
      input.subtitle,
      JSON.stringify(input.rows),
      canonicalize(input.payload),
      payload_hash,
      JSON.stringify(input.action),
      input.tier ?? null,
      JSON.stringify(input.warnings ?? []),
      input.requester.id,
      'console',
      now.toISOString(),
      new Date(now.getTime() + (input.ttlMs ?? DEFAULT_TTL_MS)).toISOString(),
    );
    appendAudit({
      txn_id: txnIdFor(input.action),
      type: 'SIGNING_REQUESTED',
      actor: input.requester.id,
      payload: {
        signing_request: id,
        purpose: input.purpose,
        payload_hash,
        channel: 'OUT_OF_BAND',
        pushed_to: input.requester.id,
      },
    });
  });

  const view = getRequest(id);
  broadcast('signing.requested', view);
  return view;
}

/**
 * The credential a signature would actually come from. Console-resident keys
 * are excluded: they cannot authorize anything for an executive, so a request
 * that would depend on one is refused rather than pushed.
 */
function signingCredentialFor(user: UserRow) {
  return credentialsFor(user.id).find(
    (c) => c.state === 'ACTIVE' && (c.device_kind === 'authenticator' || c.device_kind === 'hardware'),
  );
}

function txnIdFor(action: SigningAction): string | null {
  if (action.kind === 'SUBMIT_INTENT') return action.intent.txn_id;
  if (action.kind === 'RECORD_APPROVAL') {
    const escrow = getEscrowRow(action.escrow_id);
    return escrow?.txn_id ?? null;
  }
  return null;
}

const ORIGINATOR_ROLES = new Set(['CFO', 'CEO', 'TREASURY']);
const APPROVER_ROLES = new Set(['CEO', 'CTO', 'TREASURY', 'CFO']);

/**
 * Ask the executive's own device to sign a payment intent they composed.
 *
 * Eligibility is checked here rather than only at fulfilment. A request that
 * could never succeed should not reach someone's phone at all: pushing one
 * there trains people to dismiss prompts, and every dismissed prompt makes the
 * real one easier to wave through.
 */
export function requestIntentSignature(requester: UserRow, intent: TransactionIntent) {
  if (intent.originator.user_id !== requester.id) {
    throw denied('ORIGINATOR_MISMATCH', 'You may only request a signature for your own intent');
  }
  if (!ORIGINATOR_ROLES.has(requester.role)) {
    throw denied('ROLE_CANNOT_ORIGINATE', `Role ${requester.role} may not originate a payment intent`);
  }
  if (!signingCredentialFor(requester)) {
    throw denied(
      'NO_SIGNING_DEVICE',
      'You have no active credential on an authenticator or hardware key. Enrol one in the SEAL Authenticator first.',
    );
  }
  return create({
    requester,
    purpose: 'INTENT',
    payload: intent,
    action: { kind: 'SUBMIT_INTENT', intent },
    title: 'Authorize a payment',
    subtitle: `${intent.txn_id} · composed on the console at ${new Date().toLocaleTimeString()}`,
    rows: [
      ['Payee', intent.payee.name],
      ['Account', intent.payee.account],
      ['IFSC', intent.payee.ifsc],
      ['Amount', formatINR(intent.amount.value)],
      ['Purpose', intent.purpose],
      ['Pay by', new Date(intent.deadline).toLocaleString()],
    ],
    warnings: intentWarnings(intent),
    // A signing request must not outlive the signature validity it would produce.
    ttlMs: Math.min(DEFAULT_TTL_MS, Math.max(30_000, Date.parse(intent.exp) - Date.now())),
  });
}

/** Ask the approver's own device to sign an approval over one escrow. */
export function requestApprovalSignature(
  requester: UserRow,
  escrowId: string,
  decision: 'APPROVE' | 'REJECT',
) {
  const escrow = getEscrowRow(escrowId);
  if (!escrow) throw missing('NO_SUCH_ESCROW');
  if (escrow.state !== 'PENDING_QUORUM') throw conflict('ESCROW_NOT_PENDING');

  const intentRow = getIntentRow(escrow.txn_id)!;
  const intent = parseIntent(intentRow);

  // The same eligibility rules the approval itself will face, applied before
  // anything is pushed to a device.
  if (!APPROVER_ROLES.has(requester.role)) throw denied('ROLE_CANNOT_APPROVE');
  if (requester.id === intentRow.signer_id) {
    throw denied('SELF_APPROVAL', 'The signer of an intent cannot also approve it');
  }
  if (requester.id === escrow.opened_by) {
    throw denied('OPENER_CANNOT_APPROVE', 'The employee who opened the escrow cannot approve it');
  }
  if (!signingCredentialFor(requester)) {
    throw denied('NO_SIGNING_DEVICE', 'No active credential on an authenticator or hardware key.');
  }
  const assertion: ApprovalAssertion = {
    v: 1,
    type: 'approval',
    escrow_id: escrowId,
    intent_hash: escrow.intent_hash,
    approver_id: requester.id,
    decision,
    at: new Date().toISOString(),
  };

  const risk = JSON.parse(escrow.risk_json) as { tier: string; score: number };

  return create({
    requester,
    purpose: 'APPROVAL',
    payload: assertion,
    action: { kind: 'RECORD_APPROVAL', escrow_id: escrowId, assertion },
    title: decision === 'APPROVE' ? 'Approve a payment' : 'Decline a payment',
    subtitle: `${escrow.txn_id} · escrow ${escrowId} · ${risk.tier} risk (score ${risk.score})`,
    rows: [
      ['Payee', intent.payee.name],
      ['Account', intent.payee.account],
      ['Amount', formatINR(intent.amount.value)],
      ['Purpose', intent.purpose],
      ['Originated by', `${intent.originator.user_id} (${intent.originator.role})`],
      ['Intent hash', escrow.intent_hash],
      ['Your decision', decision],
    ],
    tier: risk.tier,
    warnings: [
      ...(JSON.parse(escrow.risk_json).notes as string[]).filter((n) => !n.startsWith('Lane A:')),
      ...(decision === 'APPROVE'
        ? ['Approving is final. The payment executes as soon as the quorum is met.']
        : []),
    ],
    // The request dies with the escrow window, never after it.
    ttlMs: Math.min(DEFAULT_TTL_MS, Math.max(30_000, Date.parse(escrow.expires_at) - Date.now())),
  });
}

/** Ask the approver's own device to sign the admission of a new key. */
export function requestEnrollmentApprovalSignature(requester: UserRow, enrollmentId: string) {
  const req = db
    .prepare(
      `SELECT r.id, r.credential_id, r.user_id, r.state, c.public_key, c.device_kind, u.name, u.role
       FROM enrollment_requests r
       JOIN credentials c ON c.credential_id = r.credential_id
       JOIN users u ON u.id = r.user_id
       WHERE r.id = ?`,
    )
    .get(enrollmentId) as
    | {
        id: string;
        credential_id: string;
        user_id: string;
        state: string;
        public_key: string;
        device_kind: string;
        name: string;
        role: string;
      }
    | undefined;
  if (!req) throw missing('NO_SUCH_ENROLLMENT');
  if (req.state !== 'PENDING') throw conflict('ENROLLMENT_NOT_PENDING');
  if (req.user_id === requester.id) throw denied('SELF_ENROLLMENT_APPROVAL');

  const payload = enrollmentApprovalPayload({
    request_id: req.id,
    credential_id: req.credential_id,
    subject_user_id: req.user_id,
    public_key: req.public_key,
    approver_id: requester.id,
  });

  return create({
    requester,
    purpose: 'ENROLLMENT',
    payload,
    action: { kind: 'APPROVE_ENROLLMENT', request_id: req.id },
    title: 'Admit a new signing key',
    subtitle: `You are vouching that this key belongs to ${req.name}`,
    rows: [
      ['Subject', `${req.name} (${req.role})`],
      ['Credential', req.credential_id],
      ['Custody', req.device_kind],
      ['Public key', req.public_key],
    ],
    warnings: [
      `Admitting this key lets ${req.name} authorize payments. Only do this if you know they set up a new device.`,
      ...(impersonationSignal(req.user_id).denied > 0
        ? ['Someone was recently impersonating this person. Verify out of band before admitting a key for them.']
        : []),
    ],
  });
}

/* --------------------------------------------------------------------------
 * Fulfilment -- the only place a signature enters the system
 * ------------------------------------------------------------------------ */

export async function fulfilRequest(params: {
  id: string;
  actor: UserRow;
  signature: SignatureEnvelope;
}): Promise<SigningRequest> {
  const row = db.prepare(`SELECT * FROM signing_requests WHERE id = ?`).get(params.id) as
    | RequestRow
    | undefined;
  if (!row) throw missing('NO_SUCH_SIGNING_REQUEST');
  if (row.subject_user_id !== params.actor.id) {
    throw denied('NOT_YOUR_SIGNING_REQUEST', 'This request was raised for someone else');
  }
  if (row.state !== 'PENDING') throw conflict('REQUEST_NOT_PENDING', `Request is ${row.state}`);
  if (Date.parse(row.expires_at) <= Date.now()) {
    expireRequest(row);
    throw conflict('REQUEST_EXPIRED', 'The signing request timed out');
  }

  const credential = getCredential(params.signature?.credential_id ?? '');
  if (!credential) throw bad('UNKNOWN_CREDENTIAL');
  if (credential.state !== 'ACTIVE') throw denied('CREDENTIAL_NOT_ACTIVE');
  if (credential.user_id !== params.actor.id) throw denied('CREDENTIAL_NOT_OWNED_BY_SIGNER');

  // The custody rule is enforced here as well as at enrolment, so an executive
  // credential that predates the policy cannot slip through.
  assertCustodyAllowed(params.actor.role, credential.device_kind);

  // The signature must cover the hash that was fixed when the request was
  // created -- not a payload the console supplied a moment ago.
  const verdict = await verifyAnyEnvelope(params.signature, credential, {
    purpose: row.purpose,
    payloadHash: row.payload_hash,
  });
  if (!verdict.ok) {
    fail(row, `SIGNATURE_${verdict.reason}`);
    throw bad(`SIGNATURE_${verdict.reason}`, 'The signature did not verify against this request');
  }

  const action = JSON.parse(row.action_json) as SigningAction;

  try {
    const result = await perform(action, params.actor, params.signature);
    tx(() => {
      db.prepare(
        `UPDATE signing_requests SET state = 'SIGNED', resolved_at = ?, envelope_json = ?, result_json = ?
         WHERE id = ?`,
      ).run(
        new Date().toISOString(),
        JSON.stringify(params.signature),
        JSON.stringify(result ?? {}),
        row.id,
      );
    });
  } catch (e) {
    const message = (e as { code?: string; message?: string }).code ?? (e as Error).message;
    fail(row, message);
    throw e;
  }

  const view = getRequest(row.id);
  broadcast('signing.resolved', view);
  return view;
}

async function perform(
  action: SigningAction,
  actor: UserRow,
  signature: SignatureEnvelope,
): Promise<Record<string, unknown>> {
  switch (action.kind) {
    case 'SUBMIT_INTENT':
      return submitSignedIntent({ intent: action.intent, signature, actorId: actor.id }) as Promise<
        Record<string, unknown>
      >;
    case 'RECORD_APPROVAL':
      return recordApproval({
        escrowId: action.escrow_id,
        actor,
        assertion: action.assertion,
        signature,
      }) as unknown as Promise<Record<string, unknown>>;
    case 'APPROVE_ENROLLMENT': {
      const req = db
        .prepare(
          `SELECT r.id, r.credential_id, r.user_id, c.public_key
           FROM enrollment_requests r JOIN credentials c ON c.credential_id = r.credential_id
           WHERE r.id = ?`,
        )
        .get(action.request_id) as
        | { id: string; credential_id: string; user_id: string; public_key: string }
        | undefined;
      if (!req) throw missing('NO_SUCH_ENROLLMENT');
      return approveEnrollment(
        action.request_id,
        actor,
        enrollmentApprovalPayload({
          request_id: req.id,
          credential_id: req.credential_id,
          subject_user_id: req.user_id,
          public_key: req.public_key,
          approver_id: actor.id,
        }),
        signature,
      ) as unknown as Promise<Record<string, unknown>>;
    }
  }
}

export function declineRequest(id: string, actor: UserRow, reason: string): SigningRequest {
  const row = db.prepare(`SELECT * FROM signing_requests WHERE id = ?`).get(id) as
    | RequestRow
    | undefined;
  if (!row) throw missing('NO_SUCH_SIGNING_REQUEST');
  if (row.subject_user_id !== actor.id) throw denied('NOT_YOUR_SIGNING_REQUEST');
  if (row.state !== 'PENDING') throw conflict('REQUEST_NOT_PENDING');

  tx(() => {
    db.prepare(
      `UPDATE signing_requests SET state = 'DECLINED', resolved_at = ?, error = ? WHERE id = ?`,
    ).run(new Date().toISOString(), reason, id);
    appendAudit({
      txn_id: txnIdFor(JSON.parse(row.action_json)),
      type: 'SIGNING_DECLINED',
      actor: actor.id,
      payload: {
        signing_request: id,
        purpose: row.purpose,
        payload_hash: row.payload_hash,
        reason,
        // The headline signal: someone asked this executive to authorize
        // something and the executive, looking at the real fields, said no.
        alert: 'DECLINED_ON_ENROLLED_DEVICE',
      },
    });
  });

  const view = getRequest(id);
  broadcast('signing.resolved', view);
  return view;
}

function fail(row: RequestRow, error: string): void {
  db.prepare(
    `UPDATE signing_requests SET state = 'FAILED', resolved_at = ?, error = ? WHERE id = ?`,
  ).run(new Date().toISOString(), error, row.id);
  broadcast('signing.resolved', getRequest(row.id));
}

function expireRequest(row: RequestRow): void {
  tx(() => {
    db.prepare(
      `UPDATE signing_requests SET state = 'EXPIRED', resolved_at = ? WHERE id = ? AND state = 'PENDING'`,
    ).run(new Date().toISOString(), row.id);
    appendAudit({
      txn_id: txnIdFor(JSON.parse(row.action_json)),
      type: 'SIGNING_EXPIRED',
      actor: null,
      payload: { signing_request: row.id, purpose: row.purpose, payload_hash: row.payload_hash },
    });
  });
  broadcast('signing.resolved', getRequest(row.id));
}

export function sweepSigningRequests(): number {
  const due = db
    .prepare(`SELECT * FROM signing_requests WHERE state = 'PENDING' AND expires_at <= ?`)
    .all(new Date().toISOString()) as unknown as RequestRow[];
  for (const r of due) expireRequest(r);
  return due.length;
}
