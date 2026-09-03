import { createVaultStore } from '@seal/shared/vault';
import { createHardwareSigner, registerHardwareCredential } from '@seal/shared/hardware';
import { canonicalize, sha256Hex, utf8 } from '@seal/shared';
import type { SealSigner, SignatureEnvelope, SignaturePurpose } from '@seal/shared';

/**
 * This device.
 *
 * The Authenticator holds keys the console cannot reach: different origin,
 * different storage, and in the hardware case a key that no software anywhere
 * can read. Everything the app can do is in this file, and none of it can be
 * driven remotely -- a signature only happens when a human here provides a
 * passphrase or a biometric gesture.
 */

export const vault = createVaultStore({
  namespace: 'seal.authenticator.vault',
  deviceKind: 'authenticator',
});

export const hashOf = (value: unknown) => sha256Hex(utf8(canonicalize(value)));

/* --------------------------------------------------------------------------
 * Hardware credentials
 * ------------------------------------------------------------------------ */

export interface HardwareRef {
  credential_id: string;
  webauthn_id: string;
  rp_id: string;
}

const HW_KEY = 'seal.authenticator.hardware';

export function loadHardware(userId: string): HardwareRef | null {
  try {
    const all = JSON.parse(localStorage.getItem(HW_KEY) ?? '{}') as Record<string, HardwareRef>;
    return all[userId] ?? null;
  } catch {
    return null;
  }
}

export function saveHardware(userId: string, ref: HardwareRef): void {
  const all = JSON.parse(localStorage.getItem(HW_KEY) ?? '{}') as Record<string, HardwareRef>;
  all[userId] = ref;
  localStorage.setItem(HW_KEY, JSON.stringify(all));
}

export function forgetHardware(userId: string): void {
  const all = JSON.parse(localStorage.getItem(HW_KEY) ?? '{}') as Record<string, HardwareRef>;
  delete all[userId];
  localStorage.setItem(HW_KEY, JSON.stringify(all));
}

export { registerHardwareCredential };

export function hardwareSigner(ref: HardwareRef): SealSigner {
  return createHardwareSigner({
    credentialId: ref.credential_id,
    webauthnId: ref.webauthn_id,
    rpId: ref.rp_id,
  });
}

/* --------------------------------------------------------------------------
 * One entry point for producing a signature
 * ------------------------------------------------------------------------ */

export type Credential =
  | { kind: 'hardware'; ref: HardwareRef; credential_id: string }
  | { kind: 'authenticator'; credential_id: string };

export function localCredentials(userId: string): Credential[] {
  const out: Credential[] = [];
  const hw = loadHardware(userId);
  if (hw) out.push({ kind: 'hardware', ref: hw, credential_id: hw.credential_id });
  const sw = vault.load(userId);
  if (sw) out.push({ kind: 'authenticator', credential_id: sw.credential_id });
  return out;
}

export async function signWith(
  credential: Credential,
  userId: string,
  purpose: SignaturePurpose,
  payloadHash: string,
  passphrase?: string,
): Promise<SignatureEnvelope> {
  if (credential.kind === 'hardware') {
    // No passphrase: the gesture happens inside the authenticator itself.
    return hardwareSigner(credential.ref).sign(purpose, payloadHash);
  }
  if (!passphrase) throw new Error('A passphrase is required to unlock this key.');
  return vault.sign(userId, purpose, payloadHash, passphrase);
}
