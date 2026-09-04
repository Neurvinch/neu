/**
 * SEAL on WhatsApp Web.
 *
 * Every media bubble gets a chip. The chip answers one question — *who signed
 * this file?* — and offers to add your own signature to something you sent.
 *
 * It never guesses whether a clip is synthetic. It reports provenance, and the
 * wording of the negative case is chosen carefully: **unsigned**, never "fake".
 * Absence of a signature means nobody has vouched for the file, which is a
 * different and much more defensible claim.
 *
 * Two implementation notes that matter more than they look:
 *
 *   1. Hashing happens *here*, on the delivered bytes, in the page that already
 *      has them. The file never goes to the server — only its digest does.
 *   2. Because WhatsApp re-encodes media on upload, the signature has to be
 *      over what was *delivered*, not what was picked from disk. So the sender
 *      posts first and signs the bubble afterwards. That is why the sign action
 *      lives on the message rather than on the composer.
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
 * Finding media
 * ------------------------------------------------------------------------ */

/**
 * WhatsApp's DOM is minified and changes often, so this deliberately matches on
 * media elements rather than on class names, and walks up to the nearest
 * message container. A missed bubble costs nothing; a wrong one shows a chip in
 * a slightly odd place.
 */
function mediaElements(): Array<{ el: HTMLElement; src: string; kind: MediaKind }> {
  const out: Array<{ el: HTMLElement; src: string; kind: MediaKind }> = [];

  for (const img of document.querySelectorAll<HTMLImageElement>('img[src^="blob:"]')) {
    // Thumbnails and avatars are not the point; only reasonably sized media.
    if (img.naturalWidth > 0 && img.naturalWidth < 90) continue;
    out.push({ el: img, src: img.src, kind: 'IMAGE' });
  }
  for (const v of document.querySelectorAll<HTMLVideoElement>('video[src^="blob:"]')) {
    out.push({ el: v, src: v.src, kind: 'VIDEO' });
  }
  for (const a of document.querySelectorAll<HTMLAudioElement>('audio[src^="blob:"]')) {
    out.push({ el: a, src: a.src, kind: 'AUDIO' });
  }
  return out;
}

function bubbleOf(el: HTMLElement): HTMLElement {
  return (
    (el.closest('[data-id]') as HTMLElement) ??
    (el.closest('[role="row"]') as HTMLElement) ??
    (el.parentElement as HTMLElement) ??
    el
  );
}

/** Outgoing bubbles carry message-out; only your own files are yours to sign. */
function isOutgoing(bubble: HTMLElement): boolean {
  return (
    !!bubble.querySelector('.message-out') ||
    bubble.classList.contains('message-out') ||
    (bubble.getAttribute('data-id') ?? '').startsWith('true_')
  );
}

function captionOf(bubble: HTMLElement): string {
  const text = (bubble.querySelector('.copyable-text') as HTMLElement)?.innerText ?? '';
  return text.trim().slice(0, 200);
}

/* --------------------------------------------------------------------------
 * The chip
 * ------------------------------------------------------------------------ */

function scan() {
  for (const { el, src, kind } of mediaElements()) {
    const bubble = bubbleOf(el);
    if (chips.has(bubble)) continue;
    const chip = document.createElement('div');
    chip.className = 'seal-chip seal-idle';
    chip.innerHTML = `<span class="seal-mark">SEAL</span><span class="seal-msg">unchecked</span>`;

    const verify = button('Verify', 'seal-go', () => runVerify(chip, src));
    chip.appendChild(verify);

    if (isOutgoing(bubble)) {
      chip.appendChild(
        button('Sign as mine', 'seal-sign', () => runSign(chip, src, kind, captionOf(bubble))),
      );
    }

    bubble.appendChild(chip);
    chips.set(bubble, chip);

    // Verify on sight. The whole value is that an unsigned "message from the
    // CFO" is conspicuous *before* anybody acts on it, not after they thought
    // to check.
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
 * Hashing
 * ------------------------------------------------------------------------ */

/**
 * The delivered bytes, hashed in the page that already holds them. WhatsApp
 * serves media as blob: URLs on its own origin, so this fetch never touches the
 * network and the file never leaves the machine.
 */
async function digestOf(src: string): Promise<{ sha256: string; bytes: number }> {
  const res = await fetch(src);
  const buf = await res.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return {
    sha256: [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join(''),
    bytes: buf.byteLength,
  };
}

/* --------------------------------------------------------------------------
 * Actions
 * ------------------------------------------------------------------------ */

async function runVerify(chip: HTMLElement, src: string, quiet = false) {
  if (!quiet) setState(chip, 'seal-busy', 'checking…');
  try {
    const { sha256 } = await digestOf(src);
    chip.dataset.sha = sha256;
    const result = await send<Lookup>({ type: 'MEDIA_LOOKUP', sha256 });

    if (result.signed) {
      const a = result.attestations[0];
      setState(
        chip,
        'seal-ok',
        `signed by ${a.signer_name} · ${a.signer_role}`,
        `${new Date(a.signed_at).toLocaleString()} · ${a.device_kind} key. Provenance, not proof the contents are true.`,
      );
    } else {
      setState(
        chip,
        'seal-unsigned',
        'unsigned — nobody has vouched for this file',
        'Not proof it is fake. It means nothing verifies where it came from. If it claims to be from an executive, challenge them before acting.',
      );
    }
  } catch (e) {
    setState(chip, 'seal-idle', 'could not check', (e as Error).message);
  }
}

async function runSign(chip: HTMLElement, src: string, kind: MediaKind, caption: string) {
  setState(chip, 'seal-busy', 'signing…');
  try {
    const { sha256, bytes } = await digestOf(src);
    await signOnce({ sha256, kind, bytes, caption });
    setState(chip, 'seal-ok', 'signed by you', 'Recipients who verify this file will now see your name against it.');
  } catch (e) {
    const err = e as Error;
    if (err.name === 'PassphraseRequired' || /PASSPHRASE_REQUIRED/.test(err.message)) {
      promptPassphrase(async (passphrase) => {
        setState(chip, 'seal-busy', 'signing…');
        try {
          const { sha256, kind: k, bytes } = { ...(await digestOf(src)), kind };
          await signOnce({ sha256, kind: k, bytes, caption, passphrase });
          setState(chip, 'seal-ok', 'signed by you', 'Recipients who verify this file will now see your name against it.');
        } catch (e2) {
          setState(chip, 'seal-bad', 'could not sign', (e2 as Error).message);
        }
      });
      setState(chip, 'seal-idle', 'passphrase needed');
      return;
    }
    setState(chip, 'seal-bad', 'could not sign', err.message);
  }
}

function signOnce(input: {
  sha256: string;
  kind: MediaKind;
  bytes: number;
  caption: string;
  passphrase?: string;
}) {
  return send({ type: 'MEDIA_SIGN', platform: PLATFORM, ...input });
}

/* --------------------------------------------------------------------------
 * Passphrase prompt
 *
 * Rendered by the extension, in the page, but visually unmistakable as *not*
 * WhatsApp: a full-width dark sheet with the SEAL mark. A passphrase box that
 * blended into the host UI would be teaching people to type secrets into
 * whatever looks familiar, which is the habit that gets them phished.
 * ------------------------------------------------------------------------ */

function promptPassphrase(then: (passphrase: string) => void) {
  document.querySelector('.seal-sheet')?.remove();
  const sheet = document.createElement('div');
  sheet.className = 'seal-sheet';
  sheet.innerHTML = `
    <div class="seal-sheet-inner">
      <div class="seal-sheet-head"><span class="seal-mark">SEAL</span> unlock your signing key</div>
      <p>This signs the file so recipients can see it came from you. Your key stays in the
      extension; the file never leaves this machine.</p>
      <input type="password" class="seal-pass" placeholder="Extension passphrase" />
      <div class="seal-sheet-actions">
        <button class="seal-btn seal-cancel">Cancel</button>
        <button class="seal-btn seal-go">Sign</button>
      </div>
    </div>`;
  document.body.appendChild(sheet);

  const input = sheet.querySelector('.seal-pass') as HTMLInputElement;
  const go = () => {
    const v = input.value;
    sheet.remove();
    if (v) then(v);
  };
  input.focus();
  input.onkeydown = (e) => e.key === 'Enter' && go();
  (sheet.querySelector('.seal-go') as HTMLButtonElement).onclick = go;
  (sheet.querySelector('.seal-cancel') as HTMLButtonElement).onclick = () => sheet.remove();
}

/* --------------------------------------------------------------------------
 * Messages from the context menu
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
    void runSign(chip, msg.src, kindOf(el), captionOf(bubble));
  }
});

function kindOf(el: HTMLElement): MediaKind {
  const t = el.tagName.toLowerCase();
  return t === 'video' ? 'VIDEO' : t === 'audio' ? 'AUDIO' : 'IMAGE';
}

/* --------------------------------------------------------------------------
 * Boot
 * ------------------------------------------------------------------------ */

let timer: ReturnType<typeof setTimeout>;
new MutationObserver(() => {
  clearTimeout(timer);
  timer = setTimeout(scan, 500);
}).observe(document.documentElement, { childList: true, subtree: true });

setTimeout(scan, 1500);
