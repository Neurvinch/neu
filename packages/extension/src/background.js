/**
 * SEAL browser extension — background service worker.
 *
 * What this extension is: a client for the authorization ledger, placed where
 * the attack actually arrives. WhatsApp Web, a mail tab, a meeting window.
 *
 * What it is emphatically NOT: a deepfake detector. It never scores a face or a
 * voice, because the problem statement is right that such scores fail against
 * new generators, noisy audio and short clips — and because a control whose
 * safety depends on a classifier inherits every one of those failure modes.
 *
 * It answers three questions instead, and all three have crisp answers:
 *
 *   "Is this payment actually authorized?"  -> ask the ledger
 *   "Is this really the CFO?"               -> challenge the caller's device
 *   "Can we prove this arrived?"            -> hash it into the audit chain
 */

const DEFAULTS = { sealUrl: 'http://localhost:4000', token: null, userId: null, userName: null };

export async function config() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

async function api(path, { method, body } = {}) {
  const { sealUrl, token } = await config();
  const res = await fetch(`${sealUrl}${path}`, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(data?.message ?? data?.error ?? res.statusText);
    err.code = data?.error ?? String(res.status);
    throw err;
  }
  return data;
}

/* --------------------------------------------------------------------------
 * Context menus -- the extension has to be reachable in one gesture, because
 * the person using it is being hurried by someone on a call.
 * ------------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'seal-check',
      title: 'SEAL: is this payment actually authorized?',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: 'seal-challenge',
      title: 'SEAL: challenge whoever sent this',
      contexts: ['selection', 'page'],
    });
    chrome.contextMenus.create({
      id: 'seal-evidence',
      title: 'SEAL: capture this as evidence',
      contexts: ['selection', 'audio', 'video', 'image'],
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const platform = platformOf(tab?.url ?? '');

  if (info.menuItemId === 'seal-check') {
    const txn = findTxnId(info.selectionText ?? '');
    const result = txn
      ? await api(`/api/claims/lookup?txn_id=${encodeURIComponent(txn)}`).catch((e) => ({
          verdict: 'ERROR',
          headline: e.message,
        }))
      : {
          verdict: 'NO_REFERENCE',
          headline: 'No transaction reference in that text.',
          detail:
            'A genuine payment always has one. Text that asks for money without one is asking you to act on trust alone.',
        };
    await notify(result.headline, result.detail ?? '');
    await tellTab(tab, { kind: 'result', result, selection: info.selectionText ?? '' });
    return;
  }

  if (info.menuItemId === 'seal-evidence') {
    await tellTab(tab, {
      kind: 'capture',
      platform,
      url: tab?.url,
      mediaUrl: info.srcUrl ?? null,
      selection: info.selectionText ?? '',
    });
    return;
  }

  if (info.menuItemId === 'seal-challenge') {
    await chrome.storage.local.set({
      pendingDemand: (info.selectionText ?? '').slice(0, 300),
      pendingPlatform: platform,
      pendingUrl: tab?.url ?? null,
    });
    await chrome.action.openPopup().catch(() => notify('Open the SEAL extension to continue', ''));
  }
});

/* --------------------------------------------------------------------------
 * Messages from the content script and the popup
 * ------------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: e.message, code: e.code }));
  return true;
});

async function handle(msg, sender) {
  switch (msg.type) {
    case 'CONFIG':
      return config();

    case 'SIGN_IN': {
      const out = await api('/api/session', {
        body: { user_id: msg.userId, password: msg.password },
      });
      await chrome.storage.local.set({
        token: out.token,
        userId: out.user.id,
        userName: out.user.name,
        userRole: out.user.role,
      });
      return out.user;
    }

    case 'SIGN_OUT':
      await chrome.storage.local.set({ token: null, userId: null, userName: null });
      return true;

    case 'USERS':
      return api('/api/users');

    case 'POLICY':
      return api('/api/policy');

    case 'LOOKUP':
      return api(`/api/claims/lookup?txn_id=${encodeURIComponent(msg.txnId)}`);

    case 'CHALLENGE':
      return api('/api/caller-challenges', {
        body: {
          claimed_user_id: msg.claimedUserId,
          channel: msg.channel,
          demand: msg.demand,
          source: msg.source ?? null,
        },
      });

    case 'CHALLENGE_STATE':
      return api(`/api/caller-challenges/${msg.id}`);

    case 'EVIDENCE':
      return api('/api/evidence', { body: msg.evidence });

    /**
     * Media is hashed here, in the browser, and only the digest is sent. The
     * ledger gets something that proves later that the clip an investigator
     * holds is the clip that arrived -- without this system becoming a store of
     * everybody's private messages.
     */
    case 'HASH_MEDIA': {
      const res = await fetch(msg.url);
      const buf = await res.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', buf);
      return {
        sha256: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join(''),
        bytes: buf.byteLength,
      };
    }

    case 'NOTIFY':
      return notify(msg.title, msg.message);

    default:
      throw new Error(`unknown message ${msg.type}`);
  }
}

/* --------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------ */

export function findTxnId(text) {
  const m = /\bTX-[A-Z0-9]{4,12}\b/i.exec(text ?? '');
  return m ? m[0].toUpperCase() : null;
}

export function platformOf(url) {
  if (!url) return 'unknown';
  if (url.includes('web.whatsapp.com')) return 'WhatsApp Web';
  if (url.includes('mail.google.com')) return 'Gmail';
  if (url.includes('outlook.')) return 'Outlook';
  if (url.includes('teams.microsoft.com')) return 'Microsoft Teams';
  if (url.includes('slack.com')) return 'Slack';
  if (url.includes('web.telegram.org')) return 'Telegram';
  if (url.includes('meet.google.com')) return 'Google Meet';
  if (url.includes('zoom.us')) return 'Zoom';
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown';
  }
}

async function notify(title, message) {
  try {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: title.slice(0, 100),
      message: (message ?? '').slice(0, 300),
    });
  } catch {
    /* notifications are a nicety, never a dependency */
  }
}

async function tellTab(tab, payload) {
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, payload);
  } catch {
    /* no content script on this page */
  }
}
