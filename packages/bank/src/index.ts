import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import { approvalHash, canonicalize, envelopeDeviceKind, toPaise } from '@seal/shared';
import { verifyAnyEnvelope } from '@seal/shared/webauthn';
import type { ApprovalBundle, BankReceipt, DeviceKind } from '@seal/shared';

/**
 * MOCK PAYMENT RAIL -- the enforcement point.
 *
 * This is the component that turns the workflow into a security control. If an
 * employee can still log into a bank portal and pay by hand, the escrow is
 * advisory. So this rail has exactly one way in, and it refuses anything that
 * is not a complete, independently verifiable approval bundle:
 *
 *     403 APPROVAL_BUNDLE_INVALID
 *
 * "Independently" is meant literally. This process never asks SEAL whether a
 * signature is good. It re-canonicalizes the intent, recomputes the hash, and
 * checks every signature itself against public keys it reads from its own copy
 * of the key directory. It keeps its own settled-nonce ledger, so a bundle
 * replayed at the rail is refused even if SEAL were fully compromised.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(here, '..', '..', '..', 'data');
const DIRECTORY_FILE = path.join(DATA_DIR, 'key-directory.json');
const LEDGER_FILE = path.join(DATA_DIR, 'bank-ledger.json');
const PORT = Number(process.env.BANK_PORT ?? 4001);
const SEAL_URL = process.env.SEAL_URL ?? 'http://localhost:4000';
const RAIL_SECRET = process.env.SEAL_RAIL_SECRET ?? 'demo-rail-secret';

/**
 * Refusals are reported back to SEAL so that an attack aimed straight at the
 * rail still lands in the audit chain. Fire-and-forget: if SEAL is down or
 * compromised, the rail still refuses. Reporting is evidence, not permission.
 */
async function reportRefusal(bundle: ApprovalBundle, checks: Check[]) {
  try {
    await fetch(`${SEAL_URL}/api/rail/refusals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rail-secret': RAIL_SECRET },
      body: JSON.stringify({
        txn_id: bundle?.intent?.txn_id ?? null,
        intent_hash: bundle?.intent_hash ?? null,
        amount: bundle?.intent?.amount?.value ?? null,
        payee: bundle?.intent?.payee ?? null,
        failed_checks: checks.filter((c) => !c.pass).map((c) => c.name),
      }),
    });
  } catch {
    /* the rail's decision does not depend on SEAL hearing about it */
  }
}

/**
 * The rail's own mandate policy. It does not inherit SEAL's risk decisions, and
 * it does not inherit SEAL's custody rules either -- it enforces its own.
 *
 * A bank that accepts a corporate mandate has its own view of who may authorize
 * what and from which kind of device. Duplicating the custody rule here is the
 * point: if someone changed the rule inside SEAL, the rail would still refuse.
 */
const RAIL_POLICY = {
  DUAL_APPROVAL_ABOVE: '500000.00',
  MAX_BUNDLE_AGE_MS: 10 * 60_000,
  /** Custody tiers this rail will accept a signature from. */
  ACCEPTED_CUSTODY: new Set<DeviceKind>(['authenticator', 'hardware']),
};

interface Directory {
  org_id: string;
  credentials: Record<
    string,
    {
      user_id: string;
      name: string;
      role: string;
      binding: 'software' | 'hardware';
      device_kind: DeviceKind;
      public_key: string;
      webauthn_id: string | null;
      aaguid: string | null;
      mandate_paise: number;
    }
  >;
}

function loadDirectory(): Directory | null {
  try {
    return JSON.parse(fs.readFileSync(DIRECTORY_FILE, 'utf8')) as Directory;
  } catch {
    return null;
  }
}

interface LedgerEntry {
  reference: string;
  txn_id: string;
  nonce: string;
  intent_hash: string;
  amount: string;
  payee: string;
  settled_at: string;
}

function loadLedger(): LedgerEntry[] {
  try {
    return JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8')) as LedgerEntry[];
  } catch {
    return [];
  }
}

function appendLedger(entry: LedgerEntry): void {
  const ledger = loadLedger();
  ledger.push(entry);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LEDGER_FILE, JSON.stringify(ledger, null, 2));
}

/**
 * The rail does not track per-credential signature counters -- SEAL owns those,
 * and a rail that trusted a counter SEAL reported would not be verifying
 * independently at all. Its own replay defence is the settled-nonce ledger
 * below, which is stronger here: it is stateful on the rail side and survives
 * a full compromise of SEAL.
 */
const RAIL_COUNTER_UNKNOWN = 0;

type Check = { name: string; pass: boolean; detail?: string };

async function inspect(bundle: ApprovalBundle): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, pass: boolean, detail?: string) => {
    checks.push({ name, pass, detail });
    return pass;
  };

  const directory = loadDirectory();
  if (!add('key_directory_available', !!directory, DIRECTORY_FILE)) return checks;

  if (!add('bundle_shape', bundle?.v === 1 && !!bundle.intent && !!bundle.intent_signature)) {
    return checks;
  }
  add('lane_is_signed', bundle.lane === 'A', `lane=${bundle.lane}`);

  // 1. The hash is recomputed here. A bundle that ships its own hash proves
  //    nothing -- the rail canonicalizes the intent itself.
  const recomputed = createHash('sha256').update(canonicalize(bundle.intent), 'utf8').digest('hex');
  if (
    !add(
      'intent_hash_matches_payload',
      recomputed === bundle.intent_hash,
      `recomputed ${recomputed.slice(0, 16)}...`,
    )
  ) {
    return checks;
  }

  // 2. The executive signature over that exact hash.
  const signerCred = directory!.credentials[bundle.intent_signature.credential_id];
  if (!add('signer_credential_known', !!signerCred, bundle.intent_signature.credential_id)) {
    return checks;
  }
  const signerVerdict = await verifyAnyEnvelope(bundle.intent_signature, { ...signerCred!, counter: RAIL_COUNTER_UNKNOWN }, {
    purpose: 'INTENT',
    payloadHash: bundle.intent_hash,
  });
  if (!add('intent_signature_valid', signerVerdict.ok, signerVerdict.reason)) return checks;

  // Custody, checked here on the rail's own authority.
  add(
    'signer_custody_permitted',
    RAIL_POLICY.ACCEPTED_CUSTODY.has(signerCred!.device_kind),
    `${signerCred!.device_kind} key`,
  );
  add(
    'signer_custody_matches_enrolment',
    envelopeDeviceKind(bundle.intent_signature) === signerCred!.device_kind,
  );

  add(
    'signer_may_originate',
    ['CFO', 'CEO', 'TREASURY'].includes(signerCred!.role),
    `${signerCred!.name} (${signerCred!.role})`,
  );
  add(
    'intent_originator_matches_signer',
    bundle.intent.originator.user_id === signerCred!.user_id,
  );

  const amount = toPaise(bundle.intent.amount.value);
  add(
    'within_signer_mandate',
    amount <= BigInt(signerCred!.mandate_paise),
    `${bundle.intent.amount.value} vs mandate`,
  );

  // 3. Validity window and the rail's own replay ledger.
  add('intent_not_expired', Date.parse(bundle.intent.exp) > Date.now(), bundle.intent.exp);
  add(
    'bundle_fresh',
    Math.abs(Date.now() - Date.parse(bundle.issued_at)) < RAIL_POLICY.MAX_BUNDLE_AGE_MS,
  );
  const ledger = loadLedger();
  add(
    'nonce_not_already_settled',
    !ledger.some((e) => e.nonce === bundle.intent.nonce),
    bundle.intent.nonce,
  );
  add('txn_not_already_settled', !ledger.some((e) => e.txn_id === bundle.intent.txn_id));

  // 4. The quorum. Distinct approvers, each signing over this exact intent hash
  //    and this exact escrow, each within their own mandate.
  const approvals = Array.isArray(bundle.approvals) ? bundle.approvals : [];
  const seen = new Set<string>();
  let valid = 0;

  for (const [i, a] of approvals.entries()) {
    const tag = `approval[${i}]`;
    const cred = directory!.credentials[a.envelope.credential_id];
    if (!add(`${tag}.credential_known`, !!cred, a.envelope.credential_id)) continue;
    if (!add(`${tag}.decision_is_approve`, a.assertion.decision === 'APPROVE')) continue;
    if (!add(`${tag}.binds_this_intent`, a.assertion.intent_hash === bundle.intent_hash)) continue;
    if (!add(`${tag}.binds_this_escrow`, a.assertion.escrow_id === bundle.escrow_id)) continue;
    if (!add(`${tag}.approver_matches_credential`, a.assertion.approver_id === cred!.user_id)) {
      continue;
    }
    if (!add(`${tag}.not_the_originator`, cred!.user_id !== signerCred!.user_id)) continue;
    if (!add(`${tag}.distinct_approver`, !seen.has(cred!.user_id), cred!.user_id)) continue;
    if (
      !add(
        `${tag}.within_approver_mandate`,
        amount <= BigInt(cred!.mandate_paise),
        `${cred!.name} (${cred!.role})`,
      )
    ) {
      continue;
    }

    if (
      !add(
        `${tag}.custody_permitted`,
        RAIL_POLICY.ACCEPTED_CUSTODY.has(cred!.device_kind),
        `${cred!.name} signed with a ${cred!.device_kind} key`,
      )
    ) {
      continue;
    }
    if (!add(`${tag}.custody_matches_enrolment`, envelopeDeviceKind(a.envelope) === cred!.device_kind)) {
      continue;
    }

    const payloadHash = await approvalHash(a.assertion);
    const verdict = await verifyAnyEnvelope(a.envelope, { ...cred!, counter: RAIL_COUNTER_UNKNOWN }, {
      purpose: 'APPROVAL',
      payloadHash,
    });
    if (!add(`${tag}.signature_valid`, verdict.ok, verdict.reason ?? cred!.name)) continue;

    seen.add(cred!.user_id);
    valid++;
  }

  // The rail's own floor, and the bundle's own declared requirement, whichever
  // is stricter. Trusting the bundle *upward* is safe: lowering the number in
  // it can never get a payment below the rail's independent threshold, and
  // honouring a higher one means an originating policy that asked for three
  // signatures cannot be settled with two.
  const railFloor = amount > toPaise(RAIL_POLICY.DUAL_APPROVAL_ABOVE) ? 2 : 1;
  const declared = Number(bundle.risk?.required_approvals ?? 0);
  const required = Math.max(railFloor, Number.isFinite(declared) ? declared : 0);
  add(
    'quorum_satisfied',
    valid >= required,
    `${valid} valid distinct approval(s); rail floor ${railFloor}, bundle declares ${declared}`,
  );

  return checks;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '512kb' }));

app.post('/execute', async (req, res) => {
  const bundle = req.body as ApprovalBundle;
  let checks: Check[];
  try {
    checks = await inspect(bundle);
  } catch (e) {
    checks = [{ name: 'bundle_parseable', pass: false, detail: (e as Error).message }];
  }

  const failed = checks.filter((c) => !c.pass);
  if (failed.length > 0) {
    console.log(
      `[rail] REFUSED ${bundle?.intent?.txn_id ?? '(no txn)'} -- ${failed.map((f) => f.name).join(', ')}`,
    );
    void reportRefusal(bundle, checks);
    const body: BankReceipt = { ok: false, error: 'APPROVAL_BUNDLE_INVALID', checks };
    res.status(403).json(body);
    return;
  }

  const reference = `RTGS-${randomBytes(4).toString('hex').toUpperCase()}`;
  const settled_at = new Date().toISOString();
  appendLedger({
    reference,
    txn_id: bundle.intent.txn_id,
    nonce: bundle.intent.nonce,
    intent_hash: bundle.intent_hash,
    amount: bundle.intent.amount.value,
    payee: bundle.intent.payee.name,
    settled_at,
  });
  console.log(`[rail] SETTLED ${bundle.intent.txn_id} -> ${reference}`);

  const body: BankReceipt = { ok: true, reference, settled_at, checks };
  res.json(body);
});

/** Anything that is not a full approval bundle. There is no other way in. */
app.all('/pay', (_req, res) => {
  const body: BankReceipt = {
    ok: false,
    error: 'APPROVAL_BUNDLE_INVALID',
    checks: [
      {
        name: 'manual_payment_path',
        pass: false,
        detail: 'This rail has no manual path. Submit a signed approval bundle to /execute.',
      },
    ],
  };
  res.status(403).json(body);
});

app.get('/ledger', (_req, res) => res.json(loadLedger()));
app.get('/health', (_req, res) =>
  res.json({ ok: true, service: 'mock-rail', directory_loaded: !!loadDirectory() }),
);

app.listen(PORT, () => {
  console.log(`[rail] mock payment rail on http://localhost:${PORT}`);
  console.log(`[rail] verifying against ${DIRECTORY_FILE}`);
});
