import fs from 'node:fs';
import path from 'node:path';
import * as ed from '@noble/ed25519';
import { assertionBytes, fromHex, toB64u } from '@seal/shared';
import type { Ed25519Assertion, SignatureEnvelope, SignaturePurpose } from '@seal/shared';
import { DATA_DIR } from '../config.js';
import { db } from '../db.js';

interface StoredDevice {
  private_key: string;
  public_key: string;
  credential_id: string;
}

export async function signWithSimulatedDevice(
  userId: string,
  purpose: SignaturePurpose,
  payloadHash: string,
): Promise<SignatureEnvelope | null> {
  const deviceFile = path.join(DATA_DIR, 'sim-devices.json');
  if (!fs.existsSync(deviceFile)) return null;
  const devices = JSON.parse(fs.readFileSync(deviceFile, 'utf8')) as Record<string, StoredDevice>;

  const dev = devices[`${userId}:authenticator`] ?? devices[`${userId}:extension`];
  if (!dev) return null;

  const cred = db
    .prepare(`SELECT * FROM credentials WHERE credential_id = ? AND state = 'ACTIVE'`)
    .get(dev.credential_id) as { counter: number; device_kind: string } | undefined;
  if (!cred) return null;

  const counter = (cred.counter ?? 0) + 1;
  const assertion: Ed25519Assertion = {
    v: 1,
    domain: 'SEAL-v1',
    alg: 'Ed25519',
    binding: 'software',
    device_kind: cred.device_kind as 'authenticator' | 'extension',
    purpose,
    credential_id: dev.credential_id,
    payload_hash: payloadHash,
    counter,
    user_presence: true,
    signed_at: new Date().toISOString(),
  };

  const sig = await ed.signAsync(assertionBytes(assertion), fromHex(dev.private_key));
  return { ...assertion, signature: toB64u(sig) };
}
