import cors from 'cors';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import {
  buildIntent,
  canonicalize,
  DEVICE_ASSURANCE,
  OUT_OF_BAND_ROLES,
  POLICY,
  sha256Hex,
  TIER_CONFIG,
} from '@seal/shared';
import type { DeviceKind } from '@seal/shared';
import { RP_ID } from '@seal/shared/webauthn';
import { attachUser, login, logout, requireUser } from './auth.js';
import { appendAudit, chainForTxn, recentChain, verifyChain } from './audit.js';
import { CONFIG } from './config.js';
import { db } from './db.js';
import { addClient, broadcast } from './events.js';
import { SealError, bad, denied, missing } from './core/errors.js';
import {
  assertCustodyAllowed,
  beginHardwareEnrollment,
  beginSoftwareEnrollment,
  enrollmentApprovalPayload,
  enrollmentPayload,
  finishHardwareEnrollment,
  finishSoftwareEnrollment,
  inBootstrap,
  listEnrollments,
  revokeCredential,
} from './core/enrollment.js';
import { lookupMedia, mediaAttestation, recentMedia, signMedia } from './core/media.js';
import {
  attestationPayload,
  confirmChallenge,
  denyChallenge,
  getChallenge,
  listChallengesFor,
  raiseChallenge,
  recordEvidence,
} from './core/caller.js';
import {
  declineRequest,
  fulfilRequest,
  getRequest,
  listRequestsFor,
  requestApprovalSignature,
  requestEnrollmentApprovalSignature,
  requestIntentSignature,
} from './core/signing-requests.js';
import { credentialsFor, getIntentRow, getUser, listUsers, parseIntent } from './core/repo.js';
import { signWithSimulatedDevice } from './core/sim-signer.js';
import {
  acceptIntent,
  buildBundle,
  escrowView,
  listEscrows,
  rejectIntent,
  signedQueue,
  txnSummary,
} from './core/service.js';
import { metrics } from './metrics.js';

const CALLER_CHANNELS = ['PHONE', 'VIDEO', 'MEETING', 'EMAIL', 'CHAT', 'IN_PERSON'];

/** Software custody tiers. Hardware runs a different ceremony entirely. */
const SOFTWARE_KINDS = ['console', 'extension', 'authenticator'] as const;
const isSoftwareKind = (k: unknown): k is (typeof SOFTWARE_KINDS)[number] =>
  SOFTWARE_KINDS.includes(k as (typeof SOFTWARE_KINDS)[number]);
const EVIDENCE_KINDS = ['TEXT', 'AUDIO', 'VIDEO', 'IMAGE', 'FILE'];

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '256kb' }));
  app.use(attachUser);

  const ok = <T>(res: Response, body: T) => res.json(body);

  /* --------------------------------------------------------------------
   * Session (demo-grade -- see auth.ts for why that is acceptable here)
   * ------------------------------------------------------------------ */

  app.post('/api/session', (req, res) => {
    const { user_id, password } = req.body ?? {};
    if (!user_id || !password) throw bad('MISSING_FIELDS');
    const { token, user } = login(user_id, password);
    ok(res, {
      token,
      user: { id: user.id, name: user.name, role: user.role, limit_paise: user.approval_limit_paise },
    });
  });

  app.delete('/api/session', (req, res) => {
    const header = req.headers.authorization ?? '';
    if (header.startsWith('Bearer ')) logout(header.slice(7));
    res.status(204).end();
  });

  app.get('/api/me', (req, res) => {
    const user = requireUser(req);
    ok(res, {
      id: user.id,
      name: user.name,
      role: user.role,
      limit_paise: user.approval_limit_paise,
      credentials: credentialsFor(user.id).map((c) => ({
        credential_id: c.credential_id,
        binding: c.binding,
        device_kind: c.device_kind,
        state: c.state,
        counter: c.counter,
        label: c.label,
        aaguid: c.aaguid,
        created_at: c.created_at,
      })),
    });
  });

  app.get('/api/users', (_req, res) =>
    ok(
      res,
      listUsers().map((u) => ({
        id: u.id,
        name: u.name,
        role: u.role,
        limit_paise: u.approval_limit_paise,
        credentials: credentialsFor(u.id).filter((c) => c.state === 'ACTIVE').length,
      })),
    ),
  );

  app.get('/api/policy', (_req, res) =>
    ok(res, {
      org_id: CONFIG.orgId,
      policy: POLICY,
      tiers: TIER_CONFIG,
      bootstrap_ceremony_open: inBootstrap(),
      lane_b_implemented: false,
      out_of_band_roles: OUT_OF_BAND_ROLES,
      device_assurance: DEVICE_ASSURANCE,
      caller_channels: CALLER_CHANNELS,
      // Who a caller might plausibly claim to be. Staff pick from this list
      // rather than typing a name, so a challenge always reaches a real device.
      challengeable: listUsers()
        .filter((u) => OUT_OF_BAND_ROLES.includes(u.role))
        .map((u) => ({ id: u.id, name: u.name, role: u.role })),
      // Surfaced so the UI can say out loud that windows have been shortened
      // for a demo, rather than quietly showing a 45-second "90 minute" hold.
      demo_window_seconds: CONFIG.demoWindowSeconds,
      vendors: db
        .prepare(`SELECT name, account, ifsc FROM vendor_master WHERE active = 1 ORDER BY name`)
        .all(),
    }),
  );

  /* --------------------------------------------------------------------
   * Credential enrollment -- quorum-gated
   * ------------------------------------------------------------------ */

  /**
   * Two ceremonies behind one pair of endpoints. A software credential proves
   * possession by signing a server challenge with the new key; a hardware
   * credential runs the WebAuthn registration ceremony. Either way the result is
   * a PENDING credential that a quorum still has to admit.
   */
  app.post('/api/credentials/enroll/begin', async (req, res) => {
    const user = requireUser(req);
    const deviceKind = (req.body?.device_kind as DeviceKind) ?? 'authenticator';

    if (deviceKind === 'hardware') {
      ok(res, { device_kind: 'hardware', options: await beginHardwareEnrollment(user) });
      return;
    }
    if (!isSoftwareKind(deviceKind)) throw bad('BAD_DEVICE_KIND');
    assertCustodyAllowed(user.role, deviceKind);

    const started = beginSoftwareEnrollment(user.id);
    ok(res, {
      ...started,
      device_kind: deviceKind,
      // Echo the exact object the device must canonicalize, hash and sign.
      payload_template: enrollmentPayload(user.id, '<public_key_hex>', started.challenge),
    });
  });

  app.post('/api/credentials/enroll/finish', async (req, res) => {
    const user = requireUser(req);
    const { public_key, device_kind, label, proof, registration } = req.body ?? {};

    if (device_kind === 'hardware') {
      if (!registration) throw bad('MISSING_FIELDS', 'A WebAuthn registration response is required');
      ok(
        res,
        await finishHardwareEnrollment({
          userId: user.id,
          registration,
          label,
          actorId: user.id,
        }),
      );
      return;
    }
    if (!isSoftwareKind(device_kind)) throw bad('BAD_DEVICE_KIND');
    if (!public_key || !proof) throw bad('MISSING_FIELDS');
    ok(
      res,
      await finishSoftwareEnrollment({
        userId: user.id,
        publicKey: public_key,
        deviceKind: device_kind,
        label,
        proof,
        actorId: user.id,
      }),
    );
  });

  /**
   * Retire a key. Owner only, no quorum: this removes authority rather than
   * granting it, and someone who suspects their key is compromised should not
   * have to assemble a committee first.
   */
  app.post('/api/credentials/:id/revoke', (req, res) => {
    const user = requireUser(req);
    ok(res, revokeCredential(req.params.id, user, String(req.body?.reason ?? 'Retired by owner')));
  });

  app.get('/api/credentials/enrollments', (req, res) => {
    const user = requireUser(req);
    // Each row ships the exact object this approver would have to sign, so the
    // client never has to reconstruct it and never has to guess field order.
    ok(
      res,
      listEnrollments().map((r) => ({
        ...r,
        approval_payload: enrollmentApprovalPayload({
          request_id: r.id,
          credential_id: r.credential_id,
          subject_user_id: r.user_id,
          public_key: r.public_key,
          approver_id: user.id,
        }),
      })),
    );
  });

  /**
   * Admitting a key is a signature, so it goes down the same out-of-band
   * channel as everything else: the request appears on the approver's own
   * device, showing the exact public key being admitted.
   */
  app.post('/api/credentials/enrollments/:id/approve', (req, res) => {
    const user = requireUser(req);
    res.status(202).json(requestEnrollmentApprovalSignature(user, req.params.id));
  });

  /* --------------------------------------------------------------------
   * Stage 1 -- signed intents
   * ------------------------------------------------------------------ */

  /**
   * There is no endpoint that takes an intent plus a signature from the
   * console, because the console holds no key to sign with. It composes the
   * intent and asks the executive's own device to authorize it.
   */
  app.post('/api/intents', (req, res) => {
    const user = requireUser(req);
    const { intent } = req.body ?? {};
    if (!intent) throw bad('MISSING_FIELDS', 'intent is required');
    res.status(202).json(requestIntentSignature(user, intent));
  });

  /** The employee queue. Only signed work appears here; there is no create button. */
  app.get('/api/intents', (req, res) => {
    requireUser(req);
    ok(res, signedQueue());
  });

  app.get('/api/intents/:id', (req, res) => {
    requireUser(req);
    ok(res, txnSummary(req.params.id));
  });

  app.post('/api/intents/:id/accept', (req, res) => {
    const user = requireUser(req);
    ok(res, acceptIntent(req.params.id, user));
  });

  app.post('/api/intents/:id/reject', (req, res) => {
    const user = requireUser(req);
    rejectIntent(req.params.id, user, String(req.body?.reason ?? 'no reason given'));
    res.status(204).end();
  });

  /* --------------------------------------------------------------------
   * Stage 3 -- escrow and quorum
   * ------------------------------------------------------------------ */

  app.get('/api/escrows', (req, res) => {
    requireUser(req);
    ok(res, listEscrows());
  });

  app.get('/api/escrows/:id', (req, res) => {
    requireUser(req);
    ok(res, escrowView(req.params.id));
  });

  /** Same rule for approvals: the console asks, the enrolled device signs. */
  app.post('/api/escrows/:id/approvals', (req, res) => {
    const user = requireUser(req);
    const decision = req.body?.decision === 'REJECT' ? 'REJECT' : 'APPROVE';
    res.status(202).json(requestApprovalSignature(user, req.params.id, decision));
  });

  app.get('/api/escrows/:id/bundle', (req, res) => {
    requireUser(req);
    ok(res, buildBundle(req.params.id));
  });

  /**
   * Lane B is deliberately not implemented yet. The endpoint exists so the gap
   * is explicit rather than silently absent: an employee-originated request
   * must never be able to slip in looking like a signed one.
   */
  app.post('/api/escrows', (_req, _res) => {
    throw new SealError(
      501,
      'LANE_B_NOT_IMPLEMENTED',
      'Employee-originated requests are not accepted yet. Only signed executive intents (Lane A) can open an escrow.',
    );
  });

  /**
   * The rail reports every refusal back here.
   *
   * An attack aimed straight at the payment rail bypasses SEAL entirely, so
   * without this the chain would be silent about exactly the attempts that
   * matter most. The rail authenticates with a shared secret -- this is a
   * machine-to-machine channel, not a user one, and the report is evidence
   * only: it can never authorize anything.
   */
  app.post('/api/rail/refusals', (req, res) => {
    if (req.headers['x-rail-secret'] !== CONFIG.railSecret) throw denied('BAD_RAIL_SECRET');
    const { txn_id, intent_hash, failed_checks, amount, payee } = req.body ?? {};
    appendAudit({
      txn_id: typeof txn_id === 'string' ? txn_id : null,
      type: 'ATTACK_BLOCKED',
      actor: 'payment-rail',
      payload: {
        source: 'RAIL',
        reason: 'APPROVAL_BUNDLE_INVALID',
        failed_checks,
        intent_hash,
        amount,
        payee,
      },
    });
    broadcast('rail.refused', { txn_id, failed_checks });
    res.status(202).json({ recorded: true });
  });

  /* --------------------------------------------------------------------
   * The out-of-band signing channel
   *
   * These are the endpoints the SEAL Authenticator app talks to. Note what is
   * absent: there is no way for anything other than the subject's own enrolled
   * credential to resolve a request.
   * ------------------------------------------------------------------ */

  app.get('/api/signing-requests', (req, res) => {
    const user = requireUser(req);
    ok(res, listRequestsFor(user.id, req.query.pending !== '1'));
  });

  app.get('/api/signing-requests/:id', (req, res) => {
    const user = requireUser(req);
    const request = getRequest(req.params.id);
    // A signing request is addressed to one person. Nobody else may read the
    // fields it is asking them to authorize.
    if (request.subject_user_id !== user.id && request.requested_by !== user.id) {
      throw denied('NOT_YOUR_SIGNING_REQUEST');
    }
    ok(res, request);
  });

  app.post('/api/signing-requests/:id/fulfil', async (req, res) => {
    const user = requireUser(req);
    const { signature } = req.body ?? {};
    if (!signature) throw bad('MISSING_FIELDS', 'A signature is required');
    ok(res, await fulfilRequest({ id: req.params.id, actor: user, signature }));
  });

  app.post('/api/signing-requests/:id/decline', (req, res) => {
    const user = requireUser(req);
    ok(res, declineRequest(req.params.id, user, String(req.body?.reason ?? 'Declined on device')));
  });

  /**
   * WebAuthn parameters for the Authenticator app. No challenge is issued here:
   * the challenge is the hash of the core facts of the signature, computed on
   * the device and re-derived by the verifier, so there is nothing for the
   * server to hand out and nothing for a caller to substitute.
   */
  app.get('/api/webauthn/params', (req, res) => {
    const user = requireUser(req);
    ok(res, {
      rp_id: RP_ID,
      allow_credentials: credentialsFor(user.id)
        .filter((c) => c.webauthn_id && c.state === 'ACTIVE')
        .map((c) => ({ id: c.webauthn_id, credential_id: c.credential_id })),
    });
  });

  /* --------------------------------------------------------------------
   * Media provenance
   *
   * The extension hashes a file locally and asks these two questions: who
   * signed this, and will you record that I sign it. The bytes themselves never
   * come near this server.
   * ------------------------------------------------------------------ */

  /** What a signer's device must sign to vouch for one exact file. */
  app.post('/api/media/attestation', (req, res) => {
    const user = requireUser(req);
    const { sha256, kind, bytes, platform, caption } = req.body ?? {};
    if (!sha256 || !kind) throw bad('MISSING_FIELDS');
    ok(
      res,
      mediaAttestation({
        sha256: String(sha256).toLowerCase(),
        kind,
        bytes: Number(bytes ?? 0),
        platform: String(platform ?? 'unknown'),
        caption: String(caption ?? ''),
        signer_id: user.id,
        at: new Date().toISOString(),
      }),
    );
  });

  app.post('/api/media/sign', async (req, res) => {
    const user = requireUser(req);
    const { attestation, signature } = req.body ?? {};
    if (!attestation || !signature) throw bad('MISSING_FIELDS');
    res.status(201).json(await signMedia({ actor: user, attestation, signature }));
  });

  /**
   * Deliberately open to any signed-in user: verification has to be frictionless
   * or nobody does it, and the answer reveals nothing an attacker does not
   * already know -- they hold the file.
   */
  app.get('/api/media/:sha256', (req, res) => {
    requireUser(req);
    ok(res, lookupMedia(String(req.params.sha256).toLowerCase()));
  });

  app.get('/api/media', (req, res) => {
    requireUser(req);
    ok(res, recentMedia(Number(req.query.limit ?? 50)));
  });

  /* --------------------------------------------------------------------
   * Caller challenges -- the human half of the defence
   *
   * Cryptography settles whether a *transaction* is genuine. These endpoints
   * settle whether the *person on the call* is genuine, and they do it without
   * asking anybody to spot a rendering artefact.
   * ------------------------------------------------------------------ */

  app.get('/api/caller-challenges', (req, res) => {
    const user = requireUser(req);
    ok(res, listChallengesFor(user.id));
  });

  app.post('/api/caller-challenges', (req, res) => {
    const user = requireUser(req);
    const { claimed_user_id, channel, demand, txn_id, escrow_id, source } = req.body ?? {};
    if (!claimed_user_id || !channel) throw bad('MISSING_FIELDS');
    if (!CALLER_CHANNELS.includes(channel)) throw bad('BAD_CHANNEL');
    res.status(201).json(
      raiseChallenge({
        raiser: user,
        claimedUserId: claimed_user_id,
        channel,
        demand: String(demand ?? 'Not stated'),
        txnId: txn_id ?? null,
        escrowId: escrow_id ?? null,
        source: source ?? null,
      }),
    );
  });

  app.get('/api/caller-challenges/:id', (req, res) => {
    const user = requireUser(req);
    ok(res, getChallenge(req.params.id, user.id));
  });

  /** The object the claimed executive's device signs to vouch for the call. */
  app.get('/api/caller-challenges/:id/attestation', (req, res) => {
    const user = requireUser(req);
    ok(res, attestationPayload(req.params.id, user.id));
  });

  app.post('/api/caller-challenges/:id/confirm', async (req, res) => {
    const user = requireUser(req);
    const { signature } = req.body ?? {};
    if (!signature) throw bad('MISSING_FIELDS', 'Confirming a call requires a signature');
    ok(res, await confirmChallenge(req.params.id, user, signature));
  });

  app.post('/api/caller-challenges/:id/deny', (req, res) => {
    const user = requireUser(req);
    ok(res, denyChallenge(req.params.id, user, String(req.body?.note ?? '')));
  });

  /**
   * Evidence captured where the pressure actually arrived -- a message in
   * WhatsApp Web, a mail, a meeting tab -- by the browser extension.
   *
   * Media never leaves the reporter's machine: the extension hashes it locally
   * and sends the digest. Enough to prove later that the clip an investigator
   * holds is the clip that arrived, without this system becoming a warehouse of
   * other people's private messages.
   */
  app.post('/api/evidence', (req, res) => {
    const user = requireUser(req);
    const { platform, url, sender, kind, excerpt, media_sha256, media_bytes, challenge_id, txn_id } =
      req.body ?? {};
    if (!platform || !kind) throw bad('MISSING_FIELDS');
    if (!EVIDENCE_KINDS.includes(kind)) throw bad('BAD_EVIDENCE_KIND');
    if (media_sha256 && !/^[0-9a-f]{64}$/.test(media_sha256)) throw bad('BAD_MEDIA_DIGEST');
    res.status(201).json(
      recordEvidence({
        actor: user,
        platform: String(platform).slice(0, 64),
        url: url ? String(url).slice(0, 500) : null,
        sender: sender ? String(sender).slice(0, 200) : null,
        kind,
        excerpt: excerpt ? String(excerpt) : null,
        media_sha256: media_sha256 ?? null,
        media_bytes: typeof media_bytes === 'number' ? media_bytes : null,
        challenge_id: challenge_id ?? null,
        txn_id: txn_id ?? null,
      }),
    );
  });

  /**
   * The lookup the browser extension exists to make.
   *
   * Someone in a chat window claims a payment was authorized. This answers, in
   * one call and from inside that chat window, what the ledger actually says --
   * which is very often "no such thing exists".
   */
  app.get('/api/claims/lookup', (req, res) => {
    requireUser(req);
    const txnId = String(req.query.txn_id ?? '').trim().toUpperCase();

    if (!txnId) {
      throw bad('MISSING_FIELDS', 'Provide a transaction id such as TX-4A2B1C');
    }

    let summary: ReturnType<typeof txnSummary> | null = null;
    try {
      summary = txnSummary(txnId);
    } catch {
      summary = null;
    }

    if (!summary) {
      ok(res, {
        txn_id: txnId,
        exists: false,
        authorized: false,
        verdict: 'NO_SUCH_AUTHORIZATION',
        headline: 'No signed authorization exists for that reference.',
        detail:
          'Nothing in the ledger matches. Whoever is telling you this was approved is either mistaken or lying, whatever they sound like.',
      });
      return;
    }

    const escrow = summary.escrow;
    const executed = escrow?.state === 'EXECUTED';
    ok(res, {
      txn_id: txnId,
      exists: true,
      authorized: true,
      verdict: executed ? 'EXECUTED' : (escrow?.state ?? summary.state),
      headline: executed
        ? 'This payment was authorized and has already settled.'
        : `This payment exists and is ${(escrow?.state ?? summary.state).toLowerCase().replace('_', ' ')}.`,
      signed_by: summary.intent.originator,
      custody: escrow?.signer.device_kind ?? null,
      payee: summary.intent.payee,
      amount: summary.intent.amount,
      intent_hash: summary.intent_hash,
      approvals:
        escrow?.approvals.map((a) => ({ approver_id: a.approver_id, decision: a.decision })) ?? [],
      detail:
        'Compare the payee and the amount below against what you were told. If they differ, what you were told is not this payment.',
    });
  });

  /* --------------------------------------------------------------------
   * Audit
   * ------------------------------------------------------------------ */

  app.get('/api/audit', (req, res) => {
    requireUser(req);
    ok(res, recentChain(Number(req.query.limit ?? 200)));
  });

  app.get('/api/audit/:txn_id', (req, res) => {
    requireUser(req);
    if (!getIntentRow(req.params.txn_id)) throw missing('NO_SUCH_TXN');
    ok(res, {
      txn_id: req.params.txn_id,
      intent: parseIntent(getIntentRow(req.params.txn_id)!),
      entries: chainForTxn(req.params.txn_id),
    });
  });

  app.get('/api/audit/:txn_id/verify', (req, res) => {
    requireUser(req);
    const result = verifyChain();
    const entries = chainForTxn(req.params.txn_id);
    ok(res, {
      ...result,
      txn_id: req.params.txn_id,
      txn_entries: entries.length,
      // A break anywhere before this transaction's last entry taints it too.
      txn_affected:
        !result.ok &&
        entries.length > 0 &&
        result.break_at_seq !== null &&
        result.break_at_seq <= entries[entries.length - 1].seq,
    });
  });

  app.get('/api/metrics', (req, res) => {
    requireUser(req);
    ok(res, metrics());
  });

  /* --------------------------------------------------------------------
   * Dev / Simulation Helper (Lab interaction & testing)
   * ------------------------------------------------------------------ */

  app.post('/api/dev/exec-action', async (req, res) => {
    requireUser(req);
    const { action } = req.body ?? {};

    if (action === 'sign_media') {
      const { sha256, kind = 'IMAGE', bytes = 0, caption = '', user_id = 'u_rahul' } = req.body;
      const user = getUser(user_id);
      if (!user) throw bad('NO_SUCH_USER');
      const att = mediaAttestation({
        sha256: String(sha256).toLowerCase(),
        kind,
        bytes: Number(bytes),
        platform: 'WhatsApp Web',
        caption: String(caption),
        signer_id: user.id,
        at: new Date().toISOString(),
      });
      const hash = await sha256Hex(canonicalize(att));
      const signature = await signWithSimulatedDevice(user.id, 'MEDIA', hash);
      if (!signature) throw bad('NO_SIMULATED_KEY', `No simulated device key enrolled for ${user.id}`);
      const rec = await signMedia({ actor: user, attestation: att, signature });
      return ok(res, rec);
    }

    if (action === 'confirm_challenge') {
      const { challenge_id, user_id = 'u_rahul' } = req.body;
      const user = getUser(user_id);
      if (!user) throw bad('NO_SUCH_USER');
      const att = attestationPayload(challenge_id, user.id);
      const hash = await sha256Hex(canonicalize(att));
      const signature = await signWithSimulatedDevice(user.id, 'ATTESTATION', hash);
      if (!signature) throw bad('NO_SIMULATED_KEY', `No simulated device key enrolled for ${user.id}`);
      const confirmed = await confirmChallenge(challenge_id, user, signature);
      return ok(res, confirmed);
    }

    if (action === 'create_escrow_media') {
      const {
        media_sha256,
        user_id = 'u_rahul',
        payee = { name: 'Alton Logistics Pvt Ltd', account: '50100234564419', ifsc: 'HDFC0001234' },
        amount = '4200000.00',
        purpose = `WhatsApp invoice Media #${String(media_sha256).slice(0, 10)} settlement`,
      } = req.body;
      const user = getUser(user_id);
      if (!user) throw bad('NO_SUCH_USER');
      const intent = buildIntent({
        org_id: CONFIG.orgId,
        type: 'wire_transfer',
        payee,
        amount: { value: amount, currency: 'INR' },
        purpose,
        deadline: new Date(Date.now() + 48 * 3600_000).toISOString(),
        originator: { user_id: user.id, role: user.role as 'CEO' },
        media_sha256: String(media_sha256).toLowerCase(),
      });
      const reqView = requestIntentSignature(user, intent);
      const signature = await signWithSimulatedDevice(user.id, 'INTENT', reqView.payload_hash);
      if (!signature) throw bad('NO_SIMULATED_KEY', `No simulated device key enrolled for ${user.id}`);
      await fulfilRequest({ id: reqView.id, actor: user, signature });
      const employee = getUser('u_aravind')!;
      const escrow = acceptIntent(intent.txn_id, employee);
      return ok(res, escrow);
    }

    if (action === 'approve_escrow') {
      const { escrow_id, user_id = 'u_priya' } = req.body;
      const user = getUser(user_id);
      if (!user) throw bad('NO_SUCH_USER');
      const reqView = requestApprovalSignature(user, escrow_id, 'APPROVE');
      const signature = await signWithSimulatedDevice(user.id, reqView.purpose, reqView.payload_hash);
      if (!signature) throw bad('NO_SIMULATED_KEY', `No simulated device key enrolled for ${user.id}`);
      await fulfilRequest({ id: reqView.id, actor: user, signature });
      const updated = escrowView(escrow_id);
      return ok(res, updated);
    }

    throw bad('UNKNOWN_ACTION');
  });

  /* --------------------------------------------------------------------
   * Realtime
   * ------------------------------------------------------------------ */

  app.get('/api/events', (req, res) => addClient(res));

  app.get('/api/health', (_req, res) => ok(res, { ok: true, service: 'seal', lane: 'A' }));

  /* --------------------------------------------------------------------
   * Errors
   * ------------------------------------------------------------------ */

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof SealError) {
      res.status(err.status).json({ error: err.code, message: err.message, detail: err.detail });
      return;
    }
    console.error('[seal] unhandled', err);
    res.status(500).json({ error: 'INTERNAL', message: (err as Error)?.message });
  });

  return app;
}
