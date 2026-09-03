/**
 * The hardware signer: a WebAuthn / FIDO2 credential driven from the browser.
 *
 * Browser-only, so it lives behind `@seal/shared/hardware` and is never pulled
 * into a Node bundle.
 *
 * The important line in this file is the challenge. WebAuthn signs 32 bytes of
 * the relying party's choosing, and everything rests on what those bytes are.
 * Here they are the hash of the core facts of the signature -- domain, purpose,
 * credential, payload hash -- so a hardware assertion proves not merely "this
 * key was touched" but "this key authorized this exact payload, for this exact
 * purpose". Without that binding, a touch harvested for one purpose could be
 * replayed for another.
 */
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { fromHex, toB64u } from './bytes.js';
import { webauthnChallenge } from './signing.js';
import type { SealSigner, SignatureCore, SignaturePurpose, WebAuthnEnvelope } from './index.js';

export function hardwareAvailable(): boolean {
  return typeof window !== 'undefined' && !!window.PublicKeyCredential;
}

export async function platformAuthenticatorAvailable(): Promise<boolean> {
  if (!hardwareAvailable()) return false;
  try {
    return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

/** Runs the registration ceremony. The key is created inside the authenticator. */
export async function registerHardwareCredential(options: unknown) {
  return startRegistration({ optionsJSON: options as never });
}

export function createHardwareSigner(params: {
  credentialId: string;
  /** base64url raw credential id, so the browser asks for this key specifically. */
  webauthnId: string;
  rpId: string;
}): SealSigner {
  return {
    credentialId: params.credentialId,
    deviceKind: 'hardware',

    async sign(purpose: SignaturePurpose, payloadHash: string): Promise<WebAuthnEnvelope> {
      const core: SignatureCore = {
        v: 1,
        domain: 'SEAL-v1',
        purpose,
        credential_id: params.credentialId,
        payload_hash: payloadHash,
      };

      // The challenge IS the binding. Anything else here and the assertion
      // stops being evidence about this payment.
      const challenge = toB64u(fromHex(await webauthnChallenge(core)));

      const assertion = await startAuthentication({
        optionsJSON: {
          challenge,
          rpId: params.rpId,
          allowCredentials: [{ id: params.webauthnId, type: 'public-key' }],
          userVerification: 'preferred',
          timeout: 120_000,
        } as never,
      });

      return {
        ...core,
        alg: 'WebAuthn',
        binding: 'hardware',
        device_kind: 'hardware',
        response: {
          id: assertion.id,
          rawId: assertion.rawId,
          type: 'public-key',
          clientDataJSON: assertion.response.clientDataJSON,
          authenticatorData: assertion.response.authenticatorData,
          signature: assertion.response.signature,
          userHandle: assertion.response.userHandle ?? null,
        },
      };
    },
  };
}
