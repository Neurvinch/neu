import { canonicalize } from '@seal/shared';
import type {
  CallerAttestation,
  CallerChallenge,
  CallerChannel,
  CallerChallengeState,
  Role,
  SignatureEnvelope,
} from '@seal/shared';
import { verifyAnyEnvelope } from '@seal/shared/webauthn';
import { randomInt } from 'node:crypto';
import { appendAudit } from '../audit.js';
import { db, tx } from '../db.js';
import { broadcast } from '../events.js';
import { hashCanonical, randomId } from '../hash.js';
import { bad, conflict, denied, missing } from './errors.js';
import { getCredential, getEscrowRow, getUser, type UserRow } from './repo.js';
import { expireEscrow } from './service.js';

/**
 * Caller challenges.
 *
 * Signatures make the transaction unforgeable. They do nothing for the human
 * sitting in front of a screen while a perfect copy of their CFO's face and
 * voice tells them to hurry up -- and that human still has a real decision to
 * make. This is the part of the system that helps them.
 *
 * The principle is the same one the whole project runs on: do not ask anyone to
 * detect a fake. Give them a question a fake cannot answer. A short code
 * appears on the claimed executive's enrolled device and nowhere else, and the
 * person being pressured asks the caller to read it back. The attacker has the
 * face and the voice. They do not have the phone in that person's pocket.
 *
 * The reverse direction is just as valuable and needs no cleverness from
 * anybody: the real executive is asked "are you on a call with Aravind right
 * now?" and taps No. The impersonation is discovered from the other end, by the
 * person being impersonated, without anyone having to spot a rendering
 * artefact.
 */

const TTL_MS = 5 * 60_000;

/** No 0/O/1/I/5/S -- these get read aloud down a bad phone line. */
const ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXY2346789';

function makeCode(): string {
  let out = '';
  for (let i = 0; i < 6; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return `${out.slice(0, 3)}-${out.slice(3)}`;
}

interface Row {
  id: string;
  claimed_user_id: string;
  raised_by: string;
  channel: CallerChannel;
  demand: string;
  code: string;
  state: CallerChallengeState;
  txn_id: string | null;
  escrow_id: string | null;
  attestation_json: string | null;
  envelope_json: string | null;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
}

/**
 * The code is the whole point, so it is withheld from everyone except the two
 * parties who need it: the person being pressured, and the device of the person
 * being impersonated. Anyone else reading this record sees the challenge exists
 * without learning the answer.
 */
function toView(r: Row, viewerId: string): CallerChallenge {
  const claimed = getUser(r.claimed_user_id);
  const raiser = getUser(r.raised_by);
  const maySeeCode = viewerId === r.raised_by || viewerId === r.claimed_user_id;

  return {
    id: r.id,
    claimed_user_id: r.claimed_user_id,
    claimed_name: claimed?.name ?? r.claimed_user_id,
    claimed_role: (claimed?.role ?? 'CFO') as Role,
    raised_by: r.raised_by,
    raised_by_name: raiser?.name ?? r.raised_by,
    channel: r.channel,
    demand: r.demand,
    code: maySeeCode ? r.code : '···-···',
    state: r.state,
    txn_id: r.txn_id,
    escrow_id: r.escrow_id,
    created_at: r.created_at,
    expires_at: r.expires_at,
    seconds_remaining:
      r.state === 'PENDING'
        ? Math.max(0, Math.floor((Date.parse(r.expires_at) - Date.now()) / 1000))
        : 0,
    resolved_at: r.resolved_at,
    attested: !!r.envelope_json,
  };
}

const get = (id: string) =>
  db.prepare(`SELECT * FROM caller_challenges WHERE id = ?`).get(id) as Row | undefined;

export function getChallenge(id: string, viewerId: string): CallerChallenge {
  const row = get(id);
  if (!row) throw missing('NO_SUCH_CHALLENGE');
  return toView(row, viewerId);
}

/** Challenges this person raised, plus the ones aimed at them to answer. */
export function listChallengesFor(userId: string): CallerChallenge[] {
  const rows = db
    .prepare(
      `SELECT * FROM caller_challenges
       WHERE raised_by = ? OR claimed_user_id = ?
       ORDER BY created_at DESC LIMIT 40`,
    )
    .all(userId, userId) as unknown as Row[];
  return rows.map((r) => toView(r, userId));
}

/* --------------------------------------------------------------------------
 * Raising
 * ------------------------------------------------------------------------ */

export interface RaiseInput {
  raiser: UserRow;
  claimedUserId: string;
  channel: CallerChannel;
  demand: string;
  txnId?: string | null;
  escrowId?: string | null;
  /** Where the pressure arrived, when reported from the browser extension. */
  source?: { platform?: string; url?: string; handle?: string } | null;
}

export function raiseChallenge(input: RaiseInput): CallerChallenge {
  const claimed = getUser(input.claimedUserId);
  if (!claimed) throw missing('NO_SUCH_USER');
  if (claimed.id === input.raiser.id) {
    throw bad('SELF_CHALLENGE', 'You cannot challenge yourself');
  }

  const id = randomId('CHL');
  const now = new Date();
  const code = makeCode();

  tx(() => {
    db.prepare(
      `INSERT INTO caller_challenges
         (id, claimed_user_id, raised_by, channel, demand, code, state, txn_id, escrow_id,
          created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?)`,
    ).run(
      id,
      claimed.id,
      input.raiser.id,
      input.channel,
      input.demand.slice(0, 500),
      code,
      input.txnId ?? null,
      input.escrowId ?? null,
      now.toISOString(),
      new Date(now.getTime() + TTL_MS).toISOString(),
    );

    // Channel context lands in the same chain as everything else. The problem
    // statement's complaint is that telephony metadata, session risk and
    // payment records only get correlated after an incident; here the claim
    // that "someone called about this" is a first-class chained event, at the
    // moment it happens.
    appendAudit({
      txn_id: input.txnId ?? null,
      type: 'CALLER_CHALLENGE_RAISED',
      actor: input.raiser.id,
      payload: {
        challenge_id: id,
        claimed_to_be: claimed.id,
        claimed_role: claimed.role,
        channel: input.channel,
        demand: input.demand.slice(0, 500),
        escrow_id: input.escrowId ?? null,
        source: input.source ?? null,
        note: 'A challenge code was sent to the claimed executive device only.',
      },
    });
  });

  const view = getChallenge(id, input.raiser.id);
  // The claimed executive's device needs to light up immediately; everyone
  // else needs to know a challenge is in flight, without the code.
  broadcast('caller.raised', { ...view, code: '···-···' });
  return view;
}

/* --------------------------------------------------------------------------
 * Answering
 * ------------------------------------------------------------------------ */

/** What the executive signs to say "yes, that is me on the call". */
export function attestationFor(row: Row): CallerAttestation {
  return {
    v: 1,
    type: 'caller_attestation',
    challenge_id: row.id,
    claimed_user_id: row.claimed_user_id,
    raised_by: row.raised_by,
    channel: row.channel,
    code: row.code,
    at: row.created_at,
  };
}

export function attestationPayload(id: string, viewerId: string): CallerAttestation {
  const row = get(id);
  if (!row) throw missing('NO_SUCH_CHALLENGE');
  if (row.claimed_user_id !== viewerId) throw denied('NOT_YOUR_CHALLENGE');
  return attestationFor(row);
}

/**
 * Confirming is signed. It is a positive assertion that unblocks a human, so it
 * should cost a key -- otherwise a stolen session could vouch for an attacker's
 * voice.
 */
export async function confirmChallenge(
  id: string,
  actor: UserRow,
  signature: SignatureEnvelope,
): Promise<CallerChallenge> {
  const row = get(id);
  if (!row) throw missing('NO_SUCH_CHALLENGE');
  if (row.claimed_user_id !== actor.id) throw denied('NOT_YOUR_CHALLENGE');
  if (row.state !== 'PENDING') throw conflict('CHALLENGE_NOT_PENDING', `Challenge is ${row.state}`);
  if (Date.parse(row.expires_at) <= Date.now()) {
    expireChallenge(row);
    throw conflict('CHALLENGE_EXPIRED');
  }

  const credential = getCredential(signature?.credential_id ?? '');
  if (!credential) throw bad('UNKNOWN_CREDENTIAL');
  if (credential.state !== 'ACTIVE') throw denied('CREDENTIAL_NOT_ACTIVE');
  if (credential.user_id !== actor.id) throw denied('CREDENTIAL_NOT_OWNED_BY_SIGNER');

  const attestation = attestationFor(row);
  const verdict = await verifyAnyEnvelope(signature, credential, {
    purpose: 'ATTESTATION',
    payloadHash: hashCanonical(attestation),
  });
  if (!verdict.ok) throw bad(`SIGNATURE_${verdict.reason}`, 'Attestation did not verify');
  if ((verdict.counter ?? 0) <= credential.counter) throw bad('COUNTER_REPLAY');

  tx(() => {
    db.prepare(
      `UPDATE caller_challenges
       SET state = 'CONFIRMED', resolved_at = ?, attestation_json = ?, envelope_json = ?
       WHERE id = ?`,
    ).run(
      new Date().toISOString(),
      canonicalize(attestation),
      JSON.stringify(signature),
      id,
    );
    db.prepare(`UPDATE credentials SET counter = ? WHERE credential_id = ?`).run(
      verdict.counter ?? credential.counter + 1,
      credential.credential_id,
    );
    appendAudit({
      txn_id: row.txn_id,
      type: 'CALLER_CONFIRMED',
      actor: actor.id,
      payload: {
        challenge_id: id,
        channel: row.channel,
        device_kind: credential.device_kind,
        signed: true,
        note: 'The claimed executive attested, from their enrolled device, that this call is genuine.',
      },
    });
  });

  const view = getChallenge(id, actor.id);
  broadcast('caller.resolved', { ...view, code: '···-···' });
  return view;
}

/**
 * Denying is one tap and needs no signature.
 *
 * A deliberate asymmetry. The person best placed to know they are being
 * impersonated is the person being impersonated, and making them perform a
 * crypto ceremony while alarmed is bad design that costs minutes exactly when
 * minutes matter. Denial only ever *stops* things, so the worst a hijacked
 * session can achieve here is to void a payment that then has to be raised
 * again -- loud, recoverable, and far cheaper than missing a live impersonation.
 */
export function denyChallenge(id: string, actor: UserRow, note: string): CallerChallenge {
  const row = get(id);
  if (!row) throw missing('NO_SUCH_CHALLENGE');
  if (row.claimed_user_id !== actor.id) throw denied('NOT_YOUR_CHALLENGE');
  if (row.state !== 'PENDING') throw conflict('CHALLENGE_NOT_PENDING', `Challenge is ${row.state}`);

  const escrow = row.escrow_id ? getEscrowRow(row.escrow_id) : undefined;

  tx(() => {
    db.prepare(
      `UPDATE caller_challenges SET state = 'DENIED', resolved_at = ? WHERE id = ?`,
    ).run(new Date().toISOString(), id);
    appendAudit({
      txn_id: row.txn_id,
      type: 'CALLER_DENIED',
      actor: actor.id,
      payload: {
        challenge_id: id,
        channel: row.channel,
        raised_by: row.raised_by,
        demand: row.demand,
        escrow_id: row.escrow_id,
        alert: 'ACTIVE_IMPERSONATION',
        note: `${actor.name} states they are not on this ${row.channel.toLowerCase()}. Someone is impersonating them right now.`,
      },
    });
  });

  // Anything this call was pushing for stops immediately. The real payment can
  // be raised again in a minute; the fraudulent one gets no second chance.
  if (escrow && escrow.state === 'PENDING_QUORUM') {
    expireEscrow(escrow, 'IMPERSONATION_DENIED');
  }

  const view = getChallenge(id, actor.id);
  broadcast('caller.resolved', { ...view, code: '···-···' });
  broadcast('impersonation.alert', {
    challenge_id: id,
    claimed_user_id: row.claimed_user_id,
    raised_by: row.raised_by,
    channel: row.channel,
    demand: row.demand,
  });
  void note;
  return view;
}

function expireChallenge(row: Row): void {
  tx(() => {
    db.prepare(
      `UPDATE caller_challenges SET state = 'EXPIRED', resolved_at = ?
       WHERE id = ? AND state = 'PENDING'`,
    ).run(new Date().toISOString(), row.id);
    appendAudit({
      txn_id: row.txn_id,
      type: 'CALLER_CHALLENGE_EXPIRED',
      actor: null,
      payload: {
        challenge_id: row.id,
        channel: row.channel,
        // Silence is not a pass. A caller who cannot produce the code, and an
        // executive who never answers, both leave the claim unverified.
        note: 'The claimed executive never answered. Treat the caller as unverified.',
      },
    });
  });
  broadcast('caller.resolved', { ...toView(row, row.raised_by), code: '···-···', state: 'EXPIRED' });
}

export function sweepChallenges(): number {
  const due = db
    .prepare(`SELECT * FROM caller_challenges WHERE state = 'PENDING' AND expires_at <= ?`)
    .all(new Date().toISOString()) as unknown as Row[];
  for (const r of due) expireChallenge(r);
  return due.length;
}

/* --------------------------------------------------------------------------
 * Channel evidence
 * ------------------------------------------------------------------------ */

/**
 * Evidence captured from wherever the pressure actually arrived -- WhatsApp
 * Web, a mail client, a meeting tab -- via the browser extension.
 *
 * Media is never uploaded. The extension hashes the clip locally and sends the
 * digest plus context. That is enough to prove later that the artefact an
 * investigator holds is the one that arrived, without this system becoming a
 * store of other people's private messages.
 */
export function recordEvidence(params: {
  actor: UserRow;
  platform: string;
  url?: string | null;
  sender?: string | null;
  kind: 'TEXT' | 'AUDIO' | 'VIDEO' | 'IMAGE' | 'FILE';
  excerpt?: string | null;
  media_sha256?: string | null;
  media_bytes?: number | null;
  challenge_id?: string | null;
  txn_id?: string | null;
}) {
  const entry = appendAudit({
    txn_id: params.txn_id ?? null,
    type: 'IMPERSONATION_REPORTED',
    actor: params.actor.id,
    payload: {
      source: 'BROWSER_EXTENSION',
      platform: params.platform,
      url: params.url ?? null,
      sender: params.sender ?? null,
      kind: params.kind,
      excerpt: (params.excerpt ?? '').slice(0, 800),
      media_sha256: params.media_sha256 ?? null,
      media_bytes: params.media_bytes ?? null,
      challenge_id: params.challenge_id ?? null,
      note: 'Captured where the pressure arrived. Media was hashed locally and never uploaded.',
    },
  });

  broadcast('evidence.captured', { seq: entry.seq, platform: params.platform, kind: params.kind });
  return { seq: entry.seq, entry_hash: entry.entry_hash, at: entry.at };
}
