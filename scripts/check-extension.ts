/**
 * Drives the *built* extension bundle against a live SEAL backend.
 *
 *   npm run check:ext
 *
 * This loads `packages/extension/dist/background.js` -- the exact file Chrome
 * loads -- behind a shim of the handful of chrome.* APIs it touches, and then
 * talks to it the way the popup and the content script do: by posting messages
 * to its own router.
 *
 * So it exercises the real vault, the real message handlers, the real
 * canonicalization and the real signatures, end to end, without a browser. What
 * it cannot cover is DOM work: finding media bubbles in WhatsApp's markup and
 * hashing blob: URLs. That needs a real page and is called out as untested.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { approveEnrollments, enroll, api, type Device } from './lib.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = path.join(root, 'packages/extension/dist/background.js');

const E = String.fromCharCode(27);
const green = (t: string) => `${E}[32m${t}${E}[0m`;
const red = (t: string) => `${E}[31m${t}${E}[0m`;
const bold = (t: string) => `${E}[1m${t}${E}[0m`;
const dim = (t: string) => `${E}[2m${t}${E}[0m`;

let passes = 0;
let failures = 0;

const pass = (label: string, detail = '') => {
  console.log(`  ${green('PASS')}  ${label}${detail ? dim(` — ${detail}`) : ''}`);
  passes++;
};
const fail = (label: string, detail = '') => {
  console.log(`  ${red('FAIL')}  ${label}${detail ? ` — ${detail}` : ''}`);
  failures++;
};
const check = (label: string, ok: boolean, detail = '') =>
  ok ? pass(label, detail) : fail(label, detail);

/* ---------------------------------------------------------------------------
 * The chrome.* shim
 *
 * Only what the bundle actually calls. Storage is the part that matters: the
 * real extension keeps its sealed key here, so this has to behave like
 * chrome.storage.local does, including the "pass an object of defaults" form.
 * ------------------------------------------------------------------------- */

type Listener = (msg: never, sender: unknown, respond: (r: unknown) => void) => boolean | void;

const store = new Map<string, unknown>();
let onMessage: Listener | null = null;
const badge: { text: string } = { text: '' };

const chromeShim = {
  storage: {
    local: {
      async get(keys?: string | string[] | Record<string, unknown>) {
        if (keys === undefined) return Object.fromEntries(store);
        if (typeof keys === 'string') {
          return store.has(keys) ? { [keys]: store.get(keys) } : {};
        }
        if (Array.isArray(keys)) {
          const out: Record<string, unknown> = {};
          for (const k of keys) if (store.has(k)) out[k] = store.get(k);
          return out;
        }
        // Object form: stored values win over the supplied defaults.
        const out: Record<string, unknown> = { ...keys };
        for (const k of Object.keys(keys)) if (store.has(k)) out[k] = store.get(k);
        return out;
      },
      async set(items: Record<string, unknown>) {
        for (const [k, v] of Object.entries(items)) store.set(k, v);
      },
      async remove(key: string | string[]) {
        for (const k of [key].flat()) store.delete(k);
      },
    },
  },
  runtime: {
    onMessage: { addListener: (fn: Listener) => (onMessage = fn) },
    onInstalled: { addListener: () => undefined },
    getURL: (p: string) => `chrome-extension://seal/${p}`,
  },
  contextMenus: {
    create: () => undefined,
    removeAll: (cb?: () => void) => cb?.(),
    onClicked: { addListener: () => undefined },
  },
  action: {
    setBadgeText: async (o: { text: string }) => void (badge.text = o.text),
    setBadgeBackgroundColor: async () => undefined,
    openPopup: async () => undefined,
  },
  alarms: { create: () => undefined, onAlarm: { addListener: () => undefined } },
  notifications: { create: async () => undefined },
  tabs: { sendMessage: async () => undefined },
};

(globalThis as unknown as { chrome: typeof chromeShim }).chrome = chromeShim;

/** Post a message to the bundle's own router, exactly as the popup does. */
function send<T = unknown>(msg: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!onMessage) return reject(new Error('bundle registered no message listener'));
    onMessage(msg as never, {}, (r: unknown) => {
      const res = r as { ok: boolean; data?: T; error?: string; code?: string; name?: string };
      if (res?.ok) resolve(res.data as T);
      else reject(Object.assign(new Error(res?.error ?? 'no response'), { code: res?.code, name: res?.name }));
    });
  });
}

async function mustFail(label: string, expected: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    fail(label, 'it went through, and it should not have');
  } catch (e) {
    const err = e as Error & { code?: string };
    const got = err.code ?? err.name ?? err.message;
    if (got.includes(expected) || err.message.includes(expected)) pass(label, got);
    else fail(label, `blocked, but for the wrong reason: ${got}`);
  }
}

/* ---------------------------------------------------------------------------
 * The run
 * ------------------------------------------------------------------------- */

/** Stands in for the content script hashing delivered bytes in the page. */
const sha256 = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');

const PASSPHRASE = 'extension-passphrase';
const RUN = Date.now().toString(36);

async function main() {
  if (!fs.existsSync(BUNDLE)) {
    console.error(`Extension bundle not found.\nRun: npm run build:ext`);
    process.exit(1);
  }
  await api('/api/health').catch(() => {
    console.error('SEAL backend is not running. Start it with: npm run dev');
    process.exit(1);
  });

  console.log(`\n${bold('Extension bundle, end to end')}\n----------------------------`);
  console.log(dim(`  loading ${path.relative(root, BUNDLE)}`));

  // Cache-bust so a rebuilt bundle is actually re-read within one process.
  await import(`${pathToFileURL(BUNDLE).href}?v=${Date.now()}`);
  check('The built bundle loads and registers its message router', !!onMessage);

  /* --- identity ------------------------------------------------------- */

  const before = await send<{ signedIn: boolean; hasKey: boolean }>({ type: 'STATE' });
  check('A fresh install has no session and no key', !before.signedIn && !before.hasKey);

  await send({ type: 'SIGN_IN', userId: 'u_vikram', password: 'demo' });
  const signedIn = await send<{ signedIn: boolean; userRole: string }>({ type: 'STATE' });
  check('Sign-in stores a session', signedIn.signedIn && signedIn.userRole === 'TREASURY');

  /* --- the key -------------------------------------------------------- */

  // Two executive phones first, so the org is past its bootstrap ceremony and
  // the extension key has to be admitted by a real quorum.
  const cfo: Device = await enroll('u_priya', 'Priya phone');
  const ceo: Device = await enroll('u_rahul', 'Rahul phone');
  console.log(dim(`  quorum available: ${cfo.credentialId}, ${ceo.credentialId}`));

  const enrolled = await send<{ credential_id: string; bootstrap_ceremony: boolean; state: string }>({
    type: 'CREATE_KEY',
    passphrase: PASSPHRASE,
    label: 'Test extension',
  });
  check(
    'The extension generates a key and enrols it',
    enrolled.credential_id.startsWith('ext_'),
    enrolled.credential_id,
  );
  check(
    'It is not active until a quorum admits it',
    !enrolled.bootstrap_ceremony && enrolled.state === 'PENDING',
    enrolled.state,
  );

  const sealed = store.get('seal.extension.vault') as { cipher?: { ct: string }; public_key: string };
  check('The private key is sealed at rest, not stored raw', !!sealed?.cipher?.ct);
  check(
    'Nothing in storage leaks the private key',
    !JSON.stringify([...store.entries()]).includes('private_key'),
  );

  await approveEnrollments([cfo, ceo]);
  const active = await send<{ hasKey: boolean; credentialId: string }>({ type: 'STATE' });
  check('After the quorum signs, the extension holds an active key', active.hasKey);

  /* --- media ---------------------------------------------------------- */

  const clipDigest = sha256(`treasury-voice-note:${RUN}`);

  await mustFail(
    'Signing media with the key locked asks for the passphrase',
    'PASSPHRASE_REQUIRED',
    () =>
      send({
        type: 'MEDIA_SIGN',
        sha256: clipDigest,
        kind: 'AUDIO',
        bytes: 4096,
        platform: 'WhatsApp Web',
        caption: 'Voice note',
      }),
  );

  const record = await send<{ device_kind: string; signer_id: string }>({
    type: 'MEDIA_SIGN',
    sha256: clipDigest,
    kind: 'AUDIO',
    bytes: 4096,
    platform: 'WhatsApp Web',
    caption: 'Voice note about the invoice',
    passphrase: PASSPHRASE,
  });
  check(
    'The extension signs a voice note',
    record.device_kind === 'extension' && record.signer_id === 'u_vikram',
    record.device_kind,
  );

  // The documented split: media may reuse the unlock window, money may not.
  const second = sha256(`second-clip:${RUN}`);
  await send({
    type: 'MEDIA_SIGN',
    sha256: second,
    kind: 'IMAGE',
    bytes: 2048,
    platform: 'WhatsApp Web',
    caption: 'Screenshot',
  });
  pass('A second clip signs inside the unlock window, with no passphrase');

  const lookup = await send<{ signed: boolean; attestations: Array<{ signer_name: string }> }>({
    type: 'MEDIA_LOOKUP',
    sha256: clipDigest,
  });
  check(
    'A recipient hashing the same bytes sees who signed it',
    lookup.signed && lookup.attestations[0].signer_name === 'Vikram Iyer',
    lookup.attestations[0]?.signer_name,
  );

  const unsigned = await send<{ signed: boolean; headline: string }>({
    type: 'MEDIA_LOOKUP',
    sha256: sha256(`a-deepfake-nobody-signed:${RUN}`),
  });
  check('An unsigned file comes back unsigned', !unsigned.signed, unsigned.headline);

  /* --- payments ------------------------------------------------------- */

  const policy = await send<{ org_id: string }>({ type: 'POLICY' });
  const intent = {
    v: 1 as const,
    txn_id: `TX-EXT${RUN.slice(-4).toUpperCase()}`,
    org_id: policy.org_id,
    type: 'wire_transfer' as const,
    payee: { name: 'Nova Print Services', account: '331299001204', ifsc: 'SBIN0003312' },
    amount: { value: '90000.00', currency: 'INR' as const },
    purpose: 'Print run, authorized from the browser',
    deadline: new Date(Date.now() + 20 * 3600_000).toISOString(),
    originator: { user_id: 'u_vikram', role: 'TREASURY' as const },
    nonce: RUN.padEnd(16, '0').slice(0, 16),
    iat: new Date().toISOString(),
    exp: new Date(Date.now() + 30 * 60_000).toISOString(),
  };

  const request = await send<{ id: string; warnings: string[] }>({ type: 'CREATE_INTENT', intent });
  check('Composing a payment raises a signing request, not a payment', !!request.id, request.id);

  await mustFail(
    'Money will not reuse the media unlock window',
    'PASSPHRASE',
    () => send({ type: 'FULFIL', id: request.id }),
  );

  const fulfilled = await send<{ state: string }>({
    type: 'FULFIL',
    id: request.id,
    passphrase: PASSPHRASE,
  });
  check('With the passphrase, the extension authorizes it', fulfilled.state === 'SIGNED', fulfilled.state);

  const employee = await enroll('u_aravind', 'Aravind workstation', 'console');
  await approveEnrollments([cfo, ceo]);
  const escrow = await api<{ escrow_id: string; signer: { device_kind: string } }>(
    `/api/intents/${intent.txn_id}/accept`,
    { method: 'POST', token: employee.token },
  );
  check(
    'The escrow records that an extension key signed it',
    escrow.signer.device_kind === 'extension',
    escrow.signer.device_kind,
  );

  await mustFail(
    'The originator cannot approve their own payment from the extension',
    'SELF_APPROVAL',
    () => send({ type: 'REQUEST_APPROVAL', escrowId: escrow.escrow_id, decision: 'APPROVE' }),
  );

  /* --- media -> payment binding ---------------------------------------- */

  // The whole point of the chat-first flow: raise a payment straight off an
  // invoice image, and have the two provably refer to the same file.
  const invoice = sha256(`invoice-image:${RUN}`);
  await send({
    type: 'MEDIA_SIGN',
    sha256: invoice,
    kind: 'IMAGE',
    bytes: 91_000,
    platform: 'WhatsApp Web',
    caption: 'Invoice 4471',
    passphrase: PASSPHRASE,
  });

  await send({
    type: 'CREATE_ESCROW_FOR_MEDIA',
    mediaSha256: invoice,
    payeeName: 'Nova Print Services',
    account: '331299001204',
    ifsc: 'SBIN0003312',
    amount: '61000.00',
    purpose: 'Settlement against invoice 4471',
    passphrase: PASSPHRASE,
  });

  const linked = await send<{
    signed: boolean;
    escrows?: Array<{ txn_id: string; escrow_id: string }>;
  }>({ type: 'MEDIA_LOOKUP', sha256: invoice });
  check(
    'A payment raised from a file is linked back to that exact file',
    (linked.escrows?.length ?? 0) > 0,
    `${linked.escrows?.length ?? 0} escrow(s): ${linked.escrows?.[0]?.txn_id ?? '-'}`,
  );

  const unrelated = await send<{ escrows?: unknown[] }>({
    type: 'MEDIA_LOOKUP',
    sha256: clipDigest,
  });
  check(
    'A different file does not inherit that payment',
    (unrelated.escrows?.length ?? 0) === 0,
    `${unrelated.escrows?.length ?? 0} escrow(s)`,
  );

  /* --- caller challenges ---------------------------------------------- */

  const challenge = await api<{ id: string; code: string }>('/api/caller-challenges', {
    body: {
      claimed_user_id: 'u_vikram',
      channel: 'VIDEO',
      demand: 'Approve the print run immediately',
      source: { platform: 'WhatsApp Web' },
    },
    token: employee.token,
  });

  const inbox = await send<Array<{ id: string; code: string; state: string }>>({ type: 'CHALLENGES' });
  const mine = inbox.find((c) => c.id === challenge.id);
  check('The challenge reaches the extension inbox', !!mine, mine?.state);
  check(
    'The extension can read the code, because it is the claimed person',
    mine?.code === challenge.code,
    mine?.code,
  );

  const denied = await send<{ state: string }>({ type: 'DENY_CHALLENGE', id: challenge.id });
  check('Denying takes one call and no key', denied.state === 'DENIED', denied.state);

  const second_challenge = await api<{ id: string }>('/api/caller-challenges', {
    body: { claimed_user_id: 'u_vikram', channel: 'PHONE', demand: 'Checking a vendor detail' },
    token: employee.token,
  });
  const confirmed = await send<{ state: string; attested: boolean }>({
    type: 'CONFIRM_CHALLENGE',
    id: second_challenge.id,
    passphrase: PASSPHRASE,
  });
  check(
    'Confirming is signed by the extension key',
    confirmed.state === 'CONFIRMED' && confirmed.attested,
    confirmed.state,
  );

  /* --- lock ------------------------------------------------------------ */

  await send({ type: 'LOCK' });
  await mustFail(
    'After locking, even media asks again',
    'PASSPHRASE_REQUIRED',
    () =>
      send({
        type: 'MEDIA_SIGN',
        sha256: sha256(`third-clip:${RUN}`),
        kind: 'IMAGE',
        bytes: 512,
        platform: 'WhatsApp Web',
        caption: 'x',
      }),
  );

  await send({ type: 'DESTROY_KEY' });
  const gone = await send<{ hasKey: boolean }>({ type: 'STATE' });
  check('Destroying the key removes it from storage', !gone.hasKey);

  console.log(
    failures === 0
      ? `\n${bold(`All ${passes} extension checks passed.`)}\n`
      : `\n${red(`${passes} passed, ${failures} FAILED`)}\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\nExtension check aborted:', e);
  process.exit(1);
});
