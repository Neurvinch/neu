/* ---------------------------------------------------------------------------
 * Roles and lanes
 * ------------------------------------------------------------------------- */

export type Role = 'CFO' | 'CEO' | 'CTO' | 'TREASURY' | 'EMPLOYEE' | 'AUDITOR' | 'SECOPS';

/**
 * Lane A  = originated from a signed executive intent (built here).
 * Lane B  = employee-originated, unverified claim (schema reserved, not yet
 *           implemented -- see README "What is deliberately not built yet").
 */
export type Lane = 'A' | 'B';

/* ---------------------------------------------------------------------------
 * Credentials: where the key lives, and what that is worth
 *
 * "Authority comes from a key" is only as strong as the custody of that key,
 * so custody is a first-class field rather than an implementation detail. The
 * ladder, weakest to strongest:
 *
 *   console       software key in the same browser that composes the request.
 *                 Convenient, and the weakest link: whatever compromises the
 *                 console can also sign. Not accepted for executive signing.
 *
 *   authenticator software key in the SEAL Authenticator app, on a separate
 *                 device with its own origin and its own storage. The console
 *                 can only *ask*; the human approves out of band, looking at
 *                 the real fields. This is the "hardware token, in software"
 *                 tier, and it is what executives use.
 *
 *   hardware      WebAuthn / FIDO2. The key is generated inside an
 *                 authenticator and cannot be exported at all, and a physical
 *                 gesture is required that malware cannot perform.
 * ------------------------------------------------------------------------- */

export type DeviceKind = 'console' | 'authenticator' | 'hardware';

export type CredentialBinding = 'software' | 'hardware';

export const DEVICE_ASSURANCE: Record<DeviceKind, { binding: CredentialBinding; label: string; riskPremium: number }> = {
  console: { binding: 'software', label: 'console-resident key', riskPremium: 12 },
  authenticator: { binding: 'software', label: 'authenticator app', riskPremium: 5 },
  hardware: { binding: 'hardware', label: 'hardware security key', riskPremium: 0 },
};

/** Roles that may not sign with a console-resident key. */
export const OUT_OF_BAND_ROLES: Role[] = ['CFO', 'CEO', 'CTO', 'TREASURY'];

export type SignaturePurpose = 'INTENT' | 'APPROVAL' | 'ENROLLMENT';

/* ---------------------------------------------------------------------------
 * Signature envelopes
 *
 * Two algorithms, one set of facts. Whatever the algorithm, a signature is
 * always bound to a domain, a purpose, a credential and a payload hash -- so an
 * INTENT signature can never be replayed as an APPROVAL, and a signature over
 * one payment can never be moved onto another.
 * ------------------------------------------------------------------------- */

export interface SignatureCore {
  v: 1;
  domain: 'SEAL-v1';
  purpose: SignaturePurpose;
  credential_id: string;
  /** SHA-256 (hex) of the JCS form of the object being authorized. */
  payload_hash: string;
}

/**
 * Software credentials sign the canonical form of the whole assertion, so the
 * counter, the device kind, the presence flag and the timestamp are all inside
 * the signature rather than being server-side metadata anyone could edit.
 */
export interface Ed25519Assertion extends SignatureCore {
  alg: 'Ed25519';
  binding: 'software';
  device_kind: 'console' | 'authenticator';
  /** Monotonic per-credential counter. A decrease means a cloned key. */
  counter: number;
  /** True when a local gesture unlocked the key (passphrase / biometric). */
  user_presence: boolean;
  signed_at: string;
}

export interface Ed25519Envelope extends Ed25519Assertion {
  /** base64url Ed25519 signature over utf8(JCS(assertion)). */
  signature: string;
}

/**
 * WebAuthn signs a 32-byte challenge, not an arbitrary document. So the
 * challenge *is* the hash of the core facts above, which gives the same
 * binding: a hardware assertion cannot be lifted onto a different purpose,
 * credential or payload.
 *
 * The counter and the presence flags are not client-authored here -- they come
 * out of the authenticator's own signed `authenticatorData`, which is stronger
 * than a self-reported number. `received_at` is stamped by the server on
 * arrival and is deliberately *not* claimed to be signed: WebAuthn does not
 * sign a timestamp, and pretending otherwise would be a lie in the audit trail.
 */
export interface WebAuthnEnvelope extends SignatureCore {
  alg: 'WebAuthn';
  binding: 'hardware';
  device_kind: 'hardware';
  response: {
    id: string;
    rawId: string;
    type: 'public-key';
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string | null;
  };
  /** Filled in by the verifier from authenticatorData; ignored on input. */
  counter?: number;
  user_presence?: boolean;
  user_verified?: boolean;
  received_at?: string;
}

export type SignatureEnvelope = Ed25519Envelope | WebAuthnEnvelope;

export function isWebAuthnEnvelope(e: SignatureEnvelope): e is WebAuthnEnvelope {
  return e?.alg === 'WebAuthn';
}

export function envelopeDeviceKind(e: SignatureEnvelope): DeviceKind {
  return isWebAuthnEnvelope(e) ? 'hardware' : e.device_kind;
}

export function envelopeBinding(e: SignatureEnvelope): CredentialBinding {
  return isWebAuthnEnvelope(e) ? 'hardware' : 'software';
}

/* ---------------------------------------------------------------------------
 * The canonical transaction intent -- the thing the CFO actually signs
 * ------------------------------------------------------------------------- */

export interface Payee {
  name: string;
  account: string;
  ifsc: string;
}

export interface Money {
  /** Decimal string, never a float. Floats are not safe to hash or to pay. */
  value: string;
  currency: 'INR';
}

export interface TransactionIntent {
  v: 1;
  txn_id: string;
  org_id: string;
  type: 'wire_transfer' | 'credential_reset' | 'beneficiary_change';
  payee: Payee;
  amount: Money;
  purpose: string;
  deadline: string;
  originator: { user_id: string; role: Role };
  /** Unique per intent; burned in `consumed_nonces` on first use. */
  nonce: string;
  iat: string;
  exp: string;
}

/* ---------------------------------------------------------------------------
 * Approvals
 * ------------------------------------------------------------------------- */

export type Decision = 'APPROVE' | 'REJECT';

/** What an approver signs. Note it binds the decision to one exact escrow AND
 *  one exact intent hash -- an approval cannot be replayed onto another. */
export interface ApprovalAssertion {
  v: 1;
  type: 'approval';
  escrow_id: string;
  intent_hash: string;
  approver_id: string;
  decision: Decision;
  at: string;
}

/* ---------------------------------------------------------------------------
 * Signing requests -- the out-of-band channel
 *
 * The console never holds an executive's key. It composes a payload and asks
 * for a signature; the request appears on the authenticator, which renders the
 * real fields and signs. Every request carries its own hash, so what the
 * console asked for and what the human saw are provably the same thing.
 * ------------------------------------------------------------------------- */

export type SigningRequestState = 'PENDING' | 'SIGNED' | 'DECLINED' | 'EXPIRED' | 'FAILED';

export type SigningAction =
  | { kind: 'SUBMIT_INTENT'; intent: TransactionIntent }
  | { kind: 'RECORD_APPROVAL'; escrow_id: string; assertion: ApprovalAssertion }
  | { kind: 'APPROVE_ENROLLMENT'; request_id: string };

export interface SigningRequest {
  id: string;
  purpose: SignaturePurpose;
  subject_user_id: string;
  /** Human-facing summary, rendered on the authenticator. */
  title: string;
  subtitle: string;
  rows: Array<[string, string]>;
  /** The exact object that will be hashed and signed. */
  payload: unknown;
  payload_hash: string;
  action: SigningAction;
  state: SigningRequestState;
  requested_by: string;
  requested_from: string;
  created_at: string;
  expires_at: string;
  seconds_remaining: number;
  resolved_at?: string | null;
  error?: string | null;
  result?: Record<string, unknown> | null;
}

/* ---------------------------------------------------------------------------
 * Risk + escrow
 * ------------------------------------------------------------------------- */

export type RiskTier = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface RiskResult {
  tier: RiskTier;
  score: number;
  rules_fired: string[];
  required_approvals: number;
  window_minutes: number;
  notes: string[];
}

export type EscrowState =
  | 'PENDING_QUORUM'
  | 'APPROVED'
  | 'EXECUTED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'ESCALATED';

export type IntentState = 'SIGNED' | 'ACCEPTED' | 'REJECTED' | 'CONSUMED';

export interface ApprovalRecord {
  approver_id: string;
  role: Role;
  decision: Decision;
  at: string;
  binding: CredentialBinding;
  device_kind: DeviceKind;
  credential_id: string;
  signature: string;
}

export interface EscrowView {
  escrow_id: string;
  txn_id: string;
  intent_hash: string;
  lane: Lane;
  state: EscrowState;
  opened_by: string;
  opened_at: string;
  expires_at: string;
  /** Server-computed, so a client with a skewed clock cannot fake urgency. */
  seconds_remaining: number;
  risk: RiskResult;
  required_approvals: number;
  approvals: ApprovalRecord[];
  intent: TransactionIntent;
  signer: {
    user_id: string;
    role: Role;
    binding: CredentialBinding;
    device_kind: DeviceKind;
    credential_id: string;
  };
  receipt?: BankReceipt | null;
}

/* ---------------------------------------------------------------------------
 * The approval bundle -- the only thing the payment rail will accept
 * ------------------------------------------------------------------------- */

export interface ApprovalBundle {
  v: 1;
  escrow_id: string;
  intent: TransactionIntent;
  intent_hash: string;
  lane: Lane;
  intent_signature: SignatureEnvelope;
  approvals: Array<{ assertion: ApprovalAssertion; envelope: SignatureEnvelope }>;
  risk: RiskResult;
  issued_at: string;
}

export interface BankReceipt {
  ok: boolean;
  reference?: string;
  settled_at?: string;
  error?: string;
  checks?: Array<{ name: string; pass: boolean; detail?: string }>;
}

/* ---------------------------------------------------------------------------
 * Audit chain
 * ------------------------------------------------------------------------- */

export type AuditType =
  | 'CREDENTIAL_ENROLL_REQUESTED'
  | 'CREDENTIAL_ENROLL_APPROVED'
  | 'CREDENTIAL_ENROLLED'
  | 'SIGNING_REQUESTED'
  | 'SIGNING_DECLINED'
  | 'SIGNING_EXPIRED'
  | 'INTENT_SIGNED'
  | 'INTENT_VERIFY_FAILED'
  | 'INTENT_ACCEPTED'
  | 'INTENT_REJECTED'
  | 'ESCROW_OPENED'
  | 'APPROVAL_RECORDED'
  | 'APPROVAL_REJECTED'
  | 'QUORUM_MET'
  | 'ESCROW_EXPIRED'
  | 'PAYMENT_SUBMITTED'
  | 'EXECUTED'
  | 'PAYMENT_REFUSED'
  | 'ATTACK_BLOCKED';

export interface AuditEntry {
  seq: number;
  txn_id: string | null;
  type: AuditType;
  at: string;
  actor: string | null;
  payload: Record<string, unknown>;
  prev_hash: string;
  entry_hash: string;
}

export interface ChainVerification {
  ok: boolean;
  entries_checked: number;
  break_at_seq: number | null;
  reason: string | null;
}
