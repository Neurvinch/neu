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

export type DeviceKind = 'console' | 'extension' | 'authenticator' | 'hardware';

export type CredentialBinding = 'software' | 'hardware';

export const DEVICE_ASSURANCE: Record<
  DeviceKind,
  { binding: CredentialBinding; label: string; riskPremium: number }
> = {
  console: { binding: 'software', label: 'console-resident key', riskPremium: 12 },
  extension: { binding: 'software', label: 'browser extension key', riskPremium: 8 },
  authenticator: { binding: 'software', label: 'authenticator app', riskPremium: 5 },
  hardware: { binding: 'hardware', label: 'hardware security key', riskPremium: 0 },
};

/**
 * Roles that may not sign a payment with a console-resident key.
 *
 * The browser extension is a separate origin with its own storage, so a
 * compromised web page cannot reach its key -- which is why it is permitted
 * where a page-resident console key is not. It is still on the same machine as
 * the browser, so it carries a premium and a phone remains the stronger choice.
 */
export const OUT_OF_BAND_ROLES: Role[] = ['CFO', 'CEO', 'CTO', 'TREASURY'];

export type SignaturePurpose =
  | 'INTENT'
  | 'APPROVAL'
  | 'ENROLLMENT'
  | 'ATTESTATION'
  | 'MEDIA';

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
  device_kind: 'console' | 'extension' | 'authenticator';
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
  /** Risk tier where one is already known (approvals). */
  tier?: RiskTier | null;
  /**
   * What is unusual about this request, computed server-side and rendered on
   * the signing device. A CFO glancing at her phone should not have to
   * cross-reference a vendor master in her head.
   */
  warnings: string[];
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
 * Media attestations -- provenance for the file itself
 *
 * The same idea as everything else here, pointed at a video instead of a
 * payment. Nobody is asked whether a clip looks synthetic. The question is
 * whether the person it claims to be from signed it.
 *
 * An executive signs the media *as delivered* -- the exact bytes the recipients
 * received, after the messaging app has finished re-encoding it. Signing the
 * file before upload would be useless: WhatsApp recompresses, the digest moves,
 * and every recipient sees a broken signature. So the sender posts first, then
 * signs what landed.
 *
 * What a valid attestation proves: this exact file passed through the hands of
 * someone holding that key, who was willing to put their name on it.
 *
 * What it does not prove: that the content is true. A signature is provenance,
 * not veracity. Its real power is the negative case -- an unsigned "urgent
 * message from the CFO" is now conspicuously unsigned, in a channel where
 * everything genuine carries a signature.
 * ------------------------------------------------------------------------- */

export type MediaKind = 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE';

/** The object a signer signs to vouch for one exact file. */
export interface MediaAttestation {
  v: 1;
  type: 'media_attestation';
  /** SHA-256 of the delivered bytes, computed locally on both ends. */
  sha256: string;
  kind: MediaKind;
  bytes: number;
  /** Where it was posted, and what the signer says it is. */
  platform: string;
  caption: string;
  signer_id: string;
  at: string;
}

export interface MediaRecord {
  sha256: string;
  kind: MediaKind;
  bytes: number;
  platform: string;
  caption: string;
  signer_id: string;
  signer_name: string;
  signer_role: Role;
  device_kind: DeviceKind;
  credential_id: string;
  signed_at: string;
  recorded_at: string;
  audit_seq: number;
}

export interface MediaLookup {
  sha256: string;
  signed: boolean;
  /** Every signature over this exact file. Usually zero or one. */
  attestations: MediaRecord[];
  headline: string;
  detail: string;
}

/* ---------------------------------------------------------------------------
 * Caller challenges -- the answer to a deepfaked video call
 *
 * Signatures already make the *transaction* unforgeable. They do nothing for
 * the human standing in front of a screen while a perfect copy of their CFO's
 * face and voice tells them to hurry up. That person still has a real decision
 * to make, and the interface is where it is won or lost.
 *
 * So we stop asking people to detect a fake and give them something a fake
 * cannot survive: a challenge only the genuine person's enrolled device can
 * answer. The person being pressured raises a challenge; a short code appears
 * on the claimed executive's device and nowhere else; they ask the caller to
 * read it back. A deepfake has the face and the voice. It does not have the
 * phone in that person's pocket.
 *
 * The reverse direction matters just as much: the real executive is asked
 * "are you on a call with Aravind right now?". If they are not, one tap tells
 * everyone -- and the impersonation is discovered from the other end, by the
 * person being impersonated, without anyone having to spot a rendering artefact.
 * ------------------------------------------------------------------------- */

export type CallerChannel = 'PHONE' | 'VIDEO' | 'MEETING' | 'EMAIL' | 'CHAT' | 'IN_PERSON';

export type CallerChallengeState = 'PENDING' | 'CONFIRMED' | 'DENIED' | 'EXPIRED';

export interface CallerChallenge {
  id: string;
  /** Who the caller claims to be. */
  claimed_user_id: string;
  claimed_name: string;
  claimed_role: Role;
  /** Who is being pressured. */
  raised_by: string;
  raised_by_name: string;
  channel: CallerChannel;
  /** What the caller is asking for, in the words of the person being asked. */
  demand: string;
  /**
   * The read-back code. Shown to the person who raised the challenge and on the
   * claimed executive's enrolled device -- nowhere else, and never over the
   * channel the caller is using.
   */
  code: string;
  state: CallerChallengeState;
  txn_id?: string | null;
  escrow_id?: string | null;
  created_at: string;
  expires_at: string;
  seconds_remaining: number;
  resolved_at?: string | null;
  /** Present once confirmed: the signed attestation from the executive's device. */
  attested?: boolean;
}

/** What an executive signs to attest that they really are on this call. */
export interface CallerAttestation {
  v: 1;
  type: 'caller_attestation';
  challenge_id: string;
  claimed_user_id: string;
  raised_by: string;
  channel: CallerChannel;
  code: string;
  at: string;
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
  | 'CALLER_CHALLENGE_RAISED'
  | 'CALLER_CONFIRMED'
  | 'CALLER_DENIED'
  | 'CALLER_CHALLENGE_EXPIRED'
  | 'IMPERSONATION_REPORTED'
  | 'MEDIA_SIGNED'
  | 'MEDIA_VERIFY_FAILED'
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
