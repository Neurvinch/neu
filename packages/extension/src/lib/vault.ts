import { createSoftwareSigner, credentialIdFor, generateKeyPair } from '@seal/shared';
import { fromB64u, toB64u } from '@seal/shared';
import type { SignatureEnvelope, SignaturePurpose } from '@seal/shared';

/**
 * The extension's key vault.
 *
 * It lives in the service worker rather than in a page, for two reasons that
 * matter:
 *
 *   - `chrome.storage.local` belongs to the extension, not to whatever site is
 *     open. A compromised WhatsApp Web page cannot read it, which is exactly
 *     what a page-resident console key fails at.
 *   - A content script shares the *page's* storage and the page's world, so it
 *     must never hold key material. It hashes bytes and asks; the worker signs.
 *
 * It is still a key on the same laptop as the browser, which is why the custody
 * tier is `extension` (+8 risk) rather than `authenticator` (+5). A phone is
 * still better and the UI says so.
 */

const KDF_ITERATIONS = 310_000;
const KEY = 'seal.extension.vault';

export interface Vault {
  v: 1;
  user_id: string;
  credential_id: string;
  public_key: string;
  device_kind: 'extension';
  label: string;
  created_at: string;
  kdf: { salt: string; iterations: number };
  cipher: { iv: string; ct: string };
  counter: number;
}

export class WrongPassphrase extends Error {
  constructor() {
    super('That passphrase does not open this key.');
  }
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: KDF_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function loadVault(): Promise<Vault | null> {
  const stored = await chrome.storage.local.get(KEY);
  return (stored[KEY] as Vault) ?? null;
}

async function saveVault(v: Vault): Promise<void> {
  await chrome.storage.local.set({ [KEY]: v });
}

export async function forgetVault(): Promise<void> {
  await chrome.storage.local.remove(KEY);
  lock();
}

export async function createVault(params: {
  userId: string;
  passphrase: string;
  label: string;
}): Promise<Vault> {
  const { privateKey, publicKeyHex } = await generateKeyPair();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aes = await deriveKey(params.passphrase, salt);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    aes,
    privateKey as BufferSource,
  );

  const vault: Vault = {
    v: 1,
    user_id: params.userId,
    credential_id: await credentialIdFor(publicKeyHex, 'extension'),
    public_key: publicKeyHex,
    device_kind: 'extension',
    label: params.label,
    created_at: new Date().toISOString(),
    kdf: { salt: toB64u(salt), iterations: KDF_ITERATIONS },
    cipher: { iv: toB64u(iv), ct: toB64u(new Uint8Array(ct)) },
    counter: 0,
  };
  await saveVault(vault);
  return vault;
}

export async function unlockKey(vault: Vault, passphrase: string): Promise<Uint8Array> {
  const aes = await deriveKey(passphrase, fromB64u(vault.kdf.salt));
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64u(vault.cipher.iv) as BufferSource },
      aes,
      fromB64u(vault.cipher.ct) as BufferSource,
    );
    return new Uint8Array(plain);
  } catch {
    throw new WrongPassphrase();
  }
}

/* --------------------------------------------------------------------------
 * The unlock window
 *
 * A deliberate split, and the one place this differs from the phone app.
 *
 * Signing media is a bulk activity -- an executive who has just posted four
 * clips should not type a passphrase four times, and if we make them, they will
 * stop signing anything and the whole provenance story dies. So MEDIA
 * signatures may use a short in-memory unlock.
 *
 * Money is not bulk. INTENT and APPROVAL always demand the passphrase again,
 * every single time, so `user_presence` on those envelopes stays a true
 * statement about a human who was actually there.
 * ------------------------------------------------------------------------ */

const UNLOCK_MS = 5 * 60_000;
let cached: { key: Uint8Array; until: number } | null = null;

export function lock(): void {
  cached?.key.fill(0);
  cached = null;
}

export function unlockedUntil(): number | null {
  if (!cached || cached.until < Date.now()) return null;
  return cached.until;
}

const BULK_PURPOSES = new Set<SignaturePurpose>(['MEDIA']);

export async function signWithVault(params: {
  purpose: SignaturePurpose;
  payloadHash: string;
  passphrase?: string;
  /** Keep the key in memory afterwards. Only honoured for bulk purposes. */
  remember?: boolean;
}): Promise<SignatureEnvelope> {
  const vault = await loadVault();
  if (!vault) throw new Error('No key in this extension yet. Set one up first.');

  const mayReuse = BULK_PURPOSES.has(params.purpose);
  let key: Uint8Array | null = null;
  let fromCache = false;

  if (mayReuse && cached && cached.until > Date.now()) {
    key = cached.key;
    fromCache = true;
  } else {
    if (!params.passphrase) {
      const err = new Error('PASSPHRASE_REQUIRED');
      err.name = 'PassphraseRequired';
      throw err;
    }
    key = await unlockKey(vault, params.passphrase);
  }

  try {
    const signer = createSoftwareSigner({
      credentialId: vault.credential_id,
      privateKey: key,
      deviceKind: 'extension',
      userPresence: true,
      counters: {
        next: async () => {
          const v = (await loadVault())!;
          v.counter += 1;
          await saveVault(v);
          return v.counter;
        },
      },
    });
    return await signer.sign(params.purpose, params.payloadHash);
  } finally {
    if (mayReuse && params.remember && !fromCache) {
      lock();
      cached = { key: key!, until: Date.now() + UNLOCK_MS };
    } else if (!fromCache) {
      key!.fill(0);
    }
  }
}
