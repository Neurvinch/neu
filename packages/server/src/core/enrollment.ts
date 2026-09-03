import { OUT_OF_BAND_ROLES, canonicalize, credentialIdFor } from '@seal/shared';
import type { DeviceKind, SignatureEnvelope } from '@seal/shared';
import {
  RP_ID,
  RP_NAME,
  verifyAnyEnvelope,
  verifyHardwareRegistration,
} from '@seal/shared/webauthn';
import { generateRegistrationOptions } from '@simplewebauthn/server';
import { randomBytes } from 'node:crypto';
import { appendAudit } from '../audit.js';
import { db, tx } from '../db.js';
import { broadcast } from '../events.js';
import { hashCanonical, randomId } from '../hash.js';
import { publishKeyDirectory } from '../keydir.js';
import { bad, conflict, denied, missing } from './errors.js';
import { credentialsFor, getCredential, getUser, type UserRow } from './repo.js';

/**
 * Key enrolment is the hole every design like this leaves open. The model rests
 * on the server knowing the CFO's public key, so the cheapest attack is not to
 * forge a signature -- it is to register a *new* key for the CFO. That is why
 * enrolling or rotating a credential is gated by the same quorum as a
 * high-value payment, and why every step of it lands in the audit chain.
 */

const EXECUTIVE_ROLES = new Set<string>(OUT_OF_BAND_ROLES);

/** Enrolment approvals needed once the org is past its bootstrap ceremony. */
function requiredApprovalsFor(role: string): number {
  return EXECUTIVE_ROLES.has(role) ? 2 : 1;
}

/**
 * The custody rule.
 *
 * An executive may not hold a signing key in the same browser that composes
 * payment requests. Whatever compromises that console -- malware, a hijacked
 * session, someone walking up to an unlocked laptop -- would otherwise be able
 * to both write a payment and sign it, and the two-person integrity of the
 * design collapses into one machine. Executives sign on the Authenticator app
 * or with a hardware key: out of band, looking at the real fields.
 */
export function assertCustodyAllowed(role: string, deviceKind: DeviceKind): void {
  if (EXECUTIVE_ROLES.has(role) && deviceKind === 'console') {
    throw denied(
      'CONSOLE_KEY_NOT_PERMITTED',
      `A ${role} may not sign with a console-resident key. Use the SEAL Authenticator app, or a hardware security key.`,
    );
  }
}

/**
 * A genuine key ceremony has to start somewhere: with no active credentials,
 * there is nobody who can approve the first one. So the first two executive
 * credentials self-activate -- and are stamped BOOTSTRAP_CEREMONY in the chain
 * and shown as such in the UI. It is a real, bounded weakness, not a hidden one.
 */
export function inBootstrap(): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM credentials c JOIN users u ON u.id = c.user_id
       WHERE c.state = 'ACTIVE' AND u.role IN ('CFO','CEO','CTO','TREASURY')`,
    )
    .get() as { n: number };
  return row.n < 2;
}

/* --------------------------------------------------------------------------
 * begin -- issue a one-time challenge
 * ------------------------------------------------------------------------ */

const softwareChallenges = new Map<string, { challenge: string; expires: number }>();

export function beginSoftwareEnrollment(userId: string) {
  if (!getUser(userId)) throw missing('NO_SUCH_USER');
  const challenge = randomBytes(32).toString('hex');
  softwareChallenges.set(userId, { challenge, expires: Date.now() + 5 * 60_000 });
  return { challenge, expires_in: 300 };
}

/** What the enrolling device signs to prove it actually holds the private key. */
export function enrollmentPayload(userId: string, publicKey: string, challenge: string) {
  return { v: 1, type: 'enrollment', user_id: userId, public_key: publicKey, challenge };
}

/**
 * WebAuthn registration options. The challenge is generated and stored here --
 * a client that could choose its own challenge could replay a registration.
 */
export async function beginHardwareEnrollment(user: UserRow) {
  const existing = credentialsFor(user.id).filter((c) => c.webauthn_id && c.state !== 'REVOKED');

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userID: new TextEncoder().encode(user.id),
    userName: user.email ?? user.id,
    userDisplayName: `${user.name} (${user.role})`,
    attestationType: 'none',
    // Never offer a key the user already holds: a duplicate registration is a
    // confusing failure at best, and credential shadowing at worst.
    excludeCredentials: existing.map((c) => ({ id: c.webauthn_id! })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });

  db.prepare(
    `INSERT INTO webauthn_challenges (user_id, challenge, expires_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET challenge = excluded.challenge, expires_at = excluded.expires_at`,
  ).run(user.id, options.challenge, new Date(Date.now() + 5 * 60_000).toISOString());

  return options;
}

function takeWebauthnChallenge(userId: string): string {
  const row = db.prepare(`SELECT * FROM webauthn_challenges WHERE user_id = ?`).get(userId) as
    | { challenge: string; expires_at: string }
    | undefined;
  if (!row || Date.parse(row.expires_at) < Date.now()) throw bad('NO_ACTIVE_CHALLENGE');
  db.prepare(`DELETE FROM webauthn_challenges WHERE user_id = ?`).run(userId);
  return row.challenge;
}

/* --------------------------------------------------------------------------
 * finish -- prove possession, then queue for quorum
 * ------------------------------------------------------------------------ */

export interface EnrolResult {
  request_id: string;
  credential_id: string;
  device_kind: DeviceKind;
  state: string;
  bootstrap_ceremony: boolean;
  required_approvals: number;
}

export async function finishSoftwareEnrollment(params: {
  userId: string;
  publicKey: string;
  deviceKind: 'console' | 'authenticator';
  label?: string;
  proof: SignatureEnvelope;
  actorId: string;
}): Promise<EnrolResult> {
  const user = getUser(params.userId);
  if (!user) throw missing('NO_SUCH_USER');
  assertCustodyAllowed(user.role, params.deviceKind);

  const pending = softwareChallenges.get(params.userId);
  if (!pending || pending.expires < Date.now()) throw bad('NO_ACTIVE_CHALLENGE');
  if (!/^[0-9a-f]{64}$/.test(params.publicKey)) throw bad('BAD_PUBLIC_KEY');

  const payloadHash = hashCanonical(
    enrollmentPayload(params.userId, params.publicKey, pending.challenge),
  );
  const credentialId = await credentialIdFor(params.publicKey, params.deviceKind);

  // Proof of possession, verified against the key being enrolled rather than
  // against anything already trusted. It proves only that the device holds the
  // key; the quorum below decides whether the key speaks for this human.
  const verdict = await verifyAnyEnvelope(
    params.proof,
    { public_key: params.publicKey, counter: -1 },
    { purpose: 'ENROLLMENT', payloadHash },
  );
  if (!verdict.ok) throw bad(`PROOF_${verdict.reason}`, 'Proof of possession failed');

  // Device kind is inside the signature, so a console key cannot enrol itself
  // by simply claiming on the wire to be an authenticator.
  if ('device_kind' in params.proof && params.proof.device_kind !== params.deviceKind) {
    throw bad('DEVICE_KIND_MISMATCH', 'The proof claims a different device kind');
  }
  if (params.proof.credential_id !== credentialId) {
    throw bad('CREDENTIAL_ID_MISMATCH', 'The proof was made under a different credential id');
  }

  softwareChallenges.delete(params.userId);

  return register({
    user,
    credentialId,
    binding: 'software',
    deviceKind: params.deviceKind,
    publicKey: params.publicKey,
    webauthnId: null,
    aaguid: null,
    label: params.label,
    actorId: params.actorId,
  });
}

export async function finishHardwareEnrollment(params: {
  userId: string;
  registration: unknown;
  label?: string;
  actorId: string;
}): Promise<EnrolResult> {
  const user = getUser(params.userId);
  if (!user) throw missing('NO_SUCH_USER');

  const challenge = takeWebauthnChallenge(params.userId);
  const result = await verifyHardwareRegistration({
    response: params.registration,
    expectedChallenge: challenge,
  });
  if (!result.ok || !result.credential) {
    throw bad(`REGISTRATION_${result.reason ?? 'FAILED'}`, 'Hardware registration failed');
  }

  const credentialId = await credentialIdFor(result.credential.webauthn_id, 'hardware');

  return register({
    user,
    credentialId,
    binding: 'hardware',
    deviceKind: 'hardware',
    publicKey: result.credential.public_key,
    webauthnId: result.credential.webauthn_id,
    aaguid: result.aaguid ?? null,
    counter: result.credential.counter,
    label: params.label,
    actorId: params.actorId,
  });
}

function register(params: {
  user: UserRow;
  credentialId: string;
  binding: 'software' | 'hardware';
  deviceKind: DeviceKind;
  publicKey: string;
  webauthnId: string | null;
  aaguid: string | null;
  counter?: number;
  label?: string;
  actorId: string;
}): EnrolResult {
  const existing = getCredential(params.credentialId);
  if (existing && existing.state !== 'REVOKED') throw conflict('CREDENTIAL_EXISTS');

  const bootstrap = inBootstrap();
  const required = requiredApprovalsFor(params.user.role);
  const requestId = randomId('ENR');
  const now = new Date().toISOString();

  tx(() => {
    db.prepare(
      `INSERT INTO credentials
         (credential_id, user_id, binding, device_kind, public_key, webauthn_id, aaguid,
          label, counter, state, created_at, activated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      params.credentialId,
      params.user.id,
      params.binding,
      params.deviceKind,
      params.publicKey,
      params.webauthnId,
      params.aaguid,
      params.label ?? null,
      params.counter ?? 0,
      bootstrap ? 'ACTIVE' : 'PENDING',
      now,
      bootstrap ? now : null,
    );
    db.prepare(
      `INSERT INTO enrollment_requests (id, credential_id, user_id, requested_by, state, required_approvals, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      requestId,
      params.credentialId,
      params.user.id,
      params.actorId,
      bootstrap ? 'APPROVED' : 'PENDING',
      bootstrap ? 0 : required,
      now,
    );
    appendAudit({
      txn_id: null,
      type: 'CREDENTIAL_ENROLL_REQUESTED',
      actor: params.actorId,
      payload: {
        request_id: requestId,
        credential_id: params.credentialId,
        subject: params.user.id,
        role: params.user.role,
        binding: params.binding,
        device_kind: params.deviceKind,
        aaguid: params.aaguid,
        public_key: params.publicKey,
        required_approvals: bootstrap ? 0 : required,
        bootstrap_ceremony: bootstrap,
      },
    });
    if (bootstrap) {
      appendAudit({
        txn_id: null,
        type: 'CREDENTIAL_ENROLLED',
        actor: params.actorId,
        payload: {
          credential_id: params.credentialId,
          subject: params.user.id,
          binding: params.binding,
          device_kind: params.deviceKind,
          via: 'BOOTSTRAP_CEREMONY',
          note: 'Activated without quorum: fewer than two executive credentials existed.',
        },
      });
    }
  });

  if (bootstrap) publishKeyDirectory();
  broadcast('enrollment.changed', {
    request_id: requestId,
    state: bootstrap ? 'APPROVED' : 'PENDING',
  });

  return {
    request_id: requestId,
    credential_id: params.credentialId,
    device_kind: params.deviceKind,
    state: bootstrap ? 'ACTIVE' : 'PENDING',
    bootstrap_ceremony: bootstrap,
    required_approvals: bootstrap ? 0 : required,
  };
}

/* --------------------------------------------------------------------------
 * The quorum gate
 *
 * An enrolment approval is itself a signature, not a click. If approving a new
 * key needed only a session, then stealing a session would be enough to enrol a
 * key for the CFO -- and the whole model would rest on cookies again. So an
 * approver signs, with a credential already enrolled and of a permitted custody
 * tier, over the exact public key being admitted.
 * ------------------------------------------------------------------------ */

/** What an approver signs to admit a new credential. */
export function enrollmentApprovalPayload(params: {
  request_id: string;
  credential_id: string;
  subject_user_id: string;
  public_key: string;
  approver_id: string;
}) {
  return { v: 1, type: 'enrollment_approval', ...params };
}

export async function approveEnrollment(
  requestId: string,
  approver: UserRow,
  assertion: ReturnType<typeof enrollmentApprovalPayload>,
  envelope: SignatureEnvelope,
) {
  const req = db.prepare(`SELECT * FROM enrollment_requests WHERE id = ?`).get(requestId) as
    | {
        id: string;
        credential_id: string;
        user_id: string;
        state: string;
        required_approvals: number;
      }
    | undefined;
  if (!req) throw missing('NO_SUCH_ENROLLMENT');
  if (req.state !== 'PENDING') throw conflict('ENROLLMENT_NOT_PENDING', `Request is ${req.state}`);
  if (!EXECUTIVE_ROLES.has(approver.role)) throw denied('ROLE_CANNOT_APPROVE_ENROLLMENT');
  if (req.user_id === approver.id) {
    throw denied('SELF_ENROLLMENT_APPROVAL', 'You cannot approve enrollment of your own key');
  }

  const subject = getCredential(req.credential_id)!;

  // The approver signs over the exact key being admitted, not over a request id
  // they never looked at. What-you-see-is-what-you-sign applies to key
  // ceremonies too.
  const expected = enrollmentApprovalPayload({
    request_id: requestId,
    credential_id: req.credential_id,
    subject_user_id: req.user_id,
    public_key: subject.public_key,
    approver_id: approver.id,
  });
  if (canonicalize(assertion) !== canonicalize(expected)) {
    throw bad('ENROLLMENT_ASSERTION_MISMATCH', 'Approval does not describe this enrolment');
  }

  const approverCred = getCredential(envelope?.credential_id ?? '');
  if (!approverCred) throw bad('UNKNOWN_CREDENTIAL');
  if (approverCred.state !== 'ACTIVE') throw denied('CREDENTIAL_NOT_ACTIVE');
  if (approverCred.user_id !== approver.id) throw denied('CREDENTIAL_NOT_OWNED_BY_APPROVER');
  assertCustodyAllowed(approver.role, approverCred.device_kind);

  const checked = await verifyAnyEnvelope(envelope, approverCred, {
    purpose: 'ENROLLMENT',
    payloadHash: hashCanonical(expected),
  });
  if (!checked.ok) throw bad(`SIGNATURE_${checked.reason}`, 'Enrolment approval did not verify');
  if ((checked.counter ?? 0) <= approverCred.counter) throw bad('COUNTER_REPLAY');

  const now = new Date().toISOString();
  tx(() => {
    db.prepare(
      `INSERT OR IGNORE INTO enrollment_approvals
         (request_id, approver_id, assertion_json, envelope_json, credential_id, at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      requestId,
      approver.id,
      canonicalize(expected),
      JSON.stringify(envelope),
      approverCred.credential_id,
      now,
    );
    db.prepare(`UPDATE credentials SET counter = ? WHERE credential_id = ?`).run(
      checked.counter ?? approverCred.counter + 1,
      approverCred.credential_id,
    );
    appendAudit({
      txn_id: null,
      type: 'CREDENTIAL_ENROLL_APPROVED',
      actor: approver.id,
      payload: {
        request_id: requestId,
        credential_id: req.credential_id,
        approver_credential: approverCred.credential_id,
        approver_device_kind: approverCred.device_kind,
        role: approver.role,
      },
    });
  });

  const count = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM enrollment_approvals WHERE request_id = ?`)
      .get(requestId) as { n: number }
  ).n;

  if (count >= req.required_approvals) {
    tx(() => {
      db.prepare(`UPDATE enrollment_requests SET state = 'APPROVED' WHERE id = ?`).run(requestId);
      db.prepare(
        `UPDATE credentials SET state = 'ACTIVE', activated_at = ? WHERE credential_id = ?`,
      ).run(now, req.credential_id);
      appendAudit({
        txn_id: null,
        type: 'CREDENTIAL_ENROLLED',
        actor: null,
        payload: {
          credential_id: req.credential_id,
          subject: req.user_id,
          device_kind: subject.device_kind,
          via: 'QUORUM',
          approvals: count,
        },
      });
    });
    publishKeyDirectory();
  }

  broadcast('enrollment.changed', { request_id: requestId, approvals: count });
  return {
    request_id: requestId,
    approvals: count,
    required: req.required_approvals,
    activated: count >= req.required_approvals,
  };
}

export interface EnrollmentListRow {
  id: string;
  credential_id: string;
  user_id: string;
  requested_by: string;
  state: string;
  required_approvals: number;
  created_at: string;
  name: string;
  role: string;
  binding: 'software' | 'hardware';
  device_kind: DeviceKind;
  public_key: string;
  credential_state: string;
  approvals: number;
  approvers: Array<{ approver_id: string; at: string }>;
}

export function listEnrollments(): EnrollmentListRow[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.credential_id, r.user_id, r.requested_by, r.state, r.required_approvals,
              r.created_at, u.name, u.role, c.binding, c.device_kind, c.public_key,
              c.state AS credential_state
       FROM enrollment_requests r
       JOIN users u ON u.id = r.user_id
       JOIN credentials c ON c.credential_id = r.credential_id
       ORDER BY r.created_at DESC LIMIT 50`,
    )
    .all() as unknown as Array<Omit<EnrollmentListRow, 'approvals' | 'approvers'>>;

  return rows.map((r) => ({
    ...r,
    approvals: (
      db
        .prepare(`SELECT COUNT(*) AS n FROM enrollment_approvals WHERE request_id = ?`)
        .get(r.id) as { n: number }
    ).n,
    approvers: db
      .prepare(`SELECT approver_id, at FROM enrollment_approvals WHERE request_id = ?`)
      .all(r.id) as unknown as Array<{ approver_id: string; at: string }>,
  }));
}
