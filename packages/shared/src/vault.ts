/**
 * The software credential vault.
 *
 * Browser-only (it uses localStorage and WebCrypto), so it is exported from
 * `@seal/shared/vault` rather than from the package index, and Node consumers
 * never pull it in by accident.
 *
 * One implementation, two very different security postures, distinguished by
 * `deviceKind`:
 *
 *   console       the key sits in the same browser that composes payments.
 *                 Whatever compromises that browser can also sign. Barred for
 *                 executives; the server rejects such signatures outright.
 *
 *   authenticator the key sits in the SEAL Authenticator, on the executive's
 *                 own device at its own origin. The console can only ask for a
 *                 signature and cannot produce one, so compromising the console
 *                 is no longer enough to move money.
 *
 * What the vault gives you either way: the private key is generated on the
 * device and never leaves it, it is sealed at rest with AES-GCM under a key
 * derived from a passphrase (PBKDF2-SHA256, 310k iterations), and the
 * passphrase is required for *every* signature -- so `user_presence` on the
 * envelope is a true statement rather than a decoration.
 *
 * What it does not give you, and what WebAuthn does: resistance to malware on
 * an unlocked device. A copy of localStorage plus a keylogger is a cloned
 * credential. A FIDO2 authenticator cannot be copied and needs a physical
 * gesture. That gap is why the risk engine still charges a premium here.
 */
import { credentialIdFor, createSoftwareSigner, generateKeyPair } from './signing.js';
import { fromB64u, toB64u } from './bytes.js';
import type { SealSigner, SignatureEnvelope, SignaturePurpose } from './index.js';

const KDF_ITERATIONS = 310_000;

export interface Vault {
  v: 1;
  user_id: string;
  credential_id: string;
  public_key: string;
  device_kind: 'console' | 'authenticator';
  label: string;
  created_at: string;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
  cipher: { name: 'AES-GCM'; iv: string; ct: string };
  counter: number;
}

export class WrongPassphrase extends Error {
  constructor() {
    super('That passphrase does not open this credential.');
  }
}

export interface VaultStore {
  readonly deviceKind: 'console' | 'authenticator';
  load(userId: string): Vault | null;
  save(vault: Vault): void;
  forget(userId: string): void;
  create(params: { userId: string; passphrase: string; label: string }): Promise<Vault>;
  unlock(vault: Vault, passphrase: string): Promise<Uint8Array>;
  sign(
    userId: string,
    purpose: SignaturePurpose,
    payloadHash: string,
    passphrase: string,
  ): Promise<SignatureEnvelope>;
  signer(userId: string, privateKey: Uint8Array): SealSigner;
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

export function createVaultStore(opts: {
  /** Storage prefix. Separate origins already separate storage; this keeps a
   *  single origin from ever confusing a console key with an authenticator one. */
  namespace: string;
  deviceKind: 'console' | 'authenticator';
}): VaultStore {
  const key = (userId: string) => `${opts.namespace}.${userId}`;

  const load = (userId: string): Vault | null => {
    const raw = localStorage.getItem(key(userId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Vault;
    } catch {
      return null;
    }
  };

  const save = (vault: Vault) => localStorage.setItem(key(vault.user_id), JSON.stringify(vault));

  const unlock = async (vault: Vault, passphrase: string): Promise<Uint8Array> => {
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
  };

  /** Monotonic counter, persisted. A counter that goes backwards means a clone. */
  const nextCounter = (userId: string): number => {
    const v = load(userId);
    if (!v) throw new Error('no credential on this device');
    v.counter += 1;
    save(v);
    return v.counter;
  };

  const signer = (userId: string, privateKey: Uint8Array): SealSigner => {
    const vault = load(userId);
    if (!vault) throw new Error('no credential on this device');
    return createSoftwareSigner({
      credentialId: vault.credential_id,
      privateKey,
      counters: { next: async () => nextCounter(userId) },
      deviceKind: opts.deviceKind,
      userPresence: true,
    });
  };

  return {
    deviceKind: opts.deviceKind,
    load,
    save,
    forget: (userId) => localStorage.removeItem(key(userId)),
    unlock,
    signer,

    async create({ userId, passphrase, label }) {
      const { privateKey, publicKeyHex } = await generateKeyPair();
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const aes = await deriveKey(passphrase, salt);
      const ct = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv as BufferSource },
        aes,
        privateKey as BufferSource,
      );

      const vault: Vault = {
        v: 1,
        user_id: userId,
        credential_id: await credentialIdFor(publicKeyHex, opts.deviceKind),
        public_key: publicKeyHex,
        device_kind: opts.deviceKind,
        label,
        created_at: new Date().toISOString(),
        kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: KDF_ITERATIONS, salt: toB64u(salt) },
        cipher: { name: 'AES-GCM', iv: toB64u(iv), ct: toB64u(new Uint8Array(ct)) },
        counter: 0,
      };
      save(vault);
      return vault;
    },

    /** Open the vault for exactly one signature. The key is never cached. */
    async sign(userId, purpose, payloadHash, passphrase) {
      const vault = load(userId);
      if (!vault) throw new Error('No credential on this device. Enrol one first.');
      const privateKey = await unlock(vault, passphrase);
      try {
        return await signer(userId, privateKey).sign(purpose, payloadHash);
      } finally {
        // The decrypted key does not outlive the signature it was opened for.
        privateKey.fill(0);
      }
    },
  };
}
