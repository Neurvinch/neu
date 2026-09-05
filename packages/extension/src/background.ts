import { buildIntent, canonicalize, sha256Hex, utf8 } from '@seal/shared';
import type { MediaKind, SignaturePurpose } from '@seal/shared';
import {
  api,
  challengeAttestation,
  config,
  confirmChallenge,
  declineSigningRequest,
  denyChallenge,
  fulfilSigningRequest,
  listChallenges,
  listEscrows,
  listSigningRequests,
  lookupMedia,
  mediaAttestationFor,
  raiseChallenge,
  requestApproval,
  requestIntentSignature,
  submitMediaSignature,
} from './lib/api.js';
import {
  createVault,
  forgetVault,
  loadVault,
  lock,
  signWithVault,
  unlockedUntil,
} from './lib/vault.js';

/**
 * The service worker: the extension's only key holder and its only signer.
 *
 * Content scripts run inside the page's world, so they never touch key
 * material. They hash bytes and ask. Everything that requires the private key
 * happens here, behind chrome.storage, out of reach of whatever WhatsApp Web
 * happens to be running.
 */

const hashOf = async (value: unknown) => sha256Hex(utf8(canonicalize(value)));

/**
 * A missing passphrase must stay missing.
 *
 * String(undefined) is "undefined" -- a non-empty string that sails past every
 * truthiness check and then simply fails to decrypt. That turns "you forgot the
 * passphrase" into "wrong passphrase", and makes the rule that money always
 * re-asks depend on a decrypt failure instead of an explicit gate.
 */
function passphraseOf(msg: { [k: string]: unknown }): string | undefined {
  return typeof msg.passphrase === 'string' && msg.passphrase.length > 0
    ? msg.passphrase
    : undefined;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'seal-verify-media',
      title: 'SEAL: who signed this file?',
      contexts: ['image', 'video', 'audio'],
    });
    chrome.contextMenus.create({
      id: 'seal-sign-media',
      title: 'SEAL: sign this file as mine',
      contexts: ['image', 'video', 'audio'],
    });
    chrome.contextMenus.create({
      id: 'seal-challenge',
      title: 'SEAL: verify who is contacting me',
      contexts: ['page', 'selection'],
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === 'seal-verify-media') {
    send(tab.id, { kind: 'VERIFY_SRC', src: info.srcUrl });
  }
  if (info.menuItemId === 'seal-sign-media') {
    send(tab.id, { kind: 'SIGN_SRC', src: info.srcUrl });
  }
  if (info.menuItemId === 'seal-challenge') {
    await chrome.storage.local.set({
      pendingDemand: (info.selectionText ?? '').slice(0, 300),
      pendingUrl: tab.url ?? null,
    });
    await chrome.action.openPopup().catch(() => undefined);
  }
});

function send(tabId: number, msg: unknown) {
  chrome.tabs.sendMessage(tabId, msg).catch(() => undefined);
}

/* --------------------------------------------------------------------------
 * Message router
 * ------------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e: Error) =>
      sendResponse({ ok: false, error: e.message, code: (e as { code?: string }).code, name: e.name }),
    );
  return true;
});

async function handle(msg: { type: string; [k: string]: unknown }): Promise<unknown> {
  switch (msg.type) {
    /* --- identity -------------------------------------------------------- */

    case 'STATE': {
      const cfg = await config();
      const vault = await loadVault();
      return {
        sealUrl: cfg.sealUrl,
        signedIn: !!cfg.token,
        userId: cfg.userId ?? null,
        userName: cfg.userName ?? null,
        userRole: cfg.userRole ?? null,
        hasKey: !!vault,
        credentialId: vault?.credential_id ?? null,
        publicKey: vault?.public_key ?? null,
        counter: vault?.counter ?? 0,
        unlockedUntil: unlockedUntil(),
      };
    }

    case 'USERS':
      return api('/api/users');

    case 'POLICY':
      return api('/api/policy');

    case 'ME':
      return api('/api/me');

    case 'SIGN_IN': {
      const out = await api<{ token: string; user: { id: string; name: string; role: string } }>(
        '/api/session',
        { body: { user_id: msg.userId, password: msg.password } },
      );
      await chrome.storage.local.set({
        token: out.token,
        userId: out.user.id,
        userName: out.user.name,
        userRole: out.user.role,
      });
      return out.user;
    }

    case 'SIGN_OUT':
      lock();
      await chrome.storage.local.set({ token: null, userId: null, userName: null, userRole: null });
      return true;

    case 'SET_URL':
      await chrome.storage.local.set({ sealUrl: String(msg.url).replace(/\/$/, '') });
      return true;

    case 'LOCK':
      lock();
      return true;

    /**
     * A content script cannot open the popup itself -- chrome.action is only
     * available to the worker, and even here Chrome only allows it while a user
     * gesture is still in flight. Failing softly is correct: the chat bubble
     * has already stashed the demand and told the person to click the toolbar
     * icon, so a refusal costs nothing.
     */
    case 'OPEN_POPUP':
      await chrome.action.openPopup().catch(() => undefined);
      return true;

    /* --- the key --------------------------------------------------------- */

    case 'CREATE_KEY': {
      const cfg = await config();
      if (!cfg.userId) throw new Error('Sign in first.');
      const passphrase = passphraseOf(msg);
      if (!passphrase) throw new Error('Choose a passphrase for this key.');
      const vault = await createVault({
        userId: cfg.userId,
        passphrase,
        label: String(msg.label ?? 'Browser extension'),
      });

      // Prove possession to the server, then wait for the quorum to admit it.
      const begun = await api<{ challenge: string }>('/api/credentials/enroll/begin', {
        body: { device_kind: 'extension' },
      });
      const payload = {
        v: 1,
        type: 'enrollment',
        user_id: cfg.userId,
        public_key: vault.public_key,
        challenge: begun.challenge,
      };
      const proof = await signWithVault({
        purpose: 'ENROLLMENT',
        payloadHash: await hashOf(payload),
        passphrase,
      });
      return api('/api/credentials/enroll/finish', {
        body: {
          device_kind: 'extension',
          public_key: vault.public_key,
          label: vault.label,
          proof,
        },
      });
    }

    /**
     * Retire the key, server-side first.
     *
     * Wiping only local storage leaves the server still trusting the
     * credential: it stays usable in principle, and it keeps blocking
     * re-registration of the same authenticator. Local material is cleared only
     * after the server confirms the credential is retired.
     */
    case 'DESTROY_KEY': {
      const vault = await loadVault();
      if (vault) {
        await api(`/api/credentials/${vault.credential_id}/revoke`, {
          body: { reason: 'Retired from the browser extension' },
        });
      }
      await forgetVault();
      return true;
    }

    /* --- media ----------------------------------------------------------- */

    case 'MEDIA_LOOKUP':
      return lookupMedia(String(msg.sha256));

    case 'MEDIA_SIGN': {
      const attestation = await mediaAttestationFor({
        sha256: String(msg.sha256),
        kind: msg.kind as MediaKind,
        bytes: Number(msg.bytes ?? 0),
        platform: String(msg.platform ?? 'unknown'),
        caption: String(msg.caption ?? ''),
      });
      const signature = await signWithVault({
        purpose: 'MEDIA',
        payloadHash: await hashOf(attestation),
        passphrase: passphraseOf(msg),
        remember: true,
      });
      return submitMediaSignature(attestation, signature);
    }

    /* --- payments -------------------------------------------------------- */

    case 'ESCROWS':
      return listEscrows();

    case 'CREATE_INTENT':
      return requestIntentSignature(msg.intent as never);

    case 'REQUEST_APPROVAL':
      return requestApproval(String(msg.escrowId), msg.decision as 'APPROVE' | 'REJECT');

    case 'SIGNING_REQUESTS':
      return listSigningRequests();

    /**
     * Money always costs a fresh passphrase. The media unlock window explicitly
     * does not apply here -- see the comment in lib/vault.ts.
     */
    case 'FULFIL': {
      const request = (await listSigningRequests()).find((r) => r.id === msg.id);
      if (!request) throw new Error('That request is no longer pending.');
      const signature = await signWithVault({
        purpose: request.purpose as SignaturePurpose,
        payloadHash: request.payload_hash,
        passphrase: passphraseOf(msg),
      });
      return fulfilSigningRequest(request.id, signature);
    }

    case 'CREATE_ESCROW_FOR_MEDIA': {
      const cfg = await config();
      if (!cfg.userId || !cfg.userRole) throw new Error('Sign in first.');
      const policy = await api<{ org_id: string }>('/api/policy');
      const mediaSha = String(msg.mediaSha256 || '');
      const payeeName = String(msg.payeeName || 'Vendor');
      const account = String(msg.account || '50100234564419');
      const ifsc = String(msg.ifsc || 'HDFC0001234').toUpperCase();
      const amount = String(msg.amount || '4200000.00');
      const purpose = String(msg.purpose || (mediaSha ? `Media #${mediaSha.slice(0, 10)} settlement` : 'Vendor settlement'));

      const intent = buildIntent({
        org_id: policy.org_id,
        type: 'wire_transfer',
        payee: { name: payeeName, account, ifsc },
        amount: { value: amount, currency: 'INR' },
        purpose,
        deadline: new Date(Date.now() + 48 * 3600_000).toISOString(),
        originator: { user_id: cfg.userId, role: cfg.userRole as 'CFO' },
        // Signed, so an approver can be shown the exact file this came from.
        media_sha256: /^[0-9a-f]{64}$/.test(mediaSha) ? mediaSha : undefined,
      });

      const req = await requestIntentSignature(intent);
      const signature = await signWithVault({
        purpose: 'INTENT',
        payloadHash: req.payload_hash,
        passphrase: passphraseOf(msg),
      });
      await fulfilSigningRequest(req.id, signature);

      const escrow = await api<import('@seal/shared').EscrowView>(`/api/intents/${intent.txn_id}/accept`, {
        method: 'POST',
      });
      void refreshBadge();
      return escrow;
    }

    case 'APPROVE_ESCROW_DIRECT': {
      const escrowId = String(msg.escrowId);
      const decision = (msg.decision as 'APPROVE' | 'REJECT') ?? 'APPROVE';
      const req = await requestApproval(escrowId, decision);
      const signature = await signWithVault({
        purpose: req.purpose as SignaturePurpose,
        payloadHash: req.payload_hash,
        passphrase: passphraseOf(msg),
      });
      const fulfilled = await fulfilSigningRequest(req.id, signature);
      void refreshBadge();
      return fulfilled;
    }

    case 'DECLINE':
      return declineSigningRequest(String(msg.id), String(msg.reason ?? 'Declined in the extension'));

    /* --- caller challenges ------------------------------------------------ */

    case 'CHALLENGES':
      return listChallenges();

    case 'RAISE_CHALLENGE':
      return raiseChallenge({
        claimed_user_id: String(msg.claimedUserId),
        channel: String(msg.channel),
        demand: String(msg.demand),
        source: msg.source ?? null,
      });

    case 'DENY_CHALLENGE':
      return denyChallenge(String(msg.id));

    case 'CONFIRM_CHALLENGE': {
      const attestation = await challengeAttestation(String(msg.id));
      const signature = await signWithVault({
        purpose: 'ATTESTATION',
        payloadHash: await hashOf(attestation),
        passphrase: passphraseOf(msg),
      });
      return confirmChallenge(String(msg.id), signature);
    }

    default:
      throw new Error(`unknown message ${msg.type}`);
  }
}

/* --------------------------------------------------------------------------
 * Badge: how many things are waiting for this person
 * ------------------------------------------------------------------------ */

async function refreshBadge() {
  try {
    const cfg = await config();
    if (!cfg.token) return chrome.action.setBadgeText({ text: '' });
    const [requests, challenges, escrows] = await Promise.all([
      listSigningRequests().catch(() => []),
      listChallenges().catch(() => []),
      listEscrows().catch(() => []),
    ]);

    const myPendingEscrows = escrows.filter(
      (e) =>
        e.state === 'PENDING_QUORUM' &&
        ['CEO', 'CTO', 'TREASURY', 'CFO'].includes(cfg.userRole ?? '') &&
        e.opened_by !== cfg.userId &&
        e.intent.originator.user_id !== cfg.userId &&
        !e.approvals.some((a) => a.approver_id === cfg.userId),
    );

    const waiting =
      requests.filter((r) => r.state === 'PENDING' && r.subject_user_id === cfg.userId).length +
      challenges.filter((c) => c.state === 'PENDING' && c.claimed_user_id === cfg.userId).length +
      myPendingEscrows.length;

    await chrome.action.setBadgeBackgroundColor({ color: '#ff4d4f' });
    await chrome.action.setBadgeText({ text: waiting > 0 ? String(waiting) : '' });

    if (myPendingEscrows.length > 0 && chrome.notifications?.create) {
      const topEscrow = myPendingEscrows[0];
      const notifyKey = `notified_esc_${topEscrow.escrow_id}`;
      const memory = await chrome.storage.local.get([notifyKey]);
      if (!memory[notifyKey]) {
        await chrome.storage.local.set({ [notifyKey]: true });
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: 'SEAL: Payment Escrow Awaiting Approval',
          message: `${topEscrow.txn_id}: ${topEscrow.intent.amount.currency} ${topEscrow.intent.amount.value} to ${topEscrow.intent.payee.name}. Click extension to approve.`,
          priority: 2,
        });
      }
    }
  } catch {
    /* the server may simply not be running */
  }
}

chrome.alarms.create('seal-poll', { periodInMinutes: 0.25 });
chrome.alarms.onAlarm.addListener((a) => a.name === 'seal-poll' && refreshBadge());
refreshBadge();
