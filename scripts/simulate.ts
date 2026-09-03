/**
 * SEAL Lane A -- end-to-end walkthrough plus the attack suite.
 *
 *   npm run sim
 *
 * Act 1 enrols devices through the quorum-gated key ceremony.
 * Act 2 runs the legitimate path all the way to a settled payment.
 * Act 3 runs the attacks, including the one the problem statement is about:
 *       a perfect voice clone with nothing to sign with.
 * Act 4 closes an escrow window, if the server was started with a short one.
 * Act 5 verifies the audit chain.
 *
 * Every attack asserts the *specific* rejection code, so this doubles as the
 * regression suite. A block for the wrong reason is reported as a failure.
 */
import {
  createSoftwareSigner,
  credentialIdFor,
  generateKeyPair,
  memoryCounterStore,
} from '@seal/shared';
import type { ApprovalBundle, SigningRequest } from '@seal/shared';
import {
  RAIL,
  api,
  approve,
  approveEnrollment,
  approveEnrollments,
  captureEvidence,
  composeIntent,
  confirmChallenge,
  decline,
  denyChallenge,
  enroll,
  fmt,
  fulfil,
  lookupClaim,
  raiseChallenge,
  requestIntent,
  submitIntent,
  type ApiError,
  type Device,
} from './lib.js';

let passes = 0;
let failures = 0;

/** Assert that an action is refused, and refused for the expected reason. */
async function mustFail(label: string, expected: string | string[], fn: () => Promise<unknown>) {
  const want = Array.isArray(expected) ? expected : [expected];
  try {
    await fn();
    fmt.fail(`${label} -- it went through, and it should not have`);
    failures++;
  } catch (e) {
    const err = e as ApiError;
    if (!err.error) {
      fmt.fail(`${label} -- unexpected crash: ${(e as Error).message}`);
      failures++;
      return;
    }
    if (want.some((w) => err.error.startsWith(w))) {
      fmt.blocked(label);
      fmt.info(`${err.status} ${err.error}${err.message ? ` -- ${err.message}` : ''}`);
      passes++;
    } else {
      fmt.fail(`${label} -- blocked, but for the wrong reason: ${err.error}`);
      failures++;
    }
  }
}

async function mustPass(label: string, fn: () => Promise<unknown>) {
  try {
    const out = await fn();
    fmt.pass(label);
    passes++;
    return out;
  } catch (e) {
    const err = e as ApiError;
    fmt.fail(`${label} -- ${err.error ?? (e as Error).message} ${err.message ?? ''}`);
    failures++;
    throw e;
  }
}

function assert(label: string, condition: boolean, detail = '') {
  if (condition) {
    fmt.pass(label);
    passes++;
  } else {
    fmt.fail(`${label}${detail ? ` -- ${detail}` : ''}`);
    failures++;
  }
}

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

async function main() {
  await api('/api/health').catch(() => {
    console.error('SEAL backend is not running. Start it with: npm run dev');
    process.exit(1);
  });

  /* =======================================================================
   * Act 1 -- the key ceremony
   * ===================================================================== */
  fmt.head('Act 1 -- enrolling devices (quorum-gated, off the console)');

  const how = (d: Device) =>
    d.reused ? 'reused, already admitted' : d.bootstrap ? 'bootstrap ceremony' : 'pending quorum';

  const cfo = await enroll('u_priya', 'Priya phone');
  const ceo = await enroll('u_rahul', 'Rahul phone');
  const cto = await enroll('u_anita', 'Anita phone');
  const treasury = await enroll('u_vikram', 'Vikram phone');
  fmt.step(`CFO      ${cfo.credentialId}  (${how(cfo)})`);
  fmt.step(`CEO      ${ceo.credentialId}  (${how(ceo)})`);
  fmt.step(`CTO      ${cto.credentialId}  (${how(cto)})`);
  fmt.step(`Treasury ${treasury.credentialId}  (${how(treasury)})`);

  // The custody rule bites when a key is admitted, not merely when it is used.
  // An executive cannot enrol a key in the console browser at all, so the
  // ceremony is refused before a keypair is even generated.
  await mustFail(
    'CFO tries to enrol a signing key in the console browser',
    'CONSOLE_KEY_NOT_PERMITTED',
    () =>
      api('/api/credentials/enroll/begin', {
        body: { device_kind: 'console' },
        token: cfo.token,
      }),
  );

  const pendingFor = async (device: Device) => {
    const list = await api<Array<{ id: string; user_id: string; state: string }>>(
      '/api/credentials/enrollments',
      { token: device.token },
    );
    return list.find((r) => r.user_id === device.id && r.state === 'PENDING') ?? null;
  };

  const ctoPending = await pendingFor(cto);
  const treasuryPending = await pendingFor(treasury);

  if (ctoPending && treasuryPending) {
    await mustFail(
      'CTO tries to approve her own key enrolment',
      'SELF_ENROLLMENT_APPROVAL',
      () => approveEnrollment(cto, ctoPending.id),
    );

    // A hijacked console session can raise the request, but the signature has
    // to come off the real approver's device -- and the attacker has no key.
    await mustFail(
      'Hijacked CEO session raises an enrolment approval and signs it with a stolen-session key',
      'UNKNOWN_CREDENTIAL',
      async () => {
        const request = await api<SigningRequest>(
          `/api/credentials/enrollments/${treasuryPending.id}/approve`,
          { body: {}, token: ceo.token },
        );
        const attacker = await forgedDevice('u_rahul', 'CEO');
        attacker.token = ceo.token;
        return fulfil(attacker, request);
      },
    );
  } else {
    fmt.warn(
      'Enrolment-ceremony attacks skipped: these devices are already admitted. ' +
        'Run "npm run reset && npm run seed" to exercise the ceremony from scratch.',
    );
  }

  await approveEnrollments([cfo, ceo, cto, treasury]);
  fmt.step('CFO and CEO signed the remaining admissions; key directory published to the rail');

  const employee = await enroll('u_aravind', 'Aravind workstation', 'console');
  await approveEnrollments([cfo, ceo]);
  fmt.step(`Employee ${employee.credentialId}  (console key: allowed, but authorizes nothing)`);

  /* =======================================================================
   * Act 2 -- the legitimate path
   * ===================================================================== */
  fmt.head('Act 2 -- the happy path: console composes, device authorizes, quorum executes');

  const legit = composeIntent(cfo, {
    org_id: 'acme-corp',
    type: 'wire_transfer',
    payee: { name: 'Alton Logistics Pvt Ltd', account: '50100234564419', ifsc: 'HDFC0001234' },
    amount: { value: '4200000.00', currency: 'INR' },
    purpose: 'Vendor settlement Q3',
    deadline: inHours(48),
  });

  const raised = (await mustPass('Console raises a signature request (it cannot sign)', () =>
    requestIntent(cfo, legit.intent),
  )) as SigningRequest;
  fmt.info(`${raised.id} pushed to ${raised.subject_user_id}'s device`);
  assert(
    'The request fixes the hash the device will sign',
    raised.payload_hash === legit.hash,
    `${raised.payload_hash} vs ${legit.hash}`,
  );

  // Nobody else can answer a request addressed to the CFO -- not even another
  // executive with a perfectly good key of their own.
  await mustFail('CEO tries to answer the CFO signature request', 'NOT_YOUR_SIGNING_REQUEST', () =>
    fulfil({ ...ceo }, raised),
  );

  await mustPass('CFO authorizes it on her own device', () => fulfil(cfo, raised));

  const escrow = (await mustPass('Employee accepts; escrow opens', () =>
    api<{
      escrow_id: string;
      risk: { tier: string; score: number; rules_fired: string[] };
      required_approvals: number;
      seconds_remaining: number;
      signer: { device_kind: string };
    }>(`/api/intents/${legit.intent.txn_id}/accept`, { method: 'POST', token: employee.token }),
  )) as {
    escrow_id: string;
    risk: { tier: string; score: number; rules_fired: string[] };
    required_approvals: number;
    seconds_remaining: number;
    signer: { device_kind: string };
  };

  fmt.info(
    `${escrow.escrow_id}  tier=${escrow.risk.tier} score=${escrow.risk.score} ` +
      `approvals=${escrow.required_approvals} window=${Math.round(escrow.seconds_remaining / 60)}min`,
  );
  fmt.info(`rules fired: ${escrow.risk.rules_fired.join(', ')}`);
  assert(
    'The escrow records that the intent was signed off the console',
    escrow.signer.device_kind === 'authenticator',
    escrow.signer.device_kind,
  );

  await mustFail('Employee tries to approve the escrow they opened', 'ROLE_CANNOT_APPROVE', () =>
    approve(employee, escrow.escrow_id),
  );
  await mustFail('CFO tries to approve the intent she signed', 'SELF_APPROVAL', () =>
    approve(cfo, escrow.escrow_id),
  );

  await mustPass('CEO approves on his device', () => approve(ceo, escrow.escrow_id));
  const final = (await mustPass('CTO approves -- quorum met, payment submitted', () =>
    approve(cto, escrow.escrow_id),
  )) as SigningRequest;

  const settled = final.result as unknown as {
    state: string;
    receipt: { ok: boolean; reference?: string } | null;
  };
  if (settled?.state === 'EXECUTED' && settled.receipt?.ok) {
    fmt.pass(`Rail settled the payment: ${settled.receipt.reference}`);
    passes++;
  } else {
    fmt.fail(`Expected EXECUTED, got ${settled?.state} ${JSON.stringify(settled?.receipt)}`);
    failures++;
  }

  /* =======================================================================
   * Act 3 -- the attacks
   * ===================================================================== */
  fmt.head('Act 3 -- attacks');

  // 1. The headline attack. A flawless voice clone tells the employee to wire
  //    money to a mule account. There is no signed intent, and no field in
  //    which the employee could type one.
  const queue = await api<unknown[]>('/api/intents', { token: employee.token });
  if (queue.length === 0) {
    fmt.blocked('Deepfake call demands an urgent transfer -- employee queue is empty');
    fmt.info('There is no signed request to accept and no free-form payment form to fill in.');
    passes++;
  } else {
    fmt.fail('Queue should have been empty after the legitimate payment settled');
    failures++;
  }

  await mustFail(
    'Attacker tries the employee-originated path (Lane B) instead',
    'LANE_B_NOT_IMPLEMENTED',
    () =>
      api('/api/escrows', {
        token: employee.token,
        body: { payee: { name: 'Mule', account: '999', ifsc: 'XXXX' }, amount: '4200000.00' },
      }),
  );

  // 2. The console is fully compromised. The attacker can compose anything and
  //    raise the request -- and then it lands on the real CFO's phone.
  const mule = composeIntent(cfo, {
    org_id: 'acme-corp',
    type: 'wire_transfer',
    payee: { name: 'Zenith Trade Co', account: '77770001111', ifsc: 'UTIB0000123' },
    amount: { value: '4200000.00', currency: 'INR' },
    purpose: 'Urgent supplier settlement',
    deadline: inHours(2),
  });
  const muleRequest = await requestIntent(cfo, mule.intent);
  fmt.step('Compromised console composes a payment to a mule account and raises the request');
  fmt.info(`it shows on the CFO's device as: ${muleRequest.rows.map((r) => r.join('=')).join(', ')}`);

  await mustPass('Real CFO looks at the payee and declines on her device', () =>
    decline(cfo, muleRequest, 'I never asked for this'),
  );
  await mustFail(
    'Attacker tries to authorize the declined request anyway',
    'REQUEST_NOT_PENDING',
    () => fulfil(cfo, muleRequest),
  );

  // 3. The attacker generates their own key and signs the request with it. The
  //    maths is perfect; the key is simply not enrolled.
  await mustFail(
    'Attacker answers a signature request with their own (unenrolled) key',
    'UNKNOWN_CREDENTIAL',
    async () => {
      const request = await requestIntent(cfo, mule2().intent);
      const attacker = await forgedDevice('u_priya', 'CFO');
      attacker.token = cfo.token;
      return fulfil(attacker, request);
    },
  );

  // 4. A signature over a *different* payload than the request fixed. This is
  //    the console-shows-one-thing-submits-another attack, and the request's
  //    stored hash is what defeats it.
  await mustFail(
    'Console asks for one payment and submits a signature over another',
    'SIGNATURE_PAYLOAD_HASH_MISMATCH',
    async () => {
      const request = await requestIntent(cfo, mule2().intent);
      const other = composeIntent(cfo, {
        org_id: 'acme-corp',
        type: 'wire_transfer',
        payee: { name: 'Alton Logistics Pvt Ltd', account: '50100234564419', ifsc: 'HDFC0001234' },
        amount: { value: '100.00', currency: 'INR' },
        purpose: 'Decoy',
        deadline: inHours(24),
      });
      const signature = await cfo.signer.sign('INTENT', other.hash);
      return api(`/api/signing-requests/${request.id}/fulfil`, {
        body: { signature },
        token: cfo.token,
      });
    },
  );

  // 5. A signature made for one purpose, replayed for another.
  await mustFail(
    'An APPROVAL signature is replayed as an INTENT authorization',
    'SIGNATURE_PURPOSE_MISMATCH',
    async () => {
      const request = await requestIntent(cfo, mule2().intent);
      const signature = await cfo.signer.sign('APPROVAL', request.payload_hash);
      return api(`/api/signing-requests/${request.id}/fulfil`, {
        body: { signature },
        token: cfo.token,
      });
    },
  );

  // 6. An executive signing with a console-resident key. The employee has one;
  //    lending it to the CFO changes nothing.
  await mustFail(
    'CFO authorizes using a console-resident credential',
    ['CREDENTIAL_NOT_OWNED_BY_SIGNER', 'CONSOLE_KEY_NOT_PERMITTED'],
    async () => {
      const request = await requestIntent(cfo, mule2().intent);
      const signature = await employee.signer.sign('INTENT', request.payload_hash);
      return api(`/api/signing-requests/${request.id}/fulfil`, {
        body: { signature },
        token: cfo.token,
      });
    },
  );

  // 7. Replay a captured, genuine intent.
  await mustFail('Replay of the genuine settled intent', ['TXN_ID_REUSED', 'NONCE_REPLAY'], () =>
    submitIntent(cfo, legit.intent),
  );

  // 8. An employee cannot originate a payment, signed or not.
  await mustFail('Employee composes their own payment intent', 'ROLE_CANNOT_ORIGINATE', async () => {
    const f = composeIntent(employee, {
      org_id: 'acme-corp',
      type: 'wire_transfer',
      payee: { name: 'Mule Holdings', account: '888800001111', ifsc: 'UTIB0000999' },
      amount: { value: '450000.00', currency: 'INR' },
      purpose: 'Reimbursement',
      deadline: inHours(6),
    });
    return requestIntent(employee, f.intent);
  });

  // 9. An approver signing a hash other than the one bound to the escrow. The
  //    request pins the hash, so the mismatch is caught before any policy runs.
  const pending = composeIntent(cfo, {
    org_id: 'acme-corp',
    type: 'wire_transfer',
    payee: { name: 'Karthik Steelworks', account: '918200045127', ifsc: 'ICIC0004512' },
    amount: { value: '750000.00', currency: 'INR' },
    purpose: 'Steel order 4471',
    deadline: inHours(36),
  });
  await submitIntent(cfo, pending.intent);
  const esc2 = await api<{ escrow_id: string }>(`/api/intents/${pending.intent.txn_id}/accept`, {
    method: 'POST',
    token: employee.token,
  });

  await mustFail(
    'Approver signs a hash other than the one bound to the escrow',
    'SIGNATURE_PAYLOAD_HASH_MISMATCH',
    async () => {
      const request = await api<SigningRequest>(`/api/escrows/${esc2.escrow_id}/approvals`, {
        body: { decision: 'APPROVE' },
        token: ceo.token,
      });
      const signature = await ceo.signer.sign('APPROVAL', legit.hash);
      return api(`/api/signing-requests/${request.id}/fulfil`, {
        body: { signature },
        token: ceo.token,
      });
    },
  );

  // 10. Straight at the rail with a hand-built bundle. This is the enforcement
  //     point: SEAL could be bypassed entirely and the money still would not move.
  const settledBundle = await api<ApprovalBundle>(`/api/escrows/${escrow.escrow_id}/bundle`, {
    token: cfo.token,
  });

  if (
    await railRefuses('Forged bundle submitted directly to the payment rail', {
      ...settledBundle,
      escrow_id: 'ESC-forged',
      intent: {
        ...settledBundle.intent,
        txn_id: 'TX-FORGED',
        nonce: 'deadbeefdeadbeef',
        payee: { name: 'Mule Holdings', account: '888800001111', ifsc: 'UTIB0000999' },
      },
      issued_at: new Date().toISOString(),
    })
  ) {
    passes++;
  } else {
    failures++;
  }

  // 11. A genuine, fully valid bundle replayed at the rail after settlement.
  if (
    await railRefuses(
      'Genuine settled bundle replayed at the rail',
      { ...settledBundle, issued_at: new Date().toISOString() },
      'nonce_not_already_settled',
    )
  ) {
    passes++;
  } else {
    failures++;
  }

  // 12. There is no manual path.
  const manual = await fetch(`${RAIL}/pay`, { method: 'POST' });
  if (manual.status === 403) {
    fmt.blocked('Manual payment path on the rail');
    fmt.info('403 APPROVAL_BUNDLE_INVALID -- the rail has no path that skips the bundle');
    passes++;
  } else {
    fmt.fail(`Manual path returned ${manual.status}`);
    failures++;
  }

  // 13. The rail applies the custody rule on its own authority.
  const railChecks = (settledBundle && (await railChecksFor(settledBundle))) ?? [];
  assert(
    'The rail independently checks the custody tier of every signature',
    railChecks.some((c) => c.startsWith('signer_custody')) &&
      railChecks.some((c) => c.includes('custody_permitted')),
    railChecks.join(', '),
  );

  /* =======================================================================
   * Act 4 -- the deepfaked call
   *
   * The attack the whole project is named for, aimed at the two places it can
   * still land: an employee who has nothing to do, and an approver who has a
   * real escrow in front of them. Neither is asked to spot a fake.
   * ===================================================================== */
  fmt.head('Act 4 -- the deepfaked call');

  // The employee is on a video call with a flawless copy of the CFO.
  const challenge = await mustPass(
    'Employee challenges the caller instead of judging the video',
    () =>
      raiseChallenge(
        employee,
        cfo.id,
        'VIDEO',
        'Wire 42L to a new account before the bank closes',
      ),
  );
  const raisedChallenge = challenge as Awaited<ReturnType<typeof raiseChallenge>>;
  fmt.info(`code ${raisedChallenge.code} -- shown to the employee and on the CFO device only`);

  assert(
    'The code is a readable six characters, no ambiguous glyphs',
    /^[ABCDEFGHJKLMNPQRTUVWXY2346789]{3}-[ABCDEFGHJKLMNPQRTUVWXY2346789]{3}$/.test(
      raisedChallenge.code,
    ),
    raisedChallenge.code,
  );

  // Anyone else looking at this challenge sees that it exists, not the answer.
  const asOutsider = await api<{ code: string }>(
    `/api/caller-challenges/${raisedChallenge.id}`,
    { token: cto.token },
  );
  assert(
    'A third party cannot read the challenge code',
    asOutsider.code === '···-···',
    asOutsider.code,
  );

  const denied = await mustPass('The real CFO taps "that is not me"', () =>
    denyChallenge(cfo, raisedChallenge.id),
  );
  assert(
    'The challenge records an active impersonation',
    (denied as { state: string }).state === 'DENIED',
  );

  // The whole point: the next payment this CFO originates is now CRITICAL,
  // because we know someone was impersonating her minutes ago.
  const afterImpersonation = composeIntent(cfo, {
    org_id: 'acme-corp',
    type: 'wire_transfer',
    payee: { name: 'Alton Logistics Pvt Ltd', account: '50100234564419', ifsc: 'HDFC0001234' },
    amount: { value: '150000.00', currency: 'INR' },
    purpose: 'Routine settlement during an active impersonation',
    deadline: inHours(24),
  });
  const flaggedRequest = await requestIntent(cfo, afterImpersonation.intent);
  assert(
    'Her signing device is warned that she was just impersonated',
    flaggedRequest.warnings.some((w) => /impersonat/i.test(w)),
    flaggedRequest.warnings.join(' | '),
  );
  await fulfil(cfo, flaggedRequest);
  const flaggedEscrow = await api<{ risk: { tier: string; rules_fired: string[] } }>(
    `/api/intents/${afterImpersonation.intent.txn_id}/accept`,
    { method: 'POST', token: employee.token },
  );
  assert(
    'A known-good payee at a small amount is still CRITICAL during an impersonation',
    flaggedEscrow.risk.tier === 'CRITICAL' &&
      flaggedEscrow.risk.rules_fired.includes('ACTIVE_IMPERSONATION'),
    `${flaggedEscrow.risk.tier}: ${flaggedEscrow.risk.rules_fired.join(', ')}`,
  );

  // Now the sharp end: an approver with a genuine escrow in front of them,
  // being talked through it by the same fake.
  const pressured = composeIntent(cfo, {
    org_id: 'acme-corp',
    type: 'wire_transfer',
    payee: { name: 'Zenith Trade Co', account: '77770001111', ifsc: 'UTIB0000123' },
    amount: { value: '3100000.00', currency: 'INR' },
    purpose: 'Urgent supplier settlement',
    deadline: inHours(3),
  });
  await submitIntent(cfo, pressured.intent);
  const pressuredEscrow = await api<{ escrow_id: string }>(
    `/api/intents/${pressured.intent.txn_id}/accept`,
    { method: 'POST', token: employee.token },
  );

  const approverChallenge = await raiseChallenge(
    ceo,
    cfo.id,
    'VIDEO',
    `Approve ${pressured.intent.txn_id} right now`,
    { txn_id: pressured.intent.txn_id, escrow_id: pressuredEscrow.escrow_id },
  );
  fmt.step('CEO is being talked through an approval by "the CFO" on video; he challenges her');
  await denyChallenge(cfo, approverChallenge.id);

  const voided = await api<{ state: string }>(
    `/api/escrows/${pressuredEscrow.escrow_id}`,
    { token: ceo.token },
  );
  assert(
    'Denying the caller voids the escrow that call was pushing for',
    voided.state === 'EXPIRED',
    voided.state,
  );

  await mustFail(
    'The approver approves anyway, after the denial',
    'ESCROW_NOT_PENDING',
    () => approve(ceo, pressuredEscrow.escrow_id),
  );

  // A genuine call still works, and costs one signature.
  const genuine = await raiseChallenge(treasury, cfo.id, 'PHONE', 'Checking a vendor detail');
  const confirmed = await mustPass('A genuine call is confirmed, signed on the CFO device', () =>
    confirmChallenge(cfo, genuine.id),
  );
  assert(
    'The confirmation is attested by a key, not just a session',
    (confirmed as { attested: boolean }).attested === true,
  );

  /* =======================================================================
   * Act 4b -- what the browser extension asks
   * ===================================================================== */
  fmt.head('Act 4b -- the browser extension, from inside the chat window');

  const bogus = await lookupClaim(employee, 'TX-NOTREAL');
  assert(
    'A forwarded "already approved" claim with no ledger entry is exposed',
    !bogus.exists && !bogus.authorized && bogus.verdict === 'NO_SUCH_AUTHORIZATION',
    bogus.verdict,
  );
  fmt.info(bogus.headline);

  const real = await lookupClaim(employee, legit.intent.txn_id);
  assert(
    'A genuine settled payment is confirmed as settled',
    real.exists && real.verdict === 'EXECUTED',
    real.verdict,
  );

  const evidence = await mustPass(
    'A voice note from WhatsApp is hashed locally and chained as evidence',
    () =>
      captureEvidence(employee, {
        platform: 'WhatsApp Web',
        url: 'https://web.whatsapp.com/',
        sender: '+91 90000 00000',
        kind: 'AUDIO',
        excerpt: 'Voice note demanding an urgent transfer',
        media_sha256: 'b'.repeat(64),
        media_bytes: 184320,
      }),
  );
  fmt.info(`chained at entry #${(evidence as { seq: number }).seq} -- the audio itself never moved`);

  await mustFail(
    'Evidence with a malformed media digest is refused',
    'BAD_MEDIA_DIGEST',
    () =>
      captureEvidence(employee, {
        platform: 'WhatsApp Web',
        kind: 'AUDIO',
        media_sha256: 'not-a-digest',
      }),
  );

  /* =======================================================================
   * Act 5 -- the window closing
   * ===================================================================== */
  const policy = await api<{ demo_window_seconds: number | null }>('/api/policy');
  const demoWindow = policy.demo_window_seconds;

  if (demoWindow !== null && demoWindow <= 30) {
    fmt.head(`Act 5 -- the window closing (${demoWindow}s demo window)`);

    const doomed = composeIntent(cfo, {
      org_id: 'acme-corp',
      type: 'wire_transfer',
      payee: { name: 'Nova Print Services', account: '331299001204', ifsc: 'SBIN0003312' },
      amount: { value: '260000.00', currency: 'INR' },
      purpose: 'Print run October',
      deadline: inHours(24),
    });
    await submitIntent(cfo, doomed.intent);
    const esc3 = await api<{ escrow_id: string; seconds_remaining: number }>(
      `/api/intents/${doomed.intent.txn_id}/accept`,
      { method: 'POST', token: employee.token },
    );
    fmt.step(
      `${esc3.escrow_id} opened with ${esc3.seconds_remaining}s on the clock; nobody approves it`,
    );

    await new Promise((r) => setTimeout(r, (demoWindow + 3) * 1000));

    const after = await api<{ state: string }>(`/api/escrows/${esc3.escrow_id}`, {
      token: cfo.token,
    });
    assert('Escrow voided when the window closed', after.state === 'EXPIRED', after.state);

    await mustFail('Approval arrives after the window closed', 'ESCROW_NOT_PENDING', () =>
      approve(ceo, esc3.escrow_id),
    );

    const voidedChain = await api<{
      entries: Array<{ type: string; payload: Record<string, unknown> }>;
    }>(`/api/audit/${doomed.intent.txn_id}`, { token: cfo.token });
    const expiredEntry = voidedChain.entries.find((e) => e.type === 'ESCROW_EXPIRED');
    if (expiredEntry && expiredEntry.payload.retained === true) {
      fmt.pass('The voided escrow was retained and chained, not deleted');
      fmt.info(`alert: ${String(expiredEntry.payload.alert)}`);
      passes++;
    } else {
      fmt.fail('No retained ESCROW_EXPIRED entry in the chain');
      failures++;
    }

    // A second attempt at the same account should now cost the attacker.
    const retry = composeIntent(cfo, {
      org_id: 'acme-corp',
      type: 'wire_transfer',
      payee: { name: 'Nova Print Services', account: '331299001204', ifsc: 'SBIN0003312' },
      amount: { value: '260000.00', currency: 'INR' },
      purpose: 'Print run October (resubmitted)',
      deadline: inHours(24),
    });
    await submitIntent(cfo, retry.intent);
    const esc4 = await api<{ risk: { rules_fired: string[]; tier: string } }>(
      `/api/intents/${retry.intent.txn_id}/accept`,
      { method: 'POST', token: employee.token },
    );
    if (esc4.risk.rules_fired.includes('RETRY_AFTER_EXPIRY')) {
      fmt.pass(`Retrying against the same account raised the tier to ${esc4.risk.tier}`);
      fmt.info(`rules fired: ${esc4.risk.rules_fired.join(', ')}`);
      passes++;
    } else {
      fmt.fail(`RETRY_AFTER_EXPIRY did not fire (${esc4.risk.rules_fired.join(', ')})`);
      failures++;
    }
  } else {
    fmt.head('Act 5 -- the window closing (skipped)');
    fmt.warn(
      'Start the server with SEAL_DEMO_WINDOW_SECONDS=8 to exercise the expiry path in seconds.',
    );
  }

  /* =======================================================================
   * Act 6 -- the receipt
   * ===================================================================== */
  fmt.head('Act 6 -- the audit chain');

  const verify = await api<{ ok: boolean; entries_checked: number; break_at_seq: number | null }>(
    `/api/audit/${legit.intent.txn_id}/verify`,
    { token: cfo.token },
  );
  assert(
    `Chain intact across ${verify.entries_checked} entries`,
    verify.ok,
    `break at ${verify.break_at_seq}`,
  );

  const chain = await api<{
    entries: Array<{ seq: number; type: string; actor: string | null }>;
  }>(`/api/audit/${legit.intent.txn_id}`, { token: cfo.token });
  for (const e of chain.entries) {
    fmt.info(`#${String(e.seq).padStart(3)}  ${e.type.padEnd(24)} ${e.actor ?? 'system'}`);
  }

  const m = await api<Record<string, unknown>>('/api/metrics', { token: cfo.token });
  fmt.title('Metrics');
  console.log(JSON.stringify(m, null, 2));

  fmt.title(
    failures === 0
      ? `All ${passes} checks passed. The fake can be flawless; it still authorizes nothing.`
      : `${passes} passed, ${failures} FAILED`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

/** A fresh throwaway intent, so replay defences do not mask the check under test. */
function mule2() {
  return composeIntent(
    { id: 'u_priya', role: 'CFO' } as Device,
    {
      org_id: 'acme-corp',
      type: 'wire_transfer',
      payee: { name: 'Zenith Trade Co', account: '77770001111', ifsc: 'UTIB0000123' },
      amount: { value: '1200000.00', currency: 'INR' },
      purpose: 'Urgent settlement',
      deadline: inHours(4),
    },
  );
}

/** An attacker's device: a real key, correctly used, simply never enrolled. */
async function forgedDevice(claimUserId: string, claimRole: string): Promise<Device> {
  const { privateKey, publicKeyHex } = await generateKeyPair();
  const credentialId = await credentialIdFor(publicKeyHex, 'authenticator');
  return {
    id: claimUserId,
    name: 'attacker',
    role: claimRole,
    token: '',
    publicKey: publicKeyHex,
    credentialId,
    reused: false,
    bootstrap: false,
    signer: createSoftwareSigner({
      credentialId,
      privateKey,
      counters: memoryCounterStore(),
      deviceKind: 'authenticator',
    }),
  };
}

async function railChecksFor(bundle: ApprovalBundle): Promise<string[]> {
  const res = await fetch(`${RAIL}/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...bundle, issued_at: new Date().toISOString() }),
  });
  const body = (await res.json()) as { checks?: Array<{ name: string }> };
  return (body.checks ?? []).map((c) => c.name);
}

async function railRefuses(label: string, bundle: ApprovalBundle, expectCheck?: string) {
  const res = await fetch(`${RAIL}/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(bundle),
  });
  const body = (await res.json()) as {
    ok: boolean;
    error?: string;
    checks?: Array<{ name: string; pass: boolean }>;
  };
  const failed = (body.checks ?? []).filter((c) => !c.pass).map((c) => c.name);
  if (res.status === 403 && body.error === 'APPROVAL_BUNDLE_INVALID') {
    if (expectCheck && !failed.includes(expectCheck)) {
      fmt.fail(`${label} -- refused, but not on ${expectCheck} (got ${failed.join(', ')})`);
      return false;
    }
    fmt.blocked(label);
    fmt.info(`403 APPROVAL_BUNDLE_INVALID -- failed checks: ${failed.join(', ')}`);
    return true;
  }
  fmt.fail(`${label} -- rail returned ${res.status} ${JSON.stringify(body).slice(0, 120)}`);
  return false;
}


main().catch((e) => {
  console.error('\nSimulation aborted:', e);
  process.exit(1);
});
