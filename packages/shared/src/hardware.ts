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

/**
 * What can answer a challenge right now, without prompting anybody.
 *
 * This is the honest ceiling on "is the hardware near". The browser will tell
 * you whether a built-in authenticator exists and whether a credential could be
 * offered without a modal. It will not tell you that a specific YubiKey is in
 * the room, and no web API will -- so the UI promises exactly this much and no
 * more: whether one touch is likely to be enough.
 */
export interface HardwarePresence {
  /** WebAuthn exists in this browser at all. */
  supported: boolean;
  /** A built-in authenticator (Windows Hello, Touch ID) is usable. */
  platformAuthenticator: boolean;
  /**
   * The browser can surface a stored credential inline. In practice this means
   * a passkey is already within reach, so approval is one gesture away.
   */
  credentialReady: boolean;
}

export async function hardwarePresence(): Promise<HardwarePresence> {
  if (!hardwareAvailable()) {
    return { supported: false, platformAuthenticator: false, credentialReady: false };
  }
  const [platformAuthenticator, credentialReady] = await Promise.all([
    window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().catch(() => false),
    window.PublicKeyCredential.isConditionalMediationAvailable?.().catch(() => false) ??
      Promise.resolve(false),
  ]);
  return { supported: true, platformAuthenticator, credentialReady };
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
        // Reported by the browser, verified by nothing -- so the server treats
        // it as a label on the evidence, never as a reason to accept anything.
        attachment:
          (assertion as { authenticatorAttachment?: 'platform' | 'cross-platform' })
            .authenticatorAttachment ?? null,
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
