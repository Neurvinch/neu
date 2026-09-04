/**
 * SEAL Browser Extension — End-to-End Test Suite.
 *
 * Exercises the complete extension workflow against the running SEAL backend:
 *   1. Extension Authentication & Config resolution
 *   2. In-Chat Ledger Lookup (Legitimate vs Fake transaction references)
 *   3. Caller Challenge against Deepfake Vishing (Impersonation detection & Denial)
 *   4. Caller Challenge Legitimate Attestation (Cryptographic confirmation)
 *   5. In-browser Forensic Evidence Capture & Media Hashing
 *   6. Audit Chain Integrity Verification
 *
 * Usage:
 *   npx tsx scripts/test-extension.ts
 */
import {
  api,
  approve,
  approveEnrollments,
  captureEvidence,
  composeIntent,
  confirmChallenge,
  denyChallenge,
  enroll,
  fmt,
  login,
  lookupClaim,
  lookupMedia,
  raiseChallenge,
  sha256,
  signMedia,
  submitIntent,
  type CallerChallenge,
  type Device,
} from './lib.js';

let passes = 0;
let failures = 0;

function assert(label: string, condition: boolean, detail = '') {
  if (condition) {
    fmt.pass(label);
    passes++;
  } else {
    fmt.fail(`${label}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

async function main() {
  await api('/api/health').catch(() => {
    console.error('SEAL backend is not running at http://localhost:4000. Start it with: npm run dev');
    process.exit(1);
  });

  fmt.head('SEAL Browser Extension — End-to-End Test Suite');

  /* ------------------------------------------------------------------------
   * 1. Extension Auth & Policy
   * ---------------------------------------------------------------------- */
  fmt.title('Step 1: Extension Session & Policy Resolution');
  const employeeSession = await login('u_aravind', 'demo');
  assert('Employee signs in via extension', !!employeeSession.token);

  const policy = await api<{ challengeable: Array<{ id: string; name: string; role: string }> }>(
    '/api/policy',
    { token: employeeSession.token },
  );
  assert(
    'Extension fetches challengeable executive roster',
    Array.isArray(policy.challengeable) && policy.challengeable.length >= 2,
    `found ${policy.challengeable.length} executives`,
  );

  const ceo = await enroll('u_rahul', 'Rahul Phone (CEO)');
  const cfo = await enroll('u_priya', 'Priya Phone (CFO)');
  const cto = await enroll('u_anita', 'Anita Phone (CTO)');
  const treasury = await enroll('u_vikram', 'Vikram Phone (Treasury)');
  await approveEnrollments([ceo, cfo]);
  const employeeDevice: Device = {
    id: 'u_aravind',
    name: employeeSession.user.name,
    role: employeeSession.user.role,
    token: employeeSession.token,
    signer: null as any,
    publicKey: '',
    credentialId: '',
    reused: false,
    bootstrap: false,
  };

  /* ------------------------------------------------------------------------
   * 2. Ledger Lookup (In-Chat / Content Script Verification)
   * ---------------------------------------------------------------------- */
  fmt.title('Step 2: Ledger Lookup (In-Chat Content Script & Popup)');
  
  // Negative lookup: Attacker mentions a bogus reference in chat/email
  const fakeLookup = await lookupClaim(employeeDevice, 'TX-BOGUS-999');
  assert(
    'Extension catches fake transaction reference',
    !fakeLookup.exists && !fakeLookup.authorized && fakeLookup.verdict === 'NO_SUCH_AUTHORIZATION',
    `verdict: ${fakeLookup.verdict}`,
  );

  // Positive lookup: Check recent genuine transaction from escrows
  const activeEscrows = await api<Array<{ txn_id: string; state: string }>>('/api/escrows', {
    token: employeeSession.token,
  });
  let realLookupTxn = activeEscrows.find((e) => e.state === 'EXECUTED' || e.state === 'PENDING_QUORUM')?.txn_id;
  if (!realLookupTxn) {
    const draft = composeIntent(cfo, {
      org_id: 'acme-corp',
      type: 'wire_transfer',
      payee: { name: 'Alton Logistics Pvt Ltd', account: '501004419000', ifsc: 'HDFC0001234' },
      amount: { value: '150000.00', currency: 'INR' },
      purpose: 'Quarterly supplier payment',
      deadline: new Date(Date.now() + 86400000).toISOString(),
      validityMinutes: 60,
    });
    await submitIntent(cfo, draft.intent);
    await api<{ escrow_id: string }>(`/api/intents/${draft.intent.txn_id}/accept`, {
      method: 'POST',
      token: employeeSession.token,
    });
    realLookupTxn = draft.intent.txn_id;
  }
  const realLookup = await lookupClaim(employeeDevice, realLookupTxn);
  assert(
    `Extension confirms genuine transaction in ledger: ${realLookupTxn}`,
    realLookup.exists && realLookup.authorized,
    `verdict: ${realLookup.verdict}, headline: ${realLookup.headline}`,
  );

  /* ------------------------------------------------------------------------
   * 3. Caller Challenge: Deepfake Impersonation Call Blocked
   * ---------------------------------------------------------------------- */
  fmt.title('Step 3: Caller Challenge — Deepfake Impersonation Blocked');

  // Employee receives high-pressure call claiming to be CEO Rahul Menon
  const challenge1 = await raiseChallenge(
    employeeDevice,
    'u_rahul',
    'PHONE',
    'Emergency supplier acquisition wire of 42L immediately',
  );

  assert('Challenge raised successfully', !!challenge1.id && challenge1.id.startsWith('CHL-'));
  assert('Challenge state is PENDING', challenge1.state === 'PENDING');
  assert('6-character read-back code generated', /^[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(challenge1.code));
  assert('Raiser can see challenge code', challenge1.code !== '···-···', `code: ${challenge1.code}`);

  // Third party cannot see the secret code
  const auditorSession = await login('u_meera', 'demo');
  const thirdPartyView = await api<CallerChallenge>(`/api/caller-challenges/${challenge1.id}`, {
    token: auditorSession.token,
  });
  assert('Secret code withheld from third parties', thirdPartyView.code === '···-···');

  // Real CEO sees challenge on his Authenticator device and taps DENY ("Not me!")
  const deniedChallenge = await denyChallenge(ceo, challenge1.id);
  assert('Real executive denies the fraudulent call', deniedChallenge.state === 'DENIED');

  // Employee extension re-checks state
  const employeeChecked = await api<CallerChallenge>(`/api/caller-challenges/${challenge1.id}`, {
    token: employeeSession.token,
  });
  assert(
    'Extension displays DENIED status to employee',
    employeeChecked.state === 'DENIED' && employeeChecked.resolved_at !== null,
  );

  /* ------------------------------------------------------------------------
   * 4. Caller Challenge: Legitimate Executive Confirmation
   * ---------------------------------------------------------------------- */
  fmt.title('Step 4: Caller Challenge — Legitimate Attestation Confirmed');

  // Employee raises challenge for CFO Priya Nair
  const challenge2 = await raiseChallenge(
    employeeDevice,
    'u_priya',
    'VIDEO',
    'Quarterly vendor reconciliation sign-off',
  );
  assert('Second challenge raised for CFO', !!challenge2.id);

  // Real CFO signs attestation from her enrolled Authenticator device
  const confirmedChallenge = await confirmChallenge(cfo, challenge2.id);
  assert(
    'CFO cryptographically signs attestation confirming call',
    confirmedChallenge.state === 'CONFIRMED' && confirmedChallenge.attested === true,
  );

  /* ------------------------------------------------------------------------
   * 5. In-Browser Forensic Evidence Capture
   * ---------------------------------------------------------------------- */
  fmt.title('Step 5: Forensic Evidence Capture & Media Hashing');

  const simulatedAudioClip = Buffer.from('RIFF_SIMULATED_DEEPFAKE_VOICE_SAMPLE_WAVEFORM');
  const mediaHash = sha256(simulatedAudioClip.toString('utf8'));

  const evidenceReceipt = await captureEvidence(employeeDevice, {
    platform: 'WhatsApp Web',
    url: 'https://web.whatsapp.com/',
    sender: '+91 98400 XXXXX',
    kind: 'AUDIO',
    excerpt: 'Voice note demanding urgent wire transfer to new bank account',
    media_sha256: mediaHash,
    media_bytes: simulatedAudioClip.length,
    challenge_id: challenge1.id,
  });

  assert(
    'Forensic evidence recorded with SHA-256 media hash',
    evidenceReceipt.seq > 0 && !!evidenceReceipt.entry_hash,
    `seq: #${evidenceReceipt.seq}, hash: ${evidenceReceipt.entry_hash.slice(0, 16)}...`,
  );

  /* ------------------------------------------------------------------------
   * 6. Audit Chain Integrity
   * ---------------------------------------------------------------------- */
  fmt.title('Step 6: Audit Chain Integrity Verification');

  const m = await api<{
    audit: {
      chain_ok: boolean;
      entries: number;
      break_at_seq: number | null;
      completeness_pct: number;
    };
  }>('/api/metrics', { token: employeeSession.token });

  assert(
    'Audit forward hash chain completely intact',
    m.audit.chain_ok && m.audit.break_at_seq === null,
    `verified ${m.audit.entries} entries without breaks (${m.audit.completeness_pct}% complete)`,
  );

  /* ------------------------------------------------------------------------
   * 7. WhatsApp Media Detection & Verification (Unsigned Warning)
   * ---------------------------------------------------------------------- */
  fmt.title('Step 7: WhatsApp Media Detection & Signature Verification');

  const invoiceBytes = Buffer.from(`SEAL_SIMULATED_VENDOR_INVOICE_IMAGE_BYTES_${Date.now()}_${Math.random()}`);
  const invoiceHash = sha256(invoiceBytes.toString('utf8'));

  // Negative verification: Extension detects invoice on WhatsApp, hashes locally, checks ledger
  const unsignedLookup = await lookupMedia(employeeDevice, invoiceHash);
  assert(
    'Extension flags unverified media on WhatsApp Web',
    !unsignedLookup.signed && unsignedLookup.attestations.length === 0,
    `headline: "${unsignedLookup.headline}"`,
  );

  /* ------------------------------------------------------------------------
   * 8. In-Situ Digital Signing of Media by Executive Device Key
   * ---------------------------------------------------------------------- */
  fmt.title('Step 8: In-Situ Digital Signing of Media by Executive');

  const mediaRecord = await signMedia(ceo, {
    sha256: invoiceHash,
    kind: 'IMAGE',
    bytes: invoiceBytes.length,
    caption: 'Invoice #AL-9842 verified and approved by CEO Rahul Menon',
  });

  assert(
    'Executive cryptographically signs media hash using Ed25519 device key',
    mediaRecord.sha256 === invoiceHash && mediaRecord.signer_id === ceo.id,
    `signer: ${mediaRecord.signer_name} (${mediaRecord.signer_role}), audit seq #${mediaRecord.audit_seq}`,
  );

  // Recipient / employee re-verifies media
  const signedLookup = await lookupMedia(employeeDevice, invoiceHash);
  assert(
    'Extension displays verified executive provenance for signed WhatsApp media',
    signedLookup.signed && signedLookup.attestations[0].signer_id === ceo.id,
    `provenance: signed by ${signedLookup.attestations[0].signer_name} · ${signedLookup.attestations[0].device_kind} key`,
  );

  /* ------------------------------------------------------------------------
   * 9. Escrow Creation Directly from WhatsApp Signed Media
   * ---------------------------------------------------------------------- */
  fmt.title('Step 9: Escrow Creation Bound to WhatsApp Signed Media');

  const intentDraft = composeIntent(ceo, {
    org_id: 'acme-corp',
    type: 'wire_transfer',
    payee: { name: 'Alton Logistics Pvt Ltd', account: '50100234564419', ifsc: 'HDFC0001234' },
    amount: { value: '4200000.00', currency: 'INR' },
    purpose: `Authorized WhatsApp invoice Media #${invoiceHash.slice(0, 12)}`,
    media_sha256: invoiceHash,
    deadline: new Date(Date.now() + 86400000).toISOString(),
    validityMinutes: 60,
  });

  await submitIntent(ceo, intentDraft.intent);
  const escrow = await api<{
    escrow_id: string;
    txn_id: string;
    state: string;
    required_approvals: number;
  }>(`/api/intents/${intentDraft.intent.txn_id}/accept`, {
    method: 'POST',
    token: employeeSession.token,
  });

  assert(
    'Time-boxed SEAL escrow opened directly from verified media',
    !!escrow.escrow_id && escrow.state === 'PENDING_QUORUM',
    `escrow: ${escrow.escrow_id} (Txn: ${escrow.txn_id}, requires ${escrow.required_approvals} approvals)`,
  );

  // Verify that lookupMedia now links directly to the active escrow
  const lookupWithEscrow = await lookupMedia(employeeDevice, invoiceHash);
  assert(
    'Extension media lookup reports active linked escrow',
    lookupWithEscrow.escrows !== undefined && lookupWithEscrow.escrows.length > 0,
    `found linked escrow #${lookupWithEscrow.escrows?.[0]?.txn_id}`,
  );

  /* ------------------------------------------------------------------------
   * 10. Extension Notification & Quorum Settlement on RTGS Rail
   * ---------------------------------------------------------------------- */
  fmt.title('Step 10: Extension Approver Notification & Quorum Settlement');

  // Approver (CFO Priya Nair) reviews pending escrows in extension
  const pendingEscrows = await api<Array<{ escrow_id: string; state: string }>>('/api/escrows', {
    token: cfo.token,
  });
  assert(
    'Pending escrow appears in approver extension queue',
    pendingEscrows.some((e) => e.escrow_id === escrow.escrow_id && e.state === 'PENDING_QUORUM'),
  );

  // Approvers sign approval assertions using their device keys
  await approve(cfo, escrow.escrow_id, 'APPROVE');
  if (escrow.required_approvals > 1) {
    await approve(cto, escrow.escrow_id, 'APPROVE');
  }
  if (escrow.required_approvals > 2) {
    await approve(treasury, escrow.escrow_id, 'APPROVE');
  }

  // Check that the quorum is satisfied and escrow settled on RTGS rail
  const settledEscrow = await api<{
    escrow_id: string;
    state: string;
    receipt: { ok: boolean; reference?: string; utr?: string; settled_at?: string } | null;
  }>(`/api/escrows/${escrow.escrow_id}`, {
    token: employeeSession.token,
  });

  assert(
    'Escrow achieves quorum and executes settlement on RTGS rail',
    settledEscrow.state === 'EXECUTED' && settledEscrow.receipt?.ok === true,
    `status: ${settledEscrow.state}, bank ref: ${settledEscrow.receipt?.reference ?? settledEscrow.receipt?.utr}`,
  );

  console.log(`
------------------------------------------------------
Extension End-to-End Test Suite: ${passes} passed, ${failures} failed.
------------------------------------------------------
`);

  if (failures > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('Fatal error in extension test suite:', e);
  process.exit(1);
});
