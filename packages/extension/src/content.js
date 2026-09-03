/**
 * SEAL content script.
 *
 * Injected into the places a payment demand actually arrives. It does one thing
 * and does it honestly:
 *
 * It looks for *payment-instruction language* -- not for deepfakes. Spotting
 * the phrase "wire it today" and an IFSC code next to a rupee figure is a
 * reliable, boring text match. Spotting a synthetic face is not, and any badge
 * claiming to have done so would be lying to the person reading it.
 *
 * So the badge never says "this looks fake". It says: money is being discussed
 * in a channel that carries no authority, and here is the one-click way to find
 * out what the ledger actually says.
 */

const PATTERNS = [
  /\bIFSC\b/i,
  /\b[A-Z]{4}0[A-Z0-9]{6}\b/,
  /\b(?:wire|transfer|remit|settle|payment|invoice|beneficiary|account\s*(?:no|number))\b/i,
  /(?:₹|\bINR\b|\brs\.?\b)\s*[\d,]{4,}/i,
  /\b\d{2,3}\s*(?:lakh|lakhs|crore|cr)\b/i,
];

const URGENCY = /\b(urgent|immediately|right now|before .{0,20}(close|eod)|asap|don't tell|do not tell|keep this (?:quiet|confidential)|between us)\b/i;

/** Two independent signals before we say anything. One is too noisy. */
function looksLikePaymentInstruction(text) {
  if (!text || text.length < 25 || text.length > 4000) return false;
  const hits = PATTERNS.filter((re) => re.test(text)).length;
  return hits >= 2;
}

function findTxnId(text) {
  const m = /\bTX-[A-Z0-9]{4,12}\b/i.exec(text ?? '');
  return m ? m[0].toUpperCase() : null;
}

const seen = new WeakSet();

function scan() {
  // Message-shaped containers across the supported apps. Deliberately loose:
  // a missed badge costs nothing, and a wrong one is only a prompt to check.
  const candidates = document.querySelectorAll(
    '[data-testid="msg-container"], [role="row"], [role="listitem"], .message-in, .message-out, [data-message-id]',
  );

  for (const el of candidates) {
    if (seen.has(el)) continue;
    const text = (el.innerText ?? '').trim();
    if (!looksLikePaymentInstruction(text)) continue;
    seen.add(el);
    attach(el, text);
  }
}

function attach(el, text) {
  const bar = document.createElement('div');
  bar.className = 'seal-badge';

  const urgent = URGENCY.test(text);
  const txn = findTxnId(text);

  bar.innerHTML = `
    <span class="seal-mark">SEAL</span>
    <span class="seal-text">
      ${
        urgent
          ? 'Payment instructions <b>plus urgency</b> — the exact shape of this attack.'
          : 'Payment instructions in a channel with no signing authority.'
      }
    </span>
  `;

  const check = document.createElement('button');
  check.className = 'seal-btn';
  check.textContent = txn ? `Check ${txn}` : 'Check the ledger';
  check.onclick = (e) => {
    e.stopPropagation();
    if (txn) {
      send({ type: 'LOOKUP', txnId: txn }).then((r) => render(bar, r));
    } else {
      render(bar, {
        verdict: 'NO_REFERENCE',
        headline: 'No transaction reference here.',
        detail:
          'A genuine payment has one. A message asking for money without one is asking you to act on trust alone.',
      });
    }
  };

  const challenge = document.createElement('button');
  challenge.className = 'seal-btn seal-danger';
  challenge.textContent = 'Verify the sender';
  challenge.onclick = (e) => {
    e.stopPropagation();
    chrome.storage.local.set({
      pendingDemand: text.slice(0, 300),
      pendingPlatform: location.hostname,
      pendingUrl: location.href,
    });
    send({
      type: 'NOTIFY',
      title: 'Open the SEAL extension',
      message: 'Pick who this person claims to be, and challenge them.',
    });
  };

  bar.append(check, challenge);
  el.appendChild(bar);
}

function render(bar, result) {
  const old = bar.querySelector('.seal-result');
  if (old) old.remove();

  const box = document.createElement('div');
  const good = result.verdict === 'EXECUTED' || result.authorized;
  box.className = `seal-result ${good ? 'seal-ok' : 'seal-bad'}`;
  box.innerHTML = `
    <div class="seal-headline">${escapeHtml(result.headline ?? '')}</div>
    ${result.detail ? `<div class="seal-detail">${escapeHtml(result.detail)}</div>` : ''}
    ${
      result.payee
        ? `<div class="seal-detail"><b>Ledger says:</b> ${escapeHtml(result.payee.name)} · ${escapeHtml(
            result.payee.account,
          )} · ${escapeHtml(result.amount?.value ?? '')}</div>`
        : ''
    }
  `;
  bar.appendChild(box);
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (r) => resolve(r?.ok ? r.data : { headline: r?.error ?? 'error' }));
  });
}

/* --------------------------------------------------------------------------
 * Messages from the background worker
 * ------------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.kind === 'result') {
    banner(msg.result.headline, msg.result.detail ?? '', msg.result.authorized);
  }

  if (msg.kind === 'capture') {
    let media = null;
    if (msg.mediaUrl) {
      const r = await send({ type: 'HASH_MEDIA', url: msg.mediaUrl });
      if (r?.sha256) media = r;
    }
    const out = await send({
      type: 'EVIDENCE',
      evidence: {
        platform: msg.platform,
        url: msg.url,
        kind: msg.mediaUrl ? guessKind(msg.mediaUrl) : 'TEXT',
        excerpt: msg.selection ?? '',
        media_sha256: media?.sha256 ?? null,
        media_bytes: media?.bytes ?? null,
      },
    });
    banner(
      out?.seq ? `Captured as evidence #${out.seq}` : 'Could not capture',
      media
        ? `Hashed locally (${media.sha256.slice(0, 16)}…) and chained. The file itself never left this machine.`
        : 'Chained into the audit log with its channel context.',
      true,
    );
  }
});

function guessKind(url) {
  if (/\.(mp4|webm|mov|m4v)(\?|$)/i.test(url)) return 'VIDEO';
  if (/\.(mp3|ogg|opus|wav|m4a)(\?|$)/i.test(url)) return 'AUDIO';
  if (/\.(png|jpe?g|gif|webp)(\?|$)/i.test(url)) return 'IMAGE';
  return 'FILE';
}

function banner(title, detail, good) {
  document.querySelector('.seal-toast')?.remove();
  const el = document.createElement('div');
  el.className = `seal-toast ${good ? 'seal-ok' : 'seal-bad'}`;
  el.innerHTML = `<div class="seal-headline">${escapeHtml(title)}</div><div class="seal-detail">${escapeHtml(
    detail,
  )}</div>`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 9000);
}

/* --------------------------------------------------------------------------
 * Boot
 * ------------------------------------------------------------------------ */

const observer = new MutationObserver(() => {
  clearTimeout(observer._t);
  observer._t = setTimeout(scan, 400);
});

observer.observe(document.documentElement, { childList: true, subtree: true });
setTimeout(scan, 1200);
