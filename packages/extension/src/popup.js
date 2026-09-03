/**
 * SEAL popup.
 *
 * The default tab is "Verify a caller", not a dashboard. Somebody opening this
 * extension is usually mid-conversation with someone who is pressuring them,
 * and the first thing they see should be the way out.
 */

const $ = (id) => document.getElementById(id);

const send = (msg) =>
  new Promise((resolve, reject) =>
    chrome.runtime.sendMessage(msg, (r) => {
      if (!r) return reject(new Error('SEAL background worker did not respond'));
      r.ok ? resolve(r.data) : reject(Object.assign(new Error(r.error), { code: r.code }));
    }),
  );

let poll = null;

async function boot() {
  const cfg = await send({ type: 'CONFIG' });
  $('open-console').href = cfg.sealUrl.replace(':4000', ':5173');

  if (!cfg.token) return showSignIn();

  $('who').textContent = cfg.userName ?? cfg.userId ?? '';
  $('signin').hidden = true;
  $('app').hidden = false;

  // Prefilled from a right-click or a badge press in the page, so nobody has to
  // retype what they were just told.
  const { pendingDemand, pendingPlatform, pendingUrl } = await chrome.storage.local.get([
    'pendingDemand',
    'pendingPlatform',
    'pendingUrl',
  ]);
  if (pendingDemand) {
    $('demand').value = pendingDemand;
    window.__source = { platform: pendingPlatform, url: pendingUrl };
    await chrome.storage.local.remove(['pendingDemand', 'pendingPlatform', 'pendingUrl']);
  }

  try {
    const policy = await send({ type: 'POLICY' });
    $('claimed').innerHTML = (policy.challengeable ?? [])
      .map((p) => `<option value="${p.id}">${p.name} — ${p.role}</option>`)
      .join('');
  } catch (e) {
    $('challenge-error').textContent = e.message;
    $('challenge-error').hidden = false;
  }
}

async function showSignIn() {
  $('app').hidden = true;
  $('signin').hidden = false;
  try {
    const users = await send({ type: 'USERS' });
    $('user').innerHTML = users
      .map((u) => `<option value="${u.id}">${u.name} — ${u.role}</option>`)
      .join('');
  } catch (e) {
    $('signin-error').textContent = `${e.message}. Is SEAL running?`;
    $('signin-error').hidden = false;
  }
}

/* --------------------------------------------------------------------------
 * Actions
 * ------------------------------------------------------------------------ */

$('do-signin').onclick = async () => {
  $('signin-error').hidden = true;
  try {
    await send({ type: 'SIGN_IN', userId: $('user').value, password: $('password').value });
    await boot();
  } catch (e) {
    $('signin-error').textContent = e.message;
    $('signin-error').hidden = false;
  }
};

$('do-signout').onclick = async () => {
  await send({ type: 'SIGN_OUT' });
  clearInterval(poll);
  location.reload();
};

document.querySelectorAll('.tab').forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document
      .querySelectorAll('.pane')
      .forEach((p) => (p.hidden = p.dataset.pane !== tab.dataset.tab));
  };
});

$('do-challenge').onclick = async () => {
  $('challenge-error').hidden = true;
  const btn = $('do-challenge');
  btn.disabled = true;
  try {
    const challenge = await send({
      type: 'CHALLENGE',
      claimedUserId: $('claimed').value,
      channel: $('channel').value,
      demand: $('demand').value.trim() || 'Not stated',
      source: window.__source ?? null,
    });
    renderChallenge(challenge);
    watch(challenge.id);
  } catch (e) {
    $('challenge-error').textContent = e.message;
    $('challenge-error').hidden = false;
  } finally {
    btn.disabled = false;
  }
};

function watch(id) {
  clearInterval(poll);
  poll = setInterval(async () => {
    try {
      const next = await send({ type: 'CHALLENGE_STATE', id });
      renderChallenge(next);
      if (next.state !== 'PENDING') clearInterval(poll);
    } catch {
      /* transient */
    }
  }, 1500);
}

function renderChallenge(c) {
  const box = $('challenge-result');
  box.hidden = false;

  if (c.state === 'DENIED') {
    box.className = 'result bad';
    box.innerHTML = `
      <div class="headline">That is not ${esc(c.claimed_name)}</div>
      <p>They have confirmed from their own device that they are not on this call. End it now and
      do not act on anything it asked for. Security has been alerted.</p>`;
    return;
  }

  if (c.state === 'CONFIRMED') {
    box.className = 'result ok';
    box.innerHTML = `
      <div class="headline">Caller verified</div>
      <p>${esc(c.claimed_name)} signed a confirmation on their enrolled device. That settles who you
      are talking to — it still authorizes no payment.</p>`;
    return;
  }

  if (c.state === 'EXPIRED') {
    box.className = 'result bad';
    box.innerHTML = `
      <div class="headline">No answer</div>
      <p>Treat this caller as unverified. Silence is not a pass. Reach ${esc(
        c.claimed_name,
      )} on a number you already had — not one this caller gave you.</p>`;
    return;
  }

  box.className = 'result pending';
  box.innerHTML = `
    <div class="headline">Ask them to read this back</div>
    <div class="code">${esc(c.code)}</div>
    <p>This code is on ${esc(c.claimed_name)}'s device and on your screen. Nowhere else.</p>
    <p class="tight"><b>If they cannot read it back, it is not them.</b> Expect excuses:
    "I'm driving", "my phone is dead", "there's no time". A real executive will read six
    characters.</p>`;
}

$('do-lookup').onclick = async () => {
  const box = $('lookup-result');
  box.hidden = false;
  box.className = 'result pending';
  box.textContent = 'Checking…';
  try {
    const r = await send({ type: 'LOOKUP', txnId: $('txn').value.trim() });
    box.className = `result ${r.authorized ? 'ok' : 'bad'}`;
    box.innerHTML = `
      <div class="headline">${esc(r.headline)}</div>
      <p>${esc(r.detail ?? '')}</p>
      ${
        r.payee
          ? `<div class="facts">
               <div><span>Payee</span>${esc(r.payee.name)}</div>
               <div><span>Account</span>${esc(r.payee.account)}</div>
               <div><span>Amount</span>${esc(r.amount?.value ?? '')}</div>
               <div><span>Signed by</span>${esc(r.signed_by?.user_id ?? '')} (${esc(
                 r.custody ?? '',
               )})</div>
             </div>`
          : ''
      }`;
  } catch (e) {
    box.className = 'result bad';
    box.textContent = e.message;
  }
};

function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s ?? '');
  return d.innerHTML;
}

boot();
