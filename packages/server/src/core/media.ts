import { canonicalize } from '@seal/shared';
import type {
  MediaAttestation,
  MediaKind,
  MediaLookup,
  MediaRecord,
  Role,
  SignatureEnvelope,
} from '@seal/shared';
import { verifyAnyEnvelope } from '@seal/shared/webauthn';
import { appendAudit } from '../audit.js';
import { db, tx } from '../db.js';
import { broadcast } from '../events.js';
import { hashCanonical } from '../hash.js';
import { bad, denied } from './errors.js';
import { getCredential, getUser, type UserRow } from './repo.js';

/**
 * Media provenance.
 *
 * The whole project's argument, pointed at a video instead of a payment: do not
 * try to work out whether a clip is synthetic. Ask whether the person it claims
 * to be from signed it.
 *
 * That inverts the burden in a way detection never can. A forger can produce a
 * flawless video of the CFO. They cannot produce her signature over it, so in an
 * organisation where genuine executive media is routinely signed, the fake is
 * the one with nothing attached to it -- and that is visible in the chat window
 * without anyone squinting at lip-sync.
 *
 * Two honest limits, both surfaced in the UI rather than buried:
 *
 *   - A signature is provenance, not veracity. It proves this exact file passed
 *     through the hands of someone holding that key and willing to put their
 *     name on it. It does not prove the contents are true.
 *   - Absence of a signature is not proof of forgery. It means unverified, and
 *     the interface says exactly that word.
 */

const KINDS = new Set<MediaKind>(['IMAGE', 'VIDEO', 'AUDIO', 'FILE']);

interface Row {
  sha256: string;
  kind: MediaKind;
  bytes: number;
  platform: string;
  caption: string;
  signer_id: string;
  credential_id: string;
  device_kind: string;
  attestation_json: string;
  envelope_json: string;
  signed_at: string;
  recorded_at: string;
  audit_seq: number;
}

function toRecord(r: Row): MediaRecord {
  const user = getUser(r.signer_id);
  return {
    sha256: r.sha256,
    kind: r.kind,
    bytes: r.bytes,
    platform: r.platform,
    caption: r.caption,
    signer_id: r.signer_id,
    signer_name: user?.name ?? r.signer_id,
    signer_role: (user?.role ?? 'EMPLOYEE') as Role,
    device_kind: r.device_kind as MediaRecord['device_kind'],
    credential_id: r.credential_id,
    signed_at: r.signed_at,
    recorded_at: r.recorded_at,
    audit_seq: r.audit_seq,
  };
}

/* --------------------------------------------------------------------------
 * Signing
 * ------------------------------------------------------------------------ */

/** The object the signer's device signs. Built here so both ends agree on it. */
export function mediaAttestation(params: {
  sha256: string;
  kind: MediaKind;
  bytes: number;
  platform: string;
  caption: string;
  signer_id: string;
  at: string;
}): MediaAttestation {
  return {
    v: 1,
    type: 'media_attestation',
    sha256: params.sha256,
    kind: params.kind,
    bytes: params.bytes,
    platform: params.platform,
    caption: params.caption,
    signer_id: params.signer_id,
    at: params.at,
  };
}

export async function signMedia(params: {
  actor: UserRow;
  attestation: MediaAttestation;
  signature: SignatureEnvelope;
}): Promise<MediaRecord> {
  const { actor, attestation, signature } = params;

  const fail = (code: string, message: string): never => {
    appendAudit({
      txn_id: null,
      type: 'MEDIA_VERIFY_FAILED',
      actor: actor.id,
      payload: { code, message, sha256: attestation?.sha256 ?? null },
    });
    throw bad(code, message);
  };

  if (attestation?.v !== 1 || attestation.type !== 'media_attestation') {
    fail('BAD_ATTESTATION', 'Not a media attestation');
  }
  if (!/^[0-9a-f]{64}$/.test(attestation.sha256)) fail('BAD_DIGEST', 'sha256 must be 64 hex chars');
  if (!KINDS.has(attestation.kind)) fail('BAD_MEDIA_KIND', 'Unsupported media kind');
  if (attestation.signer_id !== actor.id) {
    fail('SIGNER_MISMATCH', 'The attestation names a different signer');
  }
  if (!Number.isFinite(attestation.bytes) || attestation.bytes < 0) {
    fail('BAD_SIZE', 'bytes must be a non-negative number');
  }

  const credential = getCredential(signature?.credential_id ?? '');
  if (!credential) fail('UNKNOWN_CREDENTIAL', 'No such credential is enrolled');
  if (credential!.state !== 'ACTIVE') throw denied('CREDENTIAL_NOT_ACTIVE');
  if (credential!.user_id !== actor.id) throw denied('CREDENTIAL_NOT_OWNED_BY_SIGNER');

  // Vouching for a file is not moving money, so every custody tier may do it --
  // including a console key. The tier is recorded and shown to whoever verifies
  // it, which is what lets a reader weigh the claim for themselves.
  const verdict = await verifyAnyEnvelope(signature, credential!, {
    purpose: 'MEDIA',
    payloadHash: hashCanonical(attestation),
  });
  if (!verdict.ok) fail(`SIGNATURE_${verdict.reason}`, 'Media signature did not verify');

  const counter = verdict.counter ?? 0;
  if (counter <= credential!.counter) {
    fail('COUNTER_REPLAY', 'Signature counter did not advance; possible cloned credential');
  }

  const existing = db
    .prepare(`SELECT signer_id FROM media_attestations WHERE sha256 = ? AND signer_id = ?`)
    .get(attestation.sha256, actor.id);
  if (existing) fail('ALREADY_SIGNED', 'You have already signed this exact file');

  const recorded_at = new Date().toISOString();
  let seq = 0;

  tx(() => {
    const entry = appendAudit({
      txn_id: null,
      type: 'MEDIA_SIGNED',
      actor: actor.id,
      payload: {
        sha256: attestation.sha256,
        kind: attestation.kind,
        bytes: attestation.bytes,
        platform: attestation.platform,
        caption: attestation.caption,
        credential_id: credential!.credential_id,
        device_kind: credential!.device_kind,
        note: 'Provenance only. This says who vouched for the file, not that its contents are true.',
      },
    });
    seq = entry.seq;

    db.prepare(
      `INSERT INTO media_attestations
         (sha256, kind, bytes, platform, caption, signer_id, credential_id, device_kind,
          attestation_json, envelope_json, signed_at, recorded_at, audit_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      attestation.sha256,
      attestation.kind,
      attestation.bytes,
      attestation.platform.slice(0, 64),
      attestation.caption.slice(0, 400),
      actor.id,
      credential!.credential_id,
      credential!.device_kind,
      canonicalize(attestation),
      JSON.stringify(signature),
      attestation.at,
      recorded_at,
      seq,
    );
    db.prepare(`UPDATE credentials SET counter = ? WHERE credential_id = ?`).run(
      counter,
      credential!.credential_id,
    );
  });

  broadcast('media.signed', { sha256: attestation.sha256, signer_id: actor.id });

  return toRecord({
    sha256: attestation.sha256,
    kind: attestation.kind,
    bytes: attestation.bytes,
    platform: attestation.platform,
    caption: attestation.caption,
    signer_id: actor.id,
    credential_id: credential!.credential_id,
    device_kind: credential!.device_kind,
    attestation_json: '',
    envelope_json: '',
    signed_at: attestation.at,
    recorded_at,
    audit_seq: seq,
  });
}

/* --------------------------------------------------------------------------
 * Verifying
 * ------------------------------------------------------------------------ */

/**
 * The lookup a recipient makes. Note the wording of the negative case: this
 * never says "fake". It says nobody has vouched for it, which is the only thing
 * the absence of a signature actually tells you.
 */
export function lookupMedia(sha256: string): MediaLookup {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw bad('BAD_DIGEST', 'sha256 must be 64 hex chars');

  const rows = db
    .prepare(`SELECT * FROM media_attestations WHERE sha256 = ? ORDER BY recorded_at ASC`)
    .all(sha256) as unknown as Row[];

  const attestations = rows.map(toRecord);

  if (attestations.length === 0) {
    return {
      sha256,
      signed: false,
      attestations: [],
      headline: 'Nobody has signed this file.',
      detail:
        'That is not proof it is fake — it means nothing vouches for where it came from. Treat any instruction in it as unverified, and if it claims to be from an executive, challenge them before acting.',
    };
  }

  const first = attestations[0];
  return {
    sha256,
    signed: true,
    attestations,
    headline: `Signed by ${first.signer_name} (${first.signer_role}).`,
    detail:
      'The file you are looking at is byte-for-byte the file they signed. That is provenance, not veracity: it says who stands behind it, not that its contents are true.',
  };
}

export function recentMedia(limit = 50): MediaRecord[] {
  const rows = db
    .prepare(`SELECT * FROM media_attestations ORDER BY recorded_at DESC LIMIT ?`)
    .all(limit) as unknown as Row[];
  return rows.map(toRecord);
}
