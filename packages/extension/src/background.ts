import { canonicalize, sha256Hex, utf8 } from '@seal/shared';
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

    /* --- the key --------------------------------------------------------- */

    case 'CREATE_KEY': {
      const cfg = await config();
      if (!cfg.userId) throw new Error('Sign in first.');
      const vault = await createVault({
        userId: cfg.userId,
        passphrase: String(msg.passphrase),
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
        passphrase: String(msg.passphrase),
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

    case 'DESTROY_KEY':
      await forgetVault();
      return true;

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
        passphrase: msg.passphrase ? String(msg.passphrase) : undefined,
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
        passphrase: String(msg.passphrase),
      });
      return fulfilSigningRequest(request.id, signature);
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
        passphrase: String(msg.passphrase),
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
    const [requests, challenges] = await Promise.all([listSigningRequests(), listChallenges()]);
    const waiting =
      requests.filter((r) => r.state === 'PENDING' && r.subject_user_id === cfg.userId).length +
      challenges.filter((c) => c.state === 'PENDING' && c.claimed_user_id === cfg.userId).length;
    await chrome.action.setBadgeBackgroundColor({ color: '#ff6b6b' });
    await chrome.action.setBadgeText({ text: waiting > 0 ? String(waiting) : '' });
  } catch {
    /* the server may simply not be running */
  }
}

chrome.alarms.create('seal-poll', { periodInMinutes: 0.25 });
chrome.alarms.onAlarm.addListener((a) => a.name === 'seal-poll' && refreshBadge());
refreshBadge();
