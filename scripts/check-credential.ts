/**
 * Exercises the *real* device credential code (@seal/shared/vault) under Node,
 * with a localStorage shim. Node and browsers share the same WebCrypto API, so
 * this checks the vault's PBKDF2/AES-GCM parameters, the signer, the custody
 * tier and the counter persistence without needing a browser in the loop.
 *
 * The hardware tier cannot be exercised here -- WebAuthn needs a real
 * authenticator and a real user gesture. That path is covered by the browser,
 * and its verification by the rail is covered in the simulation.
 *
 *   npm run check
 */
import { approvalHash, canonicalize, sha256Hex, utf8, verifyEnvelope } from '@seal/shared';
import type { ApprovalAssertion } from '@seal/shared';

// Minimal localStorage, installed before the vault module is imported.
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
} as Storage;

const { createVaultStore, WrongPassphrase } = await import('@seal/shared/vault');

// The authenticator tier: the custody an executive actually signs with.
const store_ = createVaultStore({ namespace: 'seal.check', deviceKind: 'authenticator' });
const hashOf = async (v: unknown) => sha256Hex(utf8(canonicalize(v)));

const E = String.fromCharCode(27);
const green = (t: string) => `${E}[32m${t}${E}[0m`;
const red = (t: string) => `${E}[31m${t}${E}[0m`;
const bold = (t: string) => `${E}[1m${t}${E}[0m`;

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? green('PASS') : red('FAIL')}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

console.log(`
${bold('Device credential check')}
-----------------------`);

const vault = await store_.create({
  userId: 'u_test',
  passphrase: 'correct horse',
  label: 'test device',
});

check('key generated and stored', !!store_.load('u_test'));
check('custody tier is recorded on the credential', vault.device_kind === 'authenticator');
check('credential id encodes the custody tier', vault.credential_id.startsWith('auth_'));
check('public key is 32 bytes of hex', /^[0-9a-f]{64}$/.test(vault.public_key));
check(
  'private key is not stored in the clear',
  !!store_.load('u_test')!.cipher.ct && !JSON.stringify(store_.load('u_test')).includes('"private'),
  'sealed under AES-GCM',
);

// The passphrase actually gates the key.
let rejected = false;
try {
  await store_.unlock(vault, 'wrong passphrase');
} catch (e) {
  rejected = e instanceof WrongPassphrase;
}
check('wrong passphrase is rejected', rejected);
check('right passphrase opens it', (await store_.unlock(vault, 'correct horse')).length === 32);

// A signature the server would accept.
const intent = { v: 1, txn_id: 'TX-CHECK', amount: { value: '100.00', currency: 'INR' } };
const hash = await hashOf(intent);
const env = await store_.sign('u_test', 'INTENT', hash, 'correct horse');
if (env.alg !== 'Ed25519') throw new Error('expected a software envelope');

check('envelope reports software binding', env.binding === 'software');
check('envelope reports the authenticator custody tier', env.device_kind === 'authenticator');
check('envelope claims user presence', env.user_presence === true);
check('counter advanced to 1', env.counter === 1);
check(
  'signature verifies against the public key',
  (await verifyEnvelope(env, vault.public_key, { purpose: 'INTENT', payloadHash: hash })).ok,
);

// Domain separation: the same signature must not pass as an approval.
const asApproval = await verifyEnvelope(env, vault.public_key, {
  purpose: 'APPROVAL',
  payloadHash: hash,
});
check('an INTENT signature cannot pass as an APPROVAL', !asApproval.ok, asApproval.reason);

// Tampering with any covered field must break it.
const tampered = { ...env, counter: 99 };
const tamperResult = await verifyEnvelope(tampered, vault.public_key, {
  purpose: 'INTENT',
  payloadHash: hash,
});
check('editing the counter invalidates the signature', !tamperResult.ok, tamperResult.reason);

// A custody tier cannot be forged on the wire: it is inside the signature.
const lifted = { ...env, device_kind: 'hardware' as const } as unknown as typeof env;
const liftedResult = await verifyEnvelope(lifted, vault.public_key, {
  purpose: 'INTENT',
  payloadHash: hash,
});
check('claiming a stronger custody tier breaks the signature', !liftedResult.ok, liftedResult.reason);

// Counter persistence across "page loads".
const assertion: ApprovalAssertion = {
  v: 1,
  type: 'approval',
  escrow_id: 'ESC-1',
  intent_hash: hash,
  approver_id: 'u_test',
  decision: 'APPROVE',
  at: new Date().toISOString(),
};
const second = await store_.sign(
  'u_test',
  'APPROVAL',
  await approvalHash(assertion),
  'correct horse',
);
check('counter persists and advances to 2', 'counter' in second && second.counter === 2);
check('stored counter matches', store_.load('u_test')!.counter === 2);
check(
  'the approval signature verifies over its own assertion',
  (
    await verifyEnvelope(second, vault.public_key, {
      purpose: 'APPROVAL',
      payloadHash: await approvalHash(assertion),
    })
  ).ok,
);

console.log(
  failures === 0
    ? `
${bold('Device credential code is sound.')}
`
    : `
${red(`${failures} check(s) failed.`)}
`,
);
process.exit(failures === 0 ? 0 : 1);
