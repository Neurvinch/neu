import * as ed from '@noble/ed25519';
import { canonicalize } from './canonical.js';
import { fromB64u, fromHex, sha256Hex, toB64u, toHex, utf8 } from './bytes.js';
import { isWebAuthnEnvelope } from './types.js';
import type {
  ApprovalAssertion,
  DeviceKind,
  Ed25519Assertion,
  Ed25519Envelope,
  SignatureCore,
  SignatureEnvelope,
  SignaturePurpose,
  TransactionIntent,
} from './types.js';

/* ---------------------------------------------------------------------------
 * Hashes over canonical objects
 * ------------------------------------------------------------------------- */

export function intentHash(intent: TransactionIntent): Promise<string> {
  return sha256Hex(canonicalize(intent));
}

export function approvalHash(assertion: ApprovalAssertion): Promise<string> {
  return sha256Hex(canonicalize(assertion));
}

/* ---------------------------------------------------------------------------
 * The signed bytes
 *
 * We never sign a bare hash. For Ed25519 the bytes handed to the curve are the
 * canonical form of the whole assertion: domain, purpose, credential, device
 * kind, counter, presence flag and timestamp are all covered. Two consequences:
 *
 *   - an INTENT signature cannot be replayed as an APPROVAL (domain + purpose
 *     separation), and
 *   - the counter, the device kind and the timestamp are not server-supplied
 *     metadata that anyone can edit after the fact -- they are inside the
 *     signature.
 * ------------------------------------------------------------------------- */

export function assertionBytes(assertion: Ed25519Assertion): Uint8Array {
  return utf8(canonicalize(assertion));
}

/**
 * WebAuthn signs a challenge, so the challenge is the hash of the core facts.
 * Same binding, expressed in the 32 bytes the standard gives us.
 */
export function coreOf(env: SignatureCore): SignatureCore {
  return {
    v: env.v,
    domain: env.domain,
    purpose: env.purpose,
    credential_id: env.credential_id,
    payload_hash: env.payload_hash,
  };
}

export function webauthnChallenge(core: SignatureCore): Promise<string> {
  return sha256Hex(canonicalize(coreOf(core)));
}

/* ---------------------------------------------------------------------------
 * Signer abstraction
 *
 * Three implementations sit behind this: a console-resident software key, the
 * same software key living in the Authenticator app, and a WebAuthn/FIDO2
 * credential. Nothing downstream branches on which one produced a signature --
 * it reads `device_kind` and applies policy.
 * ------------------------------------------------------------------------- */

export interface SealSigner {
  readonly credentialId: string;
  readonly deviceKind: DeviceKind;
  sign(purpose: SignaturePurpose, payloadHash: string): Promise<SignatureEnvelope>;
}

/** Where the monotonic signature counter is persisted for this credential. */
export interface CounterStore {
  next(credentialId: string): Promise<number>;
}

export function memoryCounterStore(start = 0): CounterStore {
  let n = start;
  return { next: async () => ++n };
}

export interface SoftwareSignerOptions {
  credentialId: string;
  /** 32-byte Ed25519 seed. Never leaves the device it was generated on. */
  privateKey: Uint8Array;
  counters: CounterStore;
  deviceKind: 'console' | 'authenticator';
  /** Set by the caller once the passphrase gate has been satisfied. */
  userPresence?: boolean;
}

export function createSoftwareSigner(opts: SoftwareSignerOptions): SealSigner {
  return {
    credentialId: opts.credentialId,
    deviceKind: opts.deviceKind,
    async sign(purpose, payloadHash) {
      const assertion: Ed25519Assertion = {
        v: 1,
        domain: 'SEAL-v1',
        alg: 'Ed25519',
        binding: 'software',
        device_kind: opts.deviceKind,
        purpose,
        credential_id: opts.credentialId,
        payload_hash: payloadHash,
        counter: await opts.counters.next(opts.credentialId),
        user_presence: opts.userPresence ?? true,
        signed_at: new Date().toISOString(),
      };
      const sig = await ed.signAsync(assertionBytes(assertion), opts.privateKey);
      return { ...assertion, signature: toB64u(sig) };
    },
  };
}

/* ---------------------------------------------------------------------------
 * Key material
 * ------------------------------------------------------------------------- */

export async function generateKeyPair(): Promise<{ privateKey: Uint8Array; publicKeyHex: string }> {
  const privateKey = ed.utils.randomPrivateKey();
  const pub = await ed.getPublicKeyAsync(privateKey);
  return { privateKey, publicKeyHex: toHex(pub) };
}

export async function publicKeyFrom(privateKey: Uint8Array): Promise<string> {
  return toHex(await ed.getPublicKeyAsync(privateKey));
}

/** Deterministic credential id, so the same key never enrols twice under two names. */
export async function credentialIdFor(material: string, kind: DeviceKind) {
  const h = await sha256Hex(utf8(material));
  const prefix = kind === 'hardware' ? 'hw' : kind === 'authenticator' ? 'auth' : 'sw';
  return `${prefix}_${h.slice(0, 20)}`;
}

/* ---------------------------------------------------------------------------
 * Verification
 *
 * Ed25519 verification runs anywhere -- the server, the payment rail, a test.
 * WebAuthn verification needs to parse authenticator data and CBOR keys, so it
 * lives in `@seal/shared/webauthn`, which only Node consumers import. Calling
 * this on a hardware envelope fails closed rather than silently passing.
 * ------------------------------------------------------------------------- */

export interface VerifyResult {
  ok: boolean;
  reason?: string;
  /** Counter reported by the credential, whatever the algorithm. */
  counter?: number;
  userVerified?: boolean;
}

export function checkCore(
  env: SignatureEnvelope,
  expected: { purpose: SignaturePurpose; payloadHash: string },
): VerifyResult | null {
  if (env?.v !== 1) return { ok: false, reason: 'UNSUPPORTED_ENVELOPE_VERSION' };
  if (env.domain !== 'SEAL-v1') return { ok: false, reason: 'WRONG_DOMAIN' };
  if (env.purpose !== expected.purpose) return { ok: false, reason: 'PURPOSE_MISMATCH' };
  if (env.payload_hash !== expected.payloadHash) return { ok: false, reason: 'PAYLOAD_HASH_MISMATCH' };
  return null;
}

export async function verifyEnvelope(
  env: SignatureEnvelope,
  publicKeyHex: string,
  expected: { purpose: SignaturePurpose; payloadHash: string },
): Promise<VerifyResult> {
  const bad = checkCore(env, expected);
  if (bad) return bad;

  if (isWebAuthnEnvelope(env)) {
    return { ok: false, reason: 'WEBAUTHN_NEEDS_SERVER_VERIFIER' };
  }
  if (env.alg !== 'Ed25519') return { ok: false, reason: 'UNSUPPORTED_ALG' };

  const { signature, ...assertion } = env as Ed25519Envelope;
  let ok = false;
  try {
    ok = await ed.verifyAsync(fromB64u(signature), assertionBytes(assertion), fromHex(publicKeyHex));
  } catch {
    return { ok: false, reason: 'MALFORMED_SIGNATURE' };
  }
  return ok
    ? { ok: true, counter: env.counter, userVerified: env.user_presence }
    : { ok: false, reason: 'BAD_SIGNATURE' };
}
