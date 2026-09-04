import { buildIntent, formatINR } from '@seal/shared';
import type { CallerChallenge, EscrowView, SigningRequest } from '@seal/shared';

/**
 * The whole product, in a 390px panel.
 *
 * Ordering is a security decision, not a layout one. The Inbox is first and
 * default because the two things that arrive unprompted -- "someone is
 * impersonating you" and "authorize this payment" -- are the two things that
 * must never be buried behind a tab someone forgets to open.
 */

interface State {
  sealUrl: string;
  signedIn: boolean;
  userId: string | null;
  userName: string | null;
  userRole: string | null;
  hasKey: boolean;
  credentialId: string | null;
  counter: number;
  unlockedUntil: number | null;
}

const main = document.getElementById('main')!;
const tabsEl = document.getElementById('tabs')!;

let state: State;
let tab = 'inbox';

function send<T = unknown>(msg: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) =>
    chrome.runtime.sendMessage(msg, (r) => {
      if (!r) return reject(new Error('SEAL background worker is not responding'));
      r.ok
        ? resolve(r.data as T)
        : reject(Object.assign(new Error(r.error), { code: r.code, name: r.name }));
    }),
  );
}

const esc = (s: unknown) => {
  const d = document.createElement('div');
  d.textContent = String(s ?? '');
  return d.innerHTML;
};

/* ==========================================================================
 * Shell
 * ======================================================================== */

async function render() {
  state = await send<State>({ type: 'STATE' });

  document.getElementById('who')!.innerHTML = state.signedIn
    ? `${esc(state.userName)}<br><span class="dim">${esc(state.userRole)}</span>`
    : '';
  document.getElementById('tier')!.textContent = state.hasKey ? 'extension key' : '';

  if (!state.signedIn) {
    tabsEl.hidden = true;
    return signIn();
  }
  if (!state.hasKey) {
    tabsEl.hidden = true;
    return keyPane(true);
  }

  tabsEl.hidden = false;
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === tab);
    t.onclick = () => {
      tab = t.dataset.tab!;
      void render();
    };
  });

  if (tab === 'inbox') return inbox();
  if (tab === 'pay') return pay();
  if (tab === 'verify') return verify();
  return keyPane(false);
}

/* ==========================================================================
 * Sign in
 * ======================================================================== */

async function signIn() {
  main.innerHTML = `
    <h1>Sign in</h1>
    <p>A session lets you look things up. Authorizing anything needs the key in this extension.</p>
    <label>Who are you?<select id="user"></select></label>
    <label>Demo password<input id="pw" type="password" value="demo" /></label>
    <p class="error" id="err" hidden></p>
    <button class="btn primary" id="go">Sign in</button>
    <footer><button class="link" id="settings">Server: ${esc(state.sealUrl)}</button></footer>`;

  try {
    const users = await send<Array<{ id: string; name: string; role: string }>>({ type: 'USERS' });
    (document.getElementById('user') as HTMLSelectElement).innerHTML = users
      .map((u) => `<option value="${esc(u.id)}">${esc(u.name)} — ${esc(u.role)}</option>`)
      .join('');
  } catch (e) {
    fail('err', `${(e as Error).message}. Is SEAL running?`);
  }

  document.getElementById('go')!.onclick = async () => {
    try {
      await send({
        type: 'SIGN_IN',
        userId: (document.getElementById('user') as HTMLSelectElement).value,
        password: (document.getElementById('pw') as HTMLInputElement).value,
      });
      await render();
    } catch (e) {
      fail('err', (e as Error).message);
    }
  };

  document.getElementById('settings')!.onclick = async () => {
    const url = prompt('SEAL server URL', state.sealUrl);
    if (url) {
      await send({ type: 'SET_URL', url });
      await render();
    }
  };
}

/* ==========================================================================
 * Inbox -- caller challenges first, then signature requests
 * ======================================================================== */

async function inbox() {
  main.innerHTML = `<p class="dim">Loading…</p>`;
  const [requests, challenges, escrows] = await Promise.all([
    send<SigningRequest[]>({ type: 'SIGNING_REQUESTS' }).catch(() => [] as SigningRequest[]),
    send<CallerChallenge[]>({ type: 'CHALLENGES' }).catch(() => [] as CallerChallenge[]),
    send<EscrowView[]>({ type: 'ESCROWS' }).catch(() => [] as EscrowView[]),
  ]);

  const myChallenges = challenges.filter(
    (c) => c.state === 'PENDING' && c.claimed_user_id === state.userId,
  );
  const myRequests = requests.filter(
    (r) => r.state === 'PENDING' && r.subject_user_id === state.userId,
  );
  const myPendingEscrows = escrows.filter(
    (e) =>
      e.state === 'PENDING_QUORUM' &&
      ['CEO', 'CTO', 'TREASURY', 'CFO'].includes(state.userRole ?? '') &&
      e.opened_by !== state.userId &&
      e.intent.originator.user_id !== state.userId &&
      !e.approvals.some((a) => a.approver_id === state.userId) &&
      !myRequests.some(
        (r) => r.action.kind === 'RECORD_APPROVAL' && (r.action as { escrow_id?: string }).escrow_id === e.escrow_id,
      ),
  );

  const dot = document.getElementById('inbox-dot')!;
  dot.hidden = myChallenges.length + myRequests.length + myPendingEscrows.length === 0;

  if (myChallenges.length === 0 && myRequests.length === 0 && myPendingEscrows.length === 0) {
    main.innerHTML = `
      <div class="empty">
        <div style="font-size:22px;margin-bottom:6px">✓</div>
        Nothing waiting for you.
        <div style="margin-top:9px">If someone is insisting a payment is urgent, this empty inbox
        is the answer. Nothing reaches your key except through here.</div>
      </div>
      <button class="btn danger" id="raise">Someone is pressuring me right now</button>`;
    document.getElementById('raise')!.onclick = () => {
      tab = 'verify';
      void render();
    };
    return;
  }

  main.innerHTML =
    myChallenges.map(challengeCard).join('') +
    myRequests.map(requestCard).join('') +
    (myPendingEscrows.length > 0
      ? `<div style="font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--dim);margin:14px 0 6px">Escrows awaiting your quorum approval</div>` +
        myPendingEscrows.map(escrowCard).join('')
      : '');

  for (const c of myChallenges) wireChallenge(c);
  for (const r of myRequests) wireRequest(r);
  for (const e of myPendingEscrows) wireEscrow(e);
}

/**
 * "Are you on this call?" outranks everything else in the panel: somebody is
 * being impersonated *now*, and the person who can stop it is reading this.
 * Deny is one tap and needs no key — under pressure, the safe answer must be
 * the cheap one.
 */
function challengeCard(c: CallerChallenge): string {
  return `
    <div class="card alert" data-chl="${esc(c.id)}">
      <span class="badge bad">verify a caller</span>
      <div class="headline" style="margin-top:8px">
        Are you on a ${esc(c.channel.toLowerCase().replace('_', ' '))} with ${esc(c.raised_by_name)} right now?
      </div>
      <p>They say you are asking them to: “${esc(c.demand)}”</p>
      <button class="btn danger" data-act="deny">No — that is not me</button>
      <button class="btn ghost sm" data-act="show" style="width:100%">Show the code to read back</button>
      <div data-slot></div>
    </div>`;
}

function wireChallenge(c: CallerChallenge) {
  const card = main.querySelector<HTMLElement>(`[data-chl="${c.id}"]`)!;
  const slot = card.querySelector<HTMLElement>('[data-slot]')!;

  card.querySelector<HTMLButtonElement>('[data-act="deny"]')!.onclick = async () => {
    try {
      await send({ type: 'DENY_CHALLENGE', id: c.id });
      await render();
    } catch (e) {
      slot.innerHTML = `<p class="error">${esc((e as Error).message)}</p>`;
    }
  };

  card.querySelector<HTMLButtonElement>('[data-act="show"]')!.onclick = () => {
    slot.innerHTML = `
      <div class="code">${esc(c.code)}</div>
      <p>Read this aloud. It is on ${esc(c.raised_by_name)}'s screen too. Never type it into a
      chat or a website — only say it, on the call you are already on.</p>
      <label>Passphrase<input type="password" data-pass /></label>
      <button class="btn good" data-act="confirm">They read it back — confirm it is me</button>`;
    slot.querySelector<HTMLButtonElement>('[data-act="confirm"]')!.onclick = async () => {
      const pass = slot.querySelector<HTMLInputElement>('[data-pass]')!.value;
      try {
        await send({ type: 'CONFIRM_CHALLENGE', id: c.id, passphrase: pass });
        await render();
      } catch (e) {
        slot.insertAdjacentHTML('beforeend', `<p class="error">${esc((e as Error).message)}</p>`);
      }
    };
  };
}

function requestCard(r: SigningRequest): string {
  const amount = r.rows.find(([k]) => k === 'Amount')?.[1];
  const payee = r.rows.find(([k]) => k === 'Payee')?.[1];
  const rest = r.rows.filter(([k]) => k !== 'Amount' && k !== 'Payee');
  const mm = String(Math.floor(r.seconds_remaining / 60)).padStart(2, '0');
  const ss = String(r.seconds_remaining % 60).padStart(2, '0');

  return `
    <div class="card warn" data-req="${esc(r.id)}">
      <div class="row">
        <span class="badge warn">awaiting you</span>
        <div class="spacer"></div>
        <span class="mono">${mm}:${ss}</span>
      </div>
      <div class="headline" style="margin-top:8px">${esc(r.title)}</div>
      <div class="dim" style="font-size:11px">${esc(r.subtitle)}</div>
      ${amount ? `<div class="amount">${esc(amount)}</div>` : ''}
      ${payee ? `<div style="font-weight:600">to ${esc(payee)}</div>` : ''}
      <div class="facts">
        ${rest.map(([k, v]) => `<div><span>${esc(k)}</span>${esc(v)}</div>`).join('')}
      </div>
      ${
        r.warnings.length
          ? `<ul class="warnlist">${r.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`
          : ''
      }
      <label style="margin-top:10px">Passphrase<input type="password" data-pass /></label>
      <button class="btn good" data-act="sign">Authorize</button>
      <button class="btn ghost" data-act="decline">I did not ask for this — decline</button>
      <div data-err></div>
    </div>`;
}

function wireRequest(r: SigningRequest) {
  const card = main.querySelector<HTMLElement>(`[data-req="${r.id}"]`)!;
  const err = card.querySelector<HTMLElement>('[data-err]')!;

  card.querySelector<HTMLButtonElement>('[data-act="sign"]')!.onclick = async () => {
    const pass = card.querySelector<HTMLInputElement>('[data-pass]')!.value;
    if (!pass) return (err.innerHTML = `<p class="error">Your passphrase is required.</p>`);
    try {
      await send({ type: 'FULFIL', id: r.id, passphrase: pass });
      await render();
    } catch (e) {
      err.innerHTML = `<p class="error">${esc((e as Error).message)}</p>`;
    }
  };

  card.querySelector<HTMLButtonElement>('[data-act="decline"]')!.onclick = async () => {
    try {
      await send({ type: 'DECLINE', id: r.id, reason: 'Declined in the extension' });
      await render();
    } catch (e) {
      err.innerHTML = `<p class="error">${esc((e as Error).message)}</p>`;
    }
  };
}

/* ==========================================================================
 * Pay -- compose an intent, and approve other people's escrows
 * ======================================================================== */

async function pay() {
  const policy = await send<{
    org_id: string;
    vendors: Array<{ name: string; account: string; ifsc: string }>;
  }>({ type: 'POLICY' });
  const escrows = await send<EscrowView[]>({ type: 'ESCROWS' }).catch(() => [] as EscrowView[]);
  const live = escrows.filter((e) => e.state === 'PENDING_QUORUM');

  const canOriginate = ['CFO', 'CEO', 'TREASURY'].includes(state.userRole ?? '');

  main.innerHTML = `
    ${
      canOriginate
        ? `<h2>New payment</h2>
    <label>Payee<input id="p-name" placeholder="Alton Logistics Pvt Ltd" /></label>
    <label>Account<input id="p-acc" placeholder="50100234564419" /></label>
    <label>IFSC<input id="p-ifsc" placeholder="HDFC0001234" /></label>
    <label>Amount (INR)<input id="p-amt" placeholder="4200000.00" /></label>
    <label>Purpose<input id="p-purpose" value="Vendor settlement" /></label>
    <div class="row" style="margin-bottom:10px">
      <span class="dim" style="font-size:11px">Vendor master:</span>
      ${policy.vendors
        .map(
          (v, i) =>
            `<button class="btn ghost sm" data-vendor="${i}">${esc(v.name.split(' ')[0])}</button>`,
        )
        .join('')}
    </div>
    <button class="btn primary" id="compose">Compose and send to my key</button>
    <div id="compose-out"></div>`
        : `<div class="empty">Your role does not originate payments.</div>`
    }

    <h2>Escrows awaiting a quorum</h2>
    ${
      live.length === 0
        ? `<div class="empty">Nothing in flight.</div>`
        : live.map(escrowCard).join('')
    }`;

  if (canOriginate) {
    main.querySelectorAll<HTMLButtonElement>('[data-vendor]').forEach((b) => {
      b.onclick = () => {
        const v = policy.vendors[Number(b.dataset.vendor)];
        (document.getElementById('p-name') as HTMLInputElement).value = v.name;
        (document.getElementById('p-acc') as HTMLInputElement).value = v.account;
        (document.getElementById('p-ifsc') as HTMLInputElement).value = v.ifsc;
      };
    });

    document.getElementById('compose')!.onclick = async () => {
      const out = document.getElementById('compose-out')!;
      const val = (id: string) => (document.getElementById(id) as HTMLInputElement).value.trim();
      try {
        const intent = buildIntent({
          org_id: policy.org_id,
          type: 'wire_transfer',
          payee: { name: val('p-name'), account: val('p-acc'), ifsc: val('p-ifsc').toUpperCase() },
          amount: { value: val('p-amt'), currency: 'INR' },
          purpose: val('p-purpose'),
          deadline: new Date(Date.now() + 48 * 3600_000).toISOString(),
          originator: { user_id: state.userId!, role: state.userRole as 'CFO' },
        });
        await send({ type: 'CREATE_INTENT', intent });
        out.innerHTML = `<div class="card ok"><div class="headline">Sent to your key</div>
          <p>It is in your Inbox. Nothing exists until you authorize it there.</p></div>`;
        tab = 'inbox';
        setTimeout(() => void render(), 900);
      } catch (e) {
        out.innerHTML = `<p class="error">${esc((e as Error).message)}</p>`;
      }
    };
  }

  for (const e of live) {
    wireEscrow(e);
  }
}

function wireEscrow(e: EscrowView) {
  const card = main.querySelector<HTMLElement>(`[data-esc="${e.escrow_id}"]`);
  if (!card) return;
  card.querySelectorAll<HTMLButtonElement>('[data-decision]').forEach((b) => {
    b.onclick = async () => {
      try {
        await send({
          type: 'REQUEST_APPROVAL',
          escrowId: e.escrow_id,
          decision: b.dataset.decision,
        });
        tab = 'inbox';
        await render();
      } catch (err) {
        card.insertAdjacentHTML(
          'beforeend',
          `<p class="error">${esc((err as Error).message)}</p>`,
        );
      }
    };
  });
}

function escrowCard(e: EscrowView): string {
  const approvals = e.approvals.filter((a) => a.decision === 'APPROVE').length;
  const mediaShaMatch = e.intent.purpose.match(/Media #([0-9a-fA-F]+)/i) ||
    e.intent.purpose.match(/([0-9a-f]{64})/i);
  const mediaDigest = mediaShaMatch ? mediaShaMatch[1].slice(0, 12) : null;

  return `
    <div class="card" data-esc="${esc(e.escrow_id)}">
      <div class="row">
        <span class="mono">${esc(e.txn_id)}</span>
        <span class="badge ${e.risk.tier === 'CRITICAL' ? 'bad' : e.risk.tier === 'HIGH' ? 'warn' : ''}">${esc(e.risk.tier)}</span>
        <div class="spacer"></div>
        <span class="mono">${esc(formatINR(e.intent.amount.value))}</span>
      </div>
      <div style="margin-top:6px;font-weight:600">${esc(e.intent.payee.name)}</div>
      <div class="dim mono">${esc(e.intent.payee.account)} · IFSC ${esc(e.intent.payee.ifsc)}</div>
      ${mediaDigest ? `<div style="margin-top:4px"><span class="badge" style="background:#162438;border:1px solid #2f4d75;color:#8ab4f8;font-size:10px">WhatsApp Media #${esc(mediaDigest)}… verified</span></div>` : ''}
      <div class="dim" style="font-size:11px;margin-top:4px">
        ${approvals}/${e.required_approvals} approvals · ${Math.round(e.seconds_remaining / 60)} min left
      </div>
      <div class="row" style="margin-top:10px">
        <button class="btn ghost sm" data-decision="REJECT">Decline</button>
        <div class="spacer"></div>
        <button class="btn good sm" data-decision="APPROVE">Approve on my key</button>
      </div>
    </div>`;
}

/* ==========================================================================
 * Verify -- challenge a caller
 * ======================================================================== */

async function verify() {
  const policy = await send<{ challengeable: Array<{ id: string; name: string; role: string }> }>({
    type: 'POLICY',
  });
  const { pendingDemand } = await chrome.storage.local.get(['pendingDemand']);
  if (pendingDemand) await chrome.storage.local.remove(['pendingDemand']);

  main.innerHTML = `
    <div class="card warn">
      <div class="headline">You are not being asked to judge a video</div>
      <p style="margin:0">You are going to ask them something only the real person can answer.</p>
    </div>
    <label>Who do they claim to be?
      <select id="claimed">${policy.challengeable
        .map((p) => `<option value="${esc(p.id)}">${esc(p.name)} — ${esc(p.role)}</option>`)
        .join('')}</select></label>
    <label>How did they reach you?
      <select id="channel">
        <option value="VIDEO">Video call</option>
        <option value="PHONE">Phone call</option>
        <option value="CHAT">WhatsApp / chat</option>
        <option value="MEETING">Online meeting</option>
        <option value="EMAIL">Email</option>
        <option value="IN_PERSON">In person</option>
      </select></label>
    <label>What are they asking for?
      <textarea id="demand" rows="2">${esc(pendingDemand ?? '')}</textarea></label>
    <button class="btn danger" id="go">Challenge this caller</button>
    <div id="out"></div>`;

  document.getElementById('go')!.onclick = async () => {
    const out = document.getElementById('out')!;
    try {
      const c = await send<CallerChallenge>({
        type: 'RAISE_CHALLENGE',
        claimedUserId: (document.getElementById('claimed') as HTMLSelectElement).value,
        channel: (document.getElementById('channel') as HTMLSelectElement).value,
        demand: (document.getElementById('demand') as HTMLTextAreaElement).value || 'Not stated',
        source: { platform: 'WhatsApp Web' },
      });
      const paint = (live: CallerChallenge) => {
        if (live.state === 'DENIED') {
          out.innerHTML = `<div class="card alert"><div class="headline">That is not ${esc(live.claimed_name)}</div>
            <p style="margin:0">They confirmed from their own device that they are not on this call.
            End it. Anything it was pushing for has been stopped.</p></div>`;
          return true;
        }
        if (live.state === 'CONFIRMED') {
          out.innerHTML = `<div class="card ok"><div class="headline">Caller verified</div>
            <p style="margin:0">${esc(live.claimed_name)} signed a confirmation on their device.
            That settles who you are talking to — it authorizes no payment.</p></div>`;
          return true;
        }
        if (live.state === 'EXPIRED') {
          out.innerHTML = `<div class="card warn"><div class="headline">No answer</div>
            <p style="margin:0">Treat this caller as unverified. Silence is not a pass.</p></div>`;
          return true;
        }
        out.innerHTML = `<div class="card warn">
          <div class="headline">Ask them to read this back</div>
          <div class="code">${esc(live.code)}</div>
          <p style="margin:0"><b>If they cannot read it back, it is not them.</b> Expect
          “I'm driving”, “my phone is dead”, “there's no time”. A real executive reads six
          characters.</p></div>`;
        return false;
      };

      paint(c);
      const poll = setInterval(async () => {
        try {
          const live = (await send<CallerChallenge[]>({ type: 'CHALLENGES' })).find(
            (x) => x.id === c.id,
          );
          if (live && paint(live)) clearInterval(poll);
        } catch {
          /* transient */
        }
      }, 1500);
    } catch (e) {
      out.innerHTML = `<p class="error">${esc((e as Error).message)}</p>`;
    }
  };
}

/* ==========================================================================
 * Key
 * ======================================================================== */

async function keyPane(first: boolean) {
  if (!state.hasKey) {
    main.innerHTML = `
      <h1>${first ? 'Set up your signing key' : 'No key yet'}</h1>
      <p>Generated here and sealed with a passphrase. It lives in the extension's own storage,
      where no web page can reach it — including whatever WhatsApp Web is running.</p>
      <div class="card warn">
        <div class="headline">Honest about the tier</div>
        <p style="margin:0">A key here is stronger than one in a web page and weaker than one on
        your phone: it is still on this laptop. Payments signed with it carry a risk premium, and
        the approver screens say so.</p>
      </div>
      <label>Passphrase<input id="p1" type="password" /></label>
      <label>Passphrase again<input id="p2" type="password" /></label>
      <p class="error" id="err" hidden></p>
      <button class="btn primary" id="go">Generate and enrol</button>
      <footer><button class="link" id="out">Sign out</button></footer>`;

    document.getElementById('go')!.onclick = async () => {
      const p1 = (document.getElementById('p1') as HTMLInputElement).value;
      const p2 = (document.getElementById('p2') as HTMLInputElement).value;
      if (p1.length < 4) return fail('err', 'Choose at least 4 characters.');
      if (p1 !== p2) return fail('err', 'The two passphrases do not match.');
      try {
        const out = await send<{ bootstrap_ceremony: boolean; required_approvals: number }>({
          type: 'CREATE_KEY',
          passphrase: p1,
          label: 'Browser extension',
        });
        main.innerHTML = `<div class="card ok"><div class="headline">Key enrolled</div><p>${
          out.bootstrap_ceremony
            ? 'Activated under the bootstrap ceremony — fewer than two executive keys existed. It is stamped as such in the audit chain.'
            : `Awaiting ${out.required_approvals} signed approval(s) from executives who already hold a key.`
        }</p></div>`;
        setTimeout(() => void render(), 1600);
      } catch (e) {
        fail('err', (e as Error).message);
      }
    };
    document.getElementById('out')!.onclick = async () => {
      await send({ type: 'SIGN_OUT' });
      await render();
    };
    return;
  }

  const me = await send<{
    credentials: Array<{ credential_id: string; state: string; device_kind: string; counter: number }>;
  }>({ type: 'ME' }).catch(() => ({ credentials: [] }));
  const server = me.credentials.find((c) => c.credential_id === state.credentialId);
  const unlocked = state.unlockedUntil && state.unlockedUntil > Date.now();

  main.innerHTML = `
    <div class="card ${server?.state === 'ACTIVE' ? 'ok' : 'warn'}">
      <div class="row">
        <span class="badge ${server?.state === 'ACTIVE' ? 'ok' : 'warn'}">${esc(server?.state ?? 'not on server')}</span>
        <div class="spacer"></div>
        <span class="badge">extension key</span>
      </div>
      <div class="facts">
        <div><span>Credential</span><span class="mono">${esc(state.credentialId)}</span></div>
        <div><span>Signatures</span>${esc(state.counter)}</div>
        <div><span>Unlock</span>${
          unlocked
            ? `open for media until ${new Date(state.unlockedUntil!).toLocaleTimeString()}`
            : 'locked'
        }</div>
      </div>
    </div>
    <p>Signing media may reuse a five-minute unlock so you are not retyping a passphrase for every
    clip. Payments never do — an intent or an approval asks again, every time.</p>
    ${unlocked ? `<button class="btn ghost" id="lock">Lock now</button>` : ''}
    <button class="btn danger" id="destroy">Destroy this key</button>
    <footer>
      <button class="link" id="out">Sign out</button>
      <button class="link" id="url">Server: ${esc(state.sealUrl)}</button>
    </footer>`;

  document.getElementById('lock')?.addEventListener('click', async () => {
    await send({ type: 'LOCK' });
    await render();
  });
  document.getElementById('destroy')!.onclick = async () => {
    if (confirm('Delete the key in this extension? It cannot be recovered.')) {
      await send({ type: 'DESTROY_KEY' });
      await render();
    }
  };
  document.getElementById('out')!.onclick = async () => {
    await send({ type: 'SIGN_OUT' });
    await render();
  };
  document.getElementById('url')!.onclick = async () => {
    const url = prompt('SEAL server URL', state.sealUrl);
    if (url) {
      await send({ type: 'SET_URL', url });
      await render();
    }
  };
}

function fail(id: string, message: string) {
  const el = document.getElementById(id)!;
  el.textContent = message;
  el.hidden = false;
}

void render();
