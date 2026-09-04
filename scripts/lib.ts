import {
  buildIntent,
  canonicalize,
  createSoftwareSigner,
  credentialIdFor,
  fromHex,
  generateKeyPair,
  memoryCounterStore,
  toHex,
} from '@seal/shared';
import type {
  CallerAttestation,
  CallerChallenge,
  MediaAttestation,
  MediaLookup,
  MediaRecord,
  Decision,
  SealSigner,
  SigningRequest,
  TransactionIntent,
} from '@seal/shared';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SEAL = process.env.SEAL_URL ?? 'http://localhost:4000';
export const RAIL = process.env.BANK_URL ?? 'http://localhost:4001';

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

export interface ApiError {
  status: number;
  error: string;
  message?: string;
  body: unknown;
}

export async function api<T = unknown>(
  route: string,
  opts: { method?: string; body?: unknown; token?: string } = {},
): Promise<T> {
  const res = await fetch(`${SEAL}${route}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err: ApiError = {
      status: res.status,
      error: (parsed as { error?: string })?.error ?? String(res.status),
      message: (parsed as { message?: string })?.message,
      body: parsed,
    };
    throw err;
  }
  return parsed as T;
}

/* ---------------------------------------------------------------------------
 * Simulated devices
 *
 * Each of these stands in for a SEAL Authenticator: it holds its own key, and
 * it is the only thing that can turn a signing request into a signature. Keys
 * persist to data/ and are reused on the next run -- faithful to a real device,
 * and what makes the simulation re-runnable. Regenerating a key every run would
 * mean re-enrolling every run, and once the bootstrap ceremony closes there
 * would be no active key left to approve the new ones with.
 *
 * The file is gitignored. It is simulation state, not a place for a real key.
 * ------------------------------------------------------------------------- */

const DEVICE_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
  'sim-devices.json',
);

interface StoredDevice {
  private_key: string;
  public_key: string;
  credential_id: string;
}

function loadDevices(): Record<string, StoredDevice> {
  try {
    return JSON.parse(fs.readFileSync(DEVICE_FILE, 'utf8')) as Record<string, StoredDevice>;
  } catch {
    return {};
  }
}

function storeDevice(slot: string, dev: StoredDevice): void {
  const all = loadDevices();
  all[slot] = dev;
  fs.mkdirSync(path.dirname(DEVICE_FILE), { recursive: true });
  fs.writeFileSync(DEVICE_FILE, JSON.stringify(all, null, 2));
}

export interface Device {
  id: string;
  name: string;
  role: string;
  token: string;
  signer: SealSigner;
  publicKey: string;
  credentialId: string;
  /** True when this run reused a key already admitted on a previous run. */
  reused: boolean;
  /** Only meaningful on a fresh enrolment. */
  bootstrap: boolean;
}

export async function login(userId: string, password = 'demo') {
  return api<{ token: string; user: { name: string; role: string } }>('/api/session', {
    body: { user_id: userId, password },
  });
}

/**
 * Reuse this device's key if the server still has it active; otherwise generate
 * one, prove possession, and queue it for quorum.
 *
 * Note the device kind: `authenticator`. A console-resident key is refused
 * outright for any executive role, which is the whole point of the tier.
 */
export async function enroll(
  userId: string,
  label: string,
  deviceKind: 'authenticator' | 'console' | 'extension' = 'authenticator',
): Promise<Device> {
  const session = await login(userId);
  const slot = `${userId}:${deviceKind}`;
  const saved = loadDevices()[slot];

  const me = await api<{
    credentials: Array<{ credential_id: string; state: string; counter: number }>;
  }>('/api/me', { token: session.token });

  const active = saved
    ? me.credentials.find((c) => c.credential_id === saved.credential_id && c.state === 'ACTIVE')
    : undefined;

  if (saved && active) {
    // The server's counter is authoritative -- it is what rejects a clone.
    return {
      id: userId,
      name: session.user.name,
      role: session.user.role,
      token: session.token,
      publicKey: saved.public_key,
      credentialId: saved.credential_id,
      reused: true,
      bootstrap: false,
      signer: createSoftwareSigner({
        credentialId: saved.credential_id,
        privateKey: fromHex(saved.private_key),
        counters: memoryCounterStore(active.counter),
        deviceKind,
      }),
    };
  }

  const { privateKey, publicKeyHex } = await generateKeyPair();
  const signer = createSoftwareSigner({
    credentialId: await credentialIdFor(publicKeyHex, deviceKind),
    privateKey,
    counters: memoryCounterStore(),
    deviceKind,
  });

  const begun = await api<{ challenge: string }>('/api/credentials/enroll/begin', {
    body: { device_kind: deviceKind },
    token: session.token,
  });

  const payload = {
    v: 1,
    type: 'enrollment',
    user_id: userId,
    public_key: publicKeyHex,
    challenge: begun.challenge,
  };
  const proof = await signer.sign('ENROLLMENT', sha256(canonicalize(payload)));

  const finished = await api<{ credential_id: string; bootstrap_ceremony: boolean }>(
    '/api/credentials/enroll/finish',
    {
      body: { public_key: publicKeyHex, device_kind: deviceKind, label, proof },
      token: session.token,
    },
  );

  storeDevice(slot, {
    private_key: toHex(privateKey),
    public_key: publicKeyHex,
    credential_id: finished.credential_id,
  });

  return {
    id: userId,
    name: session.user.name,
    role: session.user.role,
    token: session.token,
    signer,
    publicKey: publicKeyHex,
    credentialId: finished.credential_id,
    reused: false,
    bootstrap: finished.bootstrap_ceremony,
  };
}

/* ---------------------------------------------------------------------------
 * The out-of-band channel
 *
 * Every signature in the system goes through these two steps: the console
 * raises a request, and the device fulfils it. There is no other path in.
 * ------------------------------------------------------------------------- */

/** Sign the hash the request fixed, and hand the signature back. */
export async function fulfil(device: Device, request: SigningRequest) {
  const signature = await device.signer.sign(request.purpose, request.payload_hash);
  return api<SigningRequest>(`/api/signing-requests/${request.id}/fulfil`, {
    body: { signature },
    token: device.token,
  });
}

export async function decline(device: Device, request: SigningRequest, reason = 'Not mine') {
  return api<SigningRequest>(`/api/signing-requests/${request.id}/decline`, {
    body: { reason },
    token: device.token,
  });
}

export function composeIntent(
  device: Device,
  draft: Omit<Parameters<typeof buildIntent>[0], 'originator'>,
): { intent: TransactionIntent; hash: string } {
  const intent = buildIntent({
    ...draft,
    originator: { user_id: device.id, role: device.role as never },
  });
  return { intent, hash: sha256(canonicalize(intent)) };
}

/** Raise the signature request without fulfilling it. */
export async function requestIntent(device: Device, intent: TransactionIntent) {
  return api<SigningRequest>('/api/intents', { body: { intent }, token: device.token });
}

/** Console composes; device authorizes. */
export async function submitIntent(device: Device, intent: TransactionIntent) {
  return fulfil(device, await requestIntent(device, intent));
}

/** Approve or decline an escrow, on the approver's own device. */
export async function approve(device: Device, escrowId: string, decision: Decision = 'APPROVE') {
  const request = await api<SigningRequest>(`/api/escrows/${escrowId}/approvals`, {
    body: { decision },
    token: device.token,
  });
  return fulfil(device, request);
}

/** Admit a new key, signed on the approver's own device. */
export async function approveEnrollment(approver: Device, requestId: string) {
  const request = await api<SigningRequest>(`/api/credentials/enrollments/${requestId}/approve`, {
    body: {},
    token: approver.token,
  });
  return fulfil(approver, request);
}

export async function approveEnrollments(approvers: Device[]) {
  const pending = await api<Array<{ id: string; state: string; user_id: string }>>(
    '/api/credentials/enrollments',
    { token: approvers[0].token },
  );
  for (const req of pending.filter((r) => r.state === 'PENDING')) {
    for (const a of approvers) {
      if (a.id === req.user_id) continue;
      try {
        await approveEnrollment(a, req.id);
      } catch {
        /* already approved, no active credential yet, or not eligible */
      }
    }
  }
}

/* ---------------------------------------------------------------------------
 * Media provenance
 * ------------------------------------------------------------------------- */

/** Stand-in for the extension hashing the delivered bytes in the page. */
export function digestOf(bytes: string): { sha256: string; bytes: number } {
  return { sha256: sha256(bytes), bytes: Buffer.byteLength(bytes) };
}

export async function signMedia(
  device: Device,
  media: { sha256: string; bytes: number; kind: string; caption: string },
) {
  const attestation = await api<MediaAttestation>('/api/media/attestation', {
    body: {
      sha256: media.sha256,
      kind: media.kind,
      bytes: media.bytes,
      platform: 'WhatsApp Web',
      caption: media.caption,
    },
    token: device.token,
  });
  const signature = await device.signer.sign('MEDIA', sha256(canonicalize(attestation)));
  return api<MediaRecord>('/api/media/sign', {
    body: { attestation, signature },
    token: device.token,
  });
}

export async function lookupMedia(device: Device, sha256Hex: string) {
  return api<MediaLookup>(`/api/media/${sha256Hex}`, { token: device.token });
}

/* ---------------------------------------------------------------------------
 * Caller challenges
 * ------------------------------------------------------------------------- */

export async function raiseChallenge(
  raiser: Device,
  claimedUserId: string,
  channel: string,
  demand: string,
  context: { txn_id?: string; escrow_id?: string } = {},
) {
  return api<CallerChallenge>('/api/caller-challenges', {
    body: {
      claimed_user_id: claimedUserId,
      channel,
      demand,
      txn_id: context.txn_id ?? null,
      escrow_id: context.escrow_id ?? null,
      source: { platform: 'WhatsApp Web', url: 'https://web.whatsapp.com/' },
    },
    token: raiser.token,
  });
}

export async function denyChallenge(device: Device, id: string) {
  return api<CallerChallenge>(`/api/caller-challenges/${id}/deny`, {
    body: { note: 'Not me' },
    token: device.token,
  });
}

/** Confirming is signed, so it needs the device -- exactly like everything else. */
export async function confirmChallenge(device: Device, id: string) {
  const attestation = await api<CallerAttestation>(
    `/api/caller-challenges/${id}/attestation`,
    { token: device.token },
  );
  const signature = await device.signer.sign(
    'ATTESTATION',
    sha256(canonicalize(attestation)),
  );
  return api<CallerChallenge>(`/api/caller-challenges/${id}/confirm`, {
    body: { signature },
    token: device.token,
  });
}

export async function lookupClaim(device: Device, txnId: string) {
  return api<{ exists: boolean; authorized: boolean; verdict: string; headline: string }>(
    `/api/claims/lookup?txn_id=${encodeURIComponent(txnId)}`,
    { token: device.token },
  );
}

export async function captureEvidence(device: Device, evidence: Record<string, unknown>) {
  return api<{ seq: number; entry_hash: string }>('/api/evidence', {
    body: evidence,
    token: device.token,
  });
}

/* ---------------------------------------------------------------------------
 * Console formatting
 * ------------------------------------------------------------------------- */

const E = String.fromCharCode(27);
const C = {
  reset: `${E}[0m`,
  dim: `${E}[2m`,
  bold: `${E}[1m`,
  red: `${E}[31m`,
  green: `${E}[32m`,
  yellow: `${E}[33m`,
  cyan: `${E}[36m`,
};

export const fmt = {
  head: (s: string) => console.log(`\n${C.bold}${C.cyan}${s}${C.reset}\n${'-'.repeat(s.length)}`),
  step: (s: string) => console.log(`  ${C.dim}>${C.reset} ${s}`),
  pass: (s: string) => console.log(`  ${C.green}PASS${C.reset}  ${s}`),
  fail: (s: string) => console.log(`  ${C.red}FAIL${C.reset}  ${s}`),
  blocked: (s: string) => console.log(`  ${C.green}BLOCKED${C.reset}  ${s}`),
  warn: (s: string) => console.log(`  ${C.yellow}!${C.reset} ${s}`),
  info: (s: string) => console.log(`    ${C.dim}${s}${C.reset}`),
  title: (s: string) => console.log(`\n${C.bold}${s}${C.reset}`),
};

export { sha256 };
