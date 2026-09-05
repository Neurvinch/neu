/**
 * WebAuthn / FIDO2 verification.
 *
 * Deliberately NOT exported from the package index: it pulls in a Node-only
 * verifier, and the browser bundle must never see it. Server-side consumers
 * import `@seal/shared/webauthn` explicitly.
 *
 * Both SEAL and the payment rail import this, so both verify a hardware
 * signature with the same code and neither has to ask the other whether a
 * signature was good.
 */
import {
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { fromB64u, toB64u, fromHex } from './bytes.js';
import { checkCore, verifyEnvelope, webauthnChallenge } from './signing.js';
import { isWebAuthnEnvelope } from './types.js';
import type { SignatureEnvelope, SignaturePurpose } from './types.js';
import type { VerifyResult } from './signing.js';

/**
 * localhost is a secure context and a valid Relying Party id, so the demo runs
 * over plain http with real platform authenticators (Windows Hello, Touch ID,
 * a security key). The rp id is the *domain* only, which is why the console on
 * :5173 and the authenticator on :5174 are separate origins but can share one
 * rp -- exactly the split we want.
 */
export const RP_ID = process.env.SEAL_RP_ID ?? 'localhost';
export const RP_NAME = 'SEAL — Signed Executive Authorization Ledger';
export const ALLOWED_ORIGINS = (
  process.env.SEAL_RP_ORIGINS ?? 'http://localhost:5173,http://localhost:5174'
).split(',');

export interface HardwareCredential {
  /** base64url of the raw credential id issued by the authenticator. */
  webauthn_id: string;
  /** base64url of the COSE public key. */
  public_key: string;
  counter: number;
  /**
   * How this authenticator can be reached: usb, nfc, ble, internal, hybrid.
   *
   * "hybrid" is the interesting one -- it is a phone answering over a Bluetooth
   * proximity tunnel, so the protocol itself has already established that the
   * device was in the room. Worth recording; not worth trusting on its own.
   */
  transports?: string[];
}

/* --------------------------------------------------------------------------
 * Registration
 * ------------------------------------------------------------------------ */

export async function verifyHardwareRegistration(params: {
  response: unknown;
  expectedChallenge: string;
}): Promise<{ ok: boolean; reason?: string; credential?: HardwareCredential; aaguid?: string }> {
  try {
    const verification = await verifyRegistrationResponse({
      response: params.response as never,
      expectedChallenge: params.expectedChallenge,
      expectedOrigin: ALLOWED_ORIGINS,
      expectedRPID: RP_ID,
      requireUserVerification: false,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return { ok: false, reason: 'REGISTRATION_NOT_VERIFIED' };
    }

    const info = verification.registrationInfo;
    return {
      ok: true,
      aaguid: info.aaguid,
      credential: {
        webauthn_id: info.credential.id,
        public_key: toB64u(info.credential.publicKey),
        counter: info.credential.counter,
        transports: info.credential.transports ?? [],
      },
    };
  } catch (e) {
    return { ok: false, reason: `REGISTRATION_ERROR: ${(e as Error).message}` };
  }
}

/* --------------------------------------------------------------------------
 * Assertion
 * ------------------------------------------------------------------------ */

/**
 * Verifies a hardware signature and, crucially, that the challenge it signed is
 * the hash of *these* core facts. Without that last check a WebAuthn assertion
 * proves only "this key was touched", not "this key authorized this payment".
 */
export async function verifyHardwareEnvelope(
  env: SignatureEnvelope,
  credential: HardwareCredential,
  expected: { purpose: SignaturePurpose; payloadHash: string },
): Promise<VerifyResult> {
  const bad = checkCore(env, expected);
  if (bad) return bad;
  if (!isWebAuthnEnvelope(env)) return { ok: false, reason: 'NOT_A_HARDWARE_ENVELOPE' };

  const challenge = await webauthnChallenge(env);

  try {
    const verification = await verifyAuthenticationResponse({
      response: {
        id: env.response.id,
        rawId: env.response.rawId,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: env.response.clientDataJSON,
          authenticatorData: env.response.authenticatorData,
          signature: env.response.signature,
          userHandle: env.response.userHandle ?? undefined,
        },
      } as never,
      // The challenge is the hash of the core facts, hex-encoded then b64url'd
      // exactly as the client did it. Any drift and this fails closed.
      expectedChallenge: toB64u(fromHex(challenge)),
      expectedOrigin: ALLOWED_ORIGINS,
      expectedRPID: RP_ID,
      credential: {
        id: credential.webauthn_id,
        publicKey: fromB64u(credential.public_key) as Uint8Array<ArrayBuffer>,
        counter: credential.counter,
      },
      requireUserVerification: false,
    });

    if (!verification.verified) return { ok: false, reason: 'BAD_SIGNATURE' };

    return {
      ok: true,
      counter: verification.authenticationInfo.newCounter,
      userVerified: verification.authenticationInfo.userVerified,
    };
  } catch (e) {
    return { ok: false, reason: `ASSERTION_ERROR: ${(e as Error).message}` };
  }
}

/**
 * The one entry point server-side code should call. Dispatches on algorithm so
 * no caller has to know which kind of credential it is dealing with.
 */
export async function verifyAnyEnvelope(
  env: SignatureEnvelope,
  credential: { public_key: string; webauthn_id?: string | null; counter: number },
  expected: { purpose: SignaturePurpose; payloadHash: string },
): Promise<VerifyResult> {
  if (isWebAuthnEnvelope(env)) {
    if (!credential.webauthn_id) return { ok: false, reason: 'CREDENTIAL_IS_NOT_HARDWARE' };
    return verifyHardwareEnvelope(
      env,
      {
        webauthn_id: credential.webauthn_id,
        public_key: credential.public_key,
        counter: credential.counter,
      },
      expected,
    );
  }
  return verifyEnvelope(env, credential.public_key, expected);
}
