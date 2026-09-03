import cors from 'cors';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { DEVICE_ASSURANCE, OUT_OF_BAND_ROLES, POLICY, TIER_CONFIG } from '@seal/shared';
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
} from './core/enrollment.js';
import {
  declineRequest,
  fulfilRequest,
  getRequest,
  listRequestsFor,
  requestApprovalSignature,
  requestEnrollmentApprovalSignature,
  requestIntentSignature,
} from './core/signing-requests.js';
import { credentialsFor, getIntentRow, listUsers, parseIntent } from './core/repo.js';
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
    if (deviceKind !== 'console' && deviceKind !== 'authenticator') throw bad('BAD_DEVICE_KIND');
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
    if (device_kind !== 'console' && device_kind !== 'authenticator') throw bad('BAD_DEVICE_KIND');
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
