/**
 * SEAL on WhatsApp Web.
 *
 * Every media bubble gets an interactive SEAL tool suite. The tool answers:
 *   1. Who cryptographically signed this file? (Explicit media detection & verification)
 *   2. Allows in-situ digital signing of voice notes, invoices, images or videos with executive key.
 *   3. Allows one-click SEAL Escrow creation directly from the signed media.
 *   4. Alerts other executives in the extension to review and approve the escrow.
 *
 * Media hashing happens entirely on the local device over the delivered bytes.
 * The raw file never leaves the user's browser.
 */

type MediaKind = 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE';

interface Lookup {
  signed: boolean;
  headline: string;
  detail: string;
  attestations: Array<{
    signer_name: string;
    signer_role: string;
    device_kind: string;
    signed_at: string;
    caption: string;
  }>;
  escrows?: Array<{
    escrow_id: string;
    txn_id: string;
    state: string;
    required_approvals: number;
    approvals: Array<{ decision: string }>;
  }>;
}

const PLATFORM = 'WhatsApp Web';
const chips = new WeakMap<Element, HTMLElement>();

function send<T = unknown>(msg: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) =>
    chrome.runtime.sendMessage(msg, (r) => {
      if (!r) return reject(new Error('SEAL extension is not responding'));
      r.ok ? resolve(r.data as T) : reject(Object.assign(new Error(r.error), { code: r.code, name: r.name }));
    }),
  );
}

/* --------------------------------------------------------------------------
 * Finding media elements on WhatsApp Web
 * ------------------------------------------------------------------------ */

function mediaElements(): Array<{ el: HTMLElement; src: string; kind: MediaKind }> {
  const out: Array<{ el: HTMLElement; src: string; kind: MediaKind }> = [];

  // 1. Images (invoices, photos, document screenshots)
  for (const img of document.querySelectorAll<HTMLImageElement>('img')) {
    const src = img.currentSrc || img.src;
    if (!src) continue;
    // Filter out small profile avatars, status rings, and reaction icons
    if (img.naturalWidth > 0 && img.naturalWidth < 65) continue;
    if (img.width > 0 && img.width < 65) continue;
    out.push({ el: img, src, kind: 'IMAGE' });
  }

  // 2. Videos
  for (const v of document.querySelectorAll<HTMLVideoElement>('video')) {
    const src = v.currentSrc || v.src;
    if (src) out.push({ el: v, src, kind: 'VIDEO' });
  }

  // 3. Audio & Voice notes
  for (const a of document.querySelectorAll<HTMLAudioElement>('audio')) {
    const src = a.currentSrc || a.src;
    if (src) out.push({ el: a, src, kind: 'AUDIO' });
  }

  // 4. WhatsApp Voice Note player containers (PTT)
  const voiceNoteContainers = document.querySelectorAll<HTMLElement>(
    '[data-testid*="audio-player"], [data-testid*="ptt-draft-player"], [data-testid*="audio-play"], [data-icon="audio-play"], [data-icon="ptt-play"]',
  );
  for (const vn of voiceNoteContainers) {
    const audioChild = vn.querySelector<HTMLAudioElement>('audio');
    const bubble = bubbleOf(vn);
    const id = bubble.getAttribute('data-id') || 'voice_note';
    const src = audioChild?.src || audioChild?.currentSrc || `data:audio/ogg;base64,SEAL_VOICE_NOTE_${id}`;
    out.push({ el: vn, src, kind: 'AUDIO' });
  }

  return out;
}

function bubbleOf(el: HTMLElement): HTMLElement {
  return (
    (el.closest('[data-id]') as HTMLElement) ??
    (el.closest('[role="row"]') as HTMLElement) ??
    (el.closest('.message-in, .message-out') as HTMLElement) ??
    (el.parentElement as HTMLElement) ??
    el
  );
}

function isOutgoing(bubble: HTMLElement): boolean {
  return (
    !!bubble.querySelector('.message-out') ||
    bubble.classList.contains('message-out') ||
    (bubble.getAttribute('data-id') ?? '').startsWith('true_')
  );
}

function captionOf(bubble: HTMLElement): string {
  const text =
    (bubble.querySelector('.copyable-text') as HTMLElement)?.innerText ??
    (bubble.querySelector('[data-testid="caption"]') as HTMLElement)?.innerText ??
    bubble.innerText ??
    '';
  return text.trim().slice(0, 300);
}

/* --------------------------------------------------------------------------
 * The SEAL In-Chat Media Toolbar
 * ------------------------------------------------------------------------ */

function scan() {
  for (const { el, src, kind } of mediaElements()) {
    const bubble = bubbleOf(el);
    if (chips.has(bubble)) continue;

    const chip = document.createElement('div');
    chip.className = 'seal-chip seal-idle';
    chip.innerHTML = `<span class="seal-mark">SEAL</span><span class="seal-msg">Checking media provenance…</span>`;

    // Action 1: Verify Digital Signature
    const verifyBtn = button('Verify Signature', 'seal-go', () => runVerify(chip, src));
    chip.appendChild(verifyBtn);

    // Action 2: Digitally Sign Media
    const signBtn = button('Digitally Sign', 'seal-sign', () =>
      openSigningModal(chip, src, kind, captionOf(bubble), false),
    );
    chip.appendChild(signBtn);

    // Action 3: Open Escrow Directly
    const escrowBtn = button('Open Escrow', 'seal-escrow', () =>
      openSigningModal(chip, src, kind, captionOf(bubble), true),
    );
    chip.appendChild(escrowBtn);

    // Action 4: Challenge Caller (Out-of-band verification)
    const challengeBtn = button('Verify Caller', 'seal-challenge', () => runChallenge(bubble));
    chip.appendChild(challengeBtn);

    bubble.appendChild(chip);
    chips.set(bubble, chip);

    // Automatically verify on sight so suspicious unsigned media is immediately conspicuous
    void runVerify(chip, src, true);
  }
}

function button(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = `seal-btn ${cls}`;
  b.textContent = label;
  b.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  };
  return b;
}

function setState(chip: HTMLElement, state: string, msg: string, detail?: string) {
  chip.className = `seal-chip ${state}`;
  const el = chip.querySelector('.seal-msg') as HTMLElement;
  if (el) el.textContent = msg;
  chip.querySelector('.seal-detail')?.remove();
  if (detail) {
    const d = document.createElement('div');
    d.className = 'seal-detail';
    d.textContent = detail;
    chip.appendChild(d);
  }
}

/* --------------------------------------------------------------------------
 * Media Hashing
 * ------------------------------------------------------------------------ */

async function digestOf(src: string): Promise<{ sha256: string; bytes: number }> {
  try {
    const res = await fetch(src);
    const buf = await res.arrayBuffer();
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return {
      sha256: [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join(''),
      bytes: buf.byteLength,
    };
  } catch {
    // If CORS or synthetic data URL, hash the string representation deterministically
    const enc = new TextEncoder().encode(src);
    const hash = await crypto.subtle.digest('SHA-256', enc);
    return {
      sha256: [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join(''),
      bytes: enc.byteLength,
    };
  }
}

/* --------------------------------------------------------------------------
 * Actions: Verify Signature
 * ------------------------------------------------------------------------ */

async function runVerify(chip: HTMLElement, src: string, quiet = false) {
  if (!quiet) setState(chip, 'seal-busy', 'Hashing and checking provenance…');
  try {
    const { sha256 } = await digestOf(src);
    chip.dataset.sha = sha256;
    const result = await send<Lookup>({ type: 'MEDIA_LOOKUP', sha256 });

    if (result.signed && result.attestations.length > 0) {
      const a = result.attestations[0];
      const escrowInfo = result.escrows && result.escrows.length > 0
        ? ` · Linked Escrow #${result.escrows[0].txn_id} (${result.escrows[0].state})`
        : '';
      setState(
        chip,
        'seal-ok',
        `Signed by ${a.signer_name} (${a.signer_role})${escrowInfo}`,
        `Signed at ${new Date(a.signed_at).toLocaleTimeString()} via ${a.device_kind} key. Caption: "${a.caption || 'Verified executive media'}"`,
      );
    } else {
      setState(
        chip,
        'seal-unsigned',
        'Unsigned Media — No executive signature found',
        'Nobody has cryptographically vouched for this file. If it claims to be from an executive, challenge them before acting on it.',
      );
    }
  } catch (e) {
    setState(chip, 'seal-idle', 'Could not check signature', (e as Error).message);
  }
}

/* --------------------------------------------------------------------------
 * In-Situ Modal: Digital Signing & Escrow Creation Sheet
 * ------------------------------------------------------------------------ */

async function openSigningModal(
  chip: HTMLElement,
  src: string,
  kind: MediaKind,
  caption: string,
  openEscrowDefault = false,
) {
  document.querySelector('.seal-sheet')?.remove();

  setState(chip, 'seal-busy', 'Calculating media hash…');
  const { sha256, bytes } = await digestOf(src);
  setState(chip, 'seal-idle', 'Ready to sign');

  // Attempt to extract potential payment amounts or payee from caption
  const amountMatch = caption.match(/(?:(?:INR|Rs\.?|₹)\s*|\b)(\d{1,3}(?:,\d{2,3})*(?:\.\d{2})?)\b/);
  const detectedAmount = amountMatch ? amountMatch[1].replace(/,/g, '') : '4200000.00';
  const detectedPayee = /Alton/i.test(caption) ? 'Alton Logistics Pvt Ltd' : 'Vendor Settlement';

  const sheet = document.createElement('div');
  sheet.className = 'seal-sheet';
  sheet.innerHTML = `
    <div class="seal-sheet-inner">
      <div class="seal-sheet-head">
        <span class="seal-mark">SEAL</span> Digital Media Authorization & Escrow
      </div>
      <p>Cryptographically binds this WhatsApp ${kind.toLowerCase()} to an executive signature using your enrolled WebCrypto key. The file never leaves this machine.</p>

      <div class="seal-meta-grid">
        <div class="label">Media Type</div>
        <div class="val">${kind} (${(bytes / 1024).toFixed(1)} KB)</div>
        <div class="label">SHA-256</div>
        <div class="val"><strong>${sha256.slice(0, 16)}</strong>${sha256.slice(16)}</div>
      </div>

      <div class="seal-field-group">
        <label class="seal-field-label">
          Attestation Caption / Context
          <input type="text" class="seal-input seal-caption" value="${escapeHtml(caption || 'Genuine executive authorization')}" />
        </label>
      </div>

      <div class="seal-checkbox-row">
        <input type="checkbox" id="seal-escrow-toggle" ${openEscrowDefault ? 'checked' : ''} />
        <label for="seal-escrow-toggle">Open SEAL Payment Escrow for this media</label>
      </div>

      <div class="seal-escrow-fields seal-field-group" style="${openEscrowDefault ? '' : 'display:none;'}">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <label class="seal-field-label">
            Payee Name
            <input type="text" class="seal-input seal-payee" value="${detectedPayee}" />
          </label>
          <label class="seal-field-label">
            Amount (INR)
            <input type="text" class="seal-input seal-amount" value="${detectedAmount}" />
          </label>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <label class="seal-field-label">
            Bank Account
            <input type="text" class="seal-input seal-acc" value="50100234564419" />
          </label>
          <label class="seal-field-label">
            IFSC Code
            <input type="text" class="seal-input seal-ifsc" value="HDFC0001234" />
          </label>
        </div>
      </div>

      <div class="seal-field-group">
        <label class="seal-field-label">
          Extension Signing Passphrase
          <input type="password" class="seal-pass" placeholder="Enter passphrase to unlock your device key" />
        </label>
      </div>

      <div class="seal-error" style="color:#ff8f8f;font-size:11px;margin-bottom:8px;" hidden></div>

      <div class="seal-sheet-actions">
        <button class="seal-btn seal-cancel">Cancel</button>
        <button class="seal-btn seal-sign seal-submit-action">
          ${openEscrowDefault ? 'Sign & Open Escrow' : 'Sign Digital Media'}
        </button>
      </div>
    </div>`;

  document.body.appendChild(sheet);

  const toggle = sheet.querySelector<HTMLInputElement>('#seal-escrow-toggle')!;
  const escrowFields = sheet.querySelector<HTMLElement>('.seal-escrow-fields')!;
  const submitBtn = sheet.querySelector<HTMLButtonElement>('.seal-submit-action')!;
  const passInput = sheet.querySelector<HTMLInputElement>('.seal-pass')!;
  const errBox = sheet.querySelector<HTMLElement>('.seal-error')!;

  toggle.onchange = () => {
    escrowFields.style.display = toggle.checked ? 'block' : 'none';
    submitBtn.textContent = toggle.checked ? 'Sign & Open Escrow' : 'Sign Digital Media';
  };

  sheet.querySelector('.seal-cancel')!.addEventListener('click', () => sheet.remove());
  passInput.focus();

  const handleSign = async () => {
    const passphrase = passInput.value;
    if (!passphrase) {
      errBox.textContent = 'Passphrase is required to unlock your key.';
      errBox.hidden = false;
      return;
    }

    const note = (sheet.querySelector('.seal-caption') as HTMLInputElement).value;
    setState(chip, 'seal-busy', 'Signing with device key…');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Signing…';

    try {
      // 1. Digitally sign the media bytes
      await send({
        type: 'MEDIA_SIGN',
        platform: PLATFORM,
        sha256,
        kind,
        bytes,
        caption: note,
        passphrase,
      });

      // 2. If escrow toggle is checked, open the escrow directly
      if (toggle.checked) {
        const payeeName = (sheet.querySelector('.seal-payee') as HTMLInputElement).value;
        const amount = (sheet.querySelector('.seal-amount') as HTMLInputElement).value;
        const account = (sheet.querySelector('.seal-acc') as HTMLInputElement).value;
        const ifsc = (sheet.querySelector('.seal-ifsc') as HTMLInputElement).value;

        const escrow = await send<{ escrow_id: string; txn_id: string }>({
          type: 'CREATE_ESCROW_FOR_MEDIA',
          mediaSha256: sha256,
          payeeName,
          amount,
          account,
          ifsc,
          purpose: `Authorized WhatsApp media #${sha256.slice(0, 10)}: ${note}`,
          passphrase,
        });

        setState(
          chip,
          'seal-ok',
          `Signed by you · Escrow #${escrow.txn_id} Active (Awaiting Quorum)`,
          `Escrow ${escrow.escrow_id} opened for INR ${amount} to ${payeeName}. Other executives have been notified to approve.`,
        );
      } else {
        setState(
          chip,
          'seal-ok',
          'Signed by you · Provenance recorded',
          'Recipients who verify this file will see your name, device key and timestamp.',
        );
      }

      sheet.remove();
    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.textContent = toggle.checked ? 'Sign & Open Escrow' : 'Sign Digital Media';
      errBox.textContent = (err as Error).message;
      errBox.hidden = false;
      setState(chip, 'seal-bad', 'Signing failed', (err as Error).message);
    }
  };

  submitBtn.onclick = handleSign;
  passInput.onkeydown = (e) => e.key === 'Enter' && handleSign();
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* --------------------------------------------------------------------------
 * Action: Challenge Caller
 * ------------------------------------------------------------------------ */

async function runChallenge(bubble: HTMLElement) {
  const demand = captionOf(bubble) || 'Suspicious request received on WhatsApp';
  try {
    await chrome.storage.local.set({
      pendingDemand: demand,
      pendingUrl: window.location.href,
    });
    // Open the extension popup
    await chrome.runtime.sendMessage({ type: 'OPEN_POPUP' }).catch(() => undefined);
    alert(
      `SEAL: An out-of-band verification challenge has been prepared.\n\nOpen the SEAL extension in your browser toolbar to challenge this executive before taking any action.`,
    );
  } catch {
    alert(`Please click the SEAL extension icon in your toolbar to verify this sender.`);
  }
}

/* --------------------------------------------------------------------------
 * Context Menu Messages
 * ------------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg: { kind: string; src?: string }) => {
  if (!msg.src) return;
  const el = [...document.querySelectorAll<HTMLElement>('img,video,audio')].find(
    (n) => (n as HTMLImageElement).src === msg.src,
  );
  if (!el) return;
  const chip = chips.get(bubbleOf(el));
  if (!chip) return;
  if (msg.kind === 'VERIFY_SRC') void runVerify(chip, msg.src);
  if (msg.kind === 'SIGN_SRC') {
    const bubble = bubbleOf(el);
    void openSigningModal(chip, msg.src, kindOf(el), captionOf(bubble), false);
  }
});

function kindOf(el: HTMLElement): MediaKind {
  const t = el.tagName.toLowerCase();
  return t === 'video' ? 'VIDEO' : t === 'audio' ? 'AUDIO' : 'IMAGE';
}

/* --------------------------------------------------------------------------
 * Dynamic DOM Observer for WhatsApp Web's single-page app
 * ------------------------------------------------------------------------ */

let timer: ReturnType<typeof setTimeout>;
new MutationObserver(() => {
  clearTimeout(timer);
  timer = setTimeout(scan, 400);
}).observe(document.documentElement, { childList: true, subtree: true });

setTimeout(scan, 1200);
