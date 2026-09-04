# SEAL — Signed Executive Authorization Ledger

**Lane A, with out-of-band signing devices.**

A high-risk payment executes only if the executive **cryptographically signed the exact transaction
object on a device that is not the one that composed it**, and if that signed object then survives a
**time-boxed escrow requiring a quorum of independent approvers**, and if the **payment rail
independently re-verifies every signature** before it moves money.

The phone call, the video meeting and the email carry zero authority. They are channels for
notification, not authorization. A deepfake can imitate a voice perfectly and still produce nothing
this system will accept.

> Stop trying to detect the fake. Make the real thing unforgeable and require it.

There is no deepfake classifier in this repository, and that is the design, not an omission.
Detection is a risk *signal*; it is never the gate.

---

## Run it

```bash
npm install
npm run seed        # 7 people, 3 verified vendors, zero credentials (by design)
npm run dev         # rail :4001 · SEAL :4000 · console :5173 · Authenticator :5174
npm run build:ext   # then load packages/extension/dist as an unpacked extension
```

Open the **console** at <http://localhost:5173> and the **SEAL Authenticator** at
<http://localhost:5174> — ideally on two different screens, because that separation is the whole
point. Every seeded account uses the password `demo`.

```bash
npm run sim         # end-to-end walkthrough + 66-check attack suite
npm run check       # the device credential code, exercised headlessly
npm run reset       # wipe the database, the ledger, the key directory
```

`npm run sim` is the fastest way to see what the system does. It enrols devices through the
quorum-gated key ceremony, runs a payment from request to settlement, then runs every attack and
asserts the *specific* rejection code for each one. A block for the wrong reason is reported as a
failure, so it doubles as the regression suite.

**First run, in order:** open the Authenticator, sign in as Priya (CFO), enrol a key. Repeat for
Rahul (CEO) and Anita (CTO) — the first two activate under the bootstrap ceremony, and the third
waits for two signed approvals which the first two give from their own devices. Then go to the
console and compose a payment.

---

## The device that holds the key

The console cannot sign. It holds no key, it has no endpoint that accepts one, and there is no code
path anywhere in it that produces a signature. What it can do is write down exactly what it wants
signed:

```
console                    SEAL                     Authenticator (phone)
   │  compose payment       │                              │
   ├───────────────────────▶│  POST /api/intents           │
   │                        │  hash fixed, request stored  │
   │                        ├─────────────────────────────▶│  payee, account, amount
   │                        │                              │  fingerprint / passphrase
   │  202 + request id      │◀─────────────────────────────┤  POST …/fulfil { signature }
   │◀───────────────────────┤  verify against fixed hash   │
   │  "waiting for device"  │  then submit the intent      │
```

Three properties make this more than a confirmation dialog:

1. **The payload hash is fixed when the request is created** and re-checked when the signature comes
   back. A compromised console cannot show one payment on the phone and submit another — the
   simulation asserts exactly this (`SIGNATURE_PAYLOAD_HASH_MISMATCH`).
2. **The signature is produced on a different device at a different origin**, with its own key store.
   Owning the console is no longer enough to move money.
3. **The human sees payee, account and amount on the device that holds the key**, which is the only
   place "what you see is what you sign" can actually be true.

So the compromised-console attack becomes survivable rather than fatal. Malware that owns the browser
can compose whatever it likes; every attempt surfaces on the real executive's phone showing a payee
they have never heard of, and dies there — with the refusal written into the audit chain as
`SIGNING_DECLINED`.

---

## When the deepfake is standing right there

Signatures settle whether a *transaction* is genuine. They do nothing for the human sitting in front
of a screen while a perfect copy of their CFO's face and voice tells them to hurry up — and that
human still has a decision to make. Two places in this system still have one:

- **the employee**, whose queue is empty, but who is being shouted at
- **the approver**, who has a real escrow open and is being told "approve it, I just signed it" —
  the dangerous one, because there is something to push against

Neither is asked to judge whether the video looks real. Nobody can do that reliably, and the problem
statement says so. They are given a question the fake cannot answer.

### The caller challenge

One click, from anywhere in the console or the browser extension: *someone is pressuring me*. Pick
who they claim to be. A six-character code appears — on your screen and on that executive's enrolled
device, **nowhere else**, never on the channel the caller is using.

> "Before I do anything — open your SEAL app and read me the code."

An impersonator has the face and the voice. They do not have the phone in that person's pocket.
Expect the excuses the interface names for you in advance: *I'm driving*, *my phone is dead*,
*there's no time*, *just do it, I'll approve it after*. A real executive reads six characters.

The reverse direction needs no cleverness from anybody and is usually what fires first. The real
executive's device asks: **"Are you on a video call with Aravind right now?"** Deny is one tap, needs
no signature, and is the biggest button on the screen — under pressure, the button your thumb lands
on should be the safe one. Confirming is the one that costs a signature, because it is the positive
claim.

Denying does four things at once:

1. **voids the escrow that call was pushing for** — a genuine payment can be raised again in a
   minute; the fraudulent one gets no second chance
2. **alerts every console in the org**, live
3. **chains it** as `CALLER_DENIED`, with the channel, the demand and who was targeted
4. **raises the risk tier on everything that executive originates for 24 hours** —
   `ACTIVE_IMPERSONATION` is worth +45 and floors the tier at CRITICAL, so even a routine ₹1.5L
   payment to a known vendor now needs three signatures including the treasury head

That last one is the point. An impersonation is a fact about the world right now, not a property of
one payment, and it should colour everything that person touches until it is understood.

Silence is not a pass either: an unanswered challenge expires as unverified and still carries a risk
premium.

### The prompt itself argues back

The signing device no longer just shows fields. The server computes what is *unusual* and the phone
says it in words, so nobody has to hold a vendor master in their head while being talked at:

> **Worth a second look**
> · This account is not in your vendor master. It has never been paid before.
> · The deadline is under four hours away. Urgency is the most common lever in this attack.
> · Someone was impersonating you recently. Be especially careful with this one.

---

## The extension, on WhatsApp Web

The attack does not arrive in a console. It arrives as a voice note, a video, a
message. So the whole flow — verify, sign, pay, approve — lives in a browser
extension that sits in the tab where the message lands.

```bash
npm run build:ext
```

Chrome → `chrome://extensions` → Developer mode → **Load unpacked** →
`packages/extension/dist`. Sign in, set a passphrase, and the extension
generates its own key.

### 1. Every media bubble gets checked, before anyone acts

Open WhatsApp Web and every photo, video and voice note picks up a chip. It
verifies on sight — nobody has to remember to check:

> **SEAL** · signed by Priya Nair · CFO
> 04 Sep, 11:42 · authenticator key. Provenance, not proof the contents are true.

> **SEAL** · unsigned — nobody has vouched for this file
> Not proof it is fake. It means nothing verifies where it came from.

That wording is the entire product argument. It never says *fake*, because it
cannot know that. It says **unsigned**, which it does know, and which is the
useful fact: in an organisation where genuine executive media carries a
signature, the forgery is the one with nothing attached to it.

The digest is computed in the page, over the delivered bytes. **The file never
leaves the machine** — only a SHA-256 goes to the ledger.

### 2. Signing your own

On a message you sent, the chip also offers **Sign as mine**. One passphrase
unlocks the key for five minutes so a batch of clips does not mean five
prompts.

The subtlety worth knowing: you sign **after** posting, not before. WhatsApp
re-encodes media on upload, so a signature over the file you picked off disk
would not match the file anyone receives. Signing what was delivered sidesteps
that completely — and the sim proves a single altered byte drops the signature.

### 3. Payments, without leaving the tab

The popup carries the rest: **Inbox** (signature requests and caller challenges,
first and default, because those arrive unprompted), **Pay** (compose an intent,
approve someone else's escrow), **Verify** (challenge a caller), **Key**.

### What this costs, stated plainly

A key in the extension is a **new custody tier**, and it sits between the two
that existed:

| | reachable by a compromised web page | on the same machine as the browser |
|---|---|---|
| console key | **yes** — barred for executives | yes |
| **extension key** | no — extension storage is its own origin | yes, **+8 risk** |
| authenticator (phone) | no | no, **+5 risk** |
| hardware key | no | no, **no premium** |

So putting everything in the extension buys convenience and gives up the
out-of-band property. A compromised laptop can now both compose a payment and
hold the key that signs it. That is a real reduction and the system prices it:
approver screens show `extension key`, and the risk engine adds the premium to
every payment signed with one.

Two guardrails remain regardless of tier:

- **Money always re-asks for the passphrase.** The five-minute unlock applies to
  `MEDIA` signatures only. `INTENT` and `APPROVAL` demand it every single time,
  so `user_presence` on those envelopes stays a true statement.
- **A signature carries its own custody tier**, inside the signed bytes. An
  extension key cannot claim to be a phone in transit — the sim asserts exactly
  this (`DEVICE_KIND_MISMATCH`).

---

## The custody ladder

Where a key lives is policy-bearing, not a deployment detail. `device_kind` is a column, a field
inside every signature, a risk input, and a check the payment rail makes on its own authority.

| | **console** | **extension** | **authenticator** | **hardware** |
|---|---|---|---|---|
| Where the key is | the page that composes payments | extension storage, its own origin | SEAL Authenticator, separate device | inside a FIDO2 authenticator |
| Reachable by a compromised web page | **yes** | no | no | no |
| On the same machine as the browser | yes | yes | no | no |
| Can it be exported? | yes | yes, with the passphrase | yes, with the passphrase | **no** |
| User presence | passphrase per signature | passphrase per payment | passphrase per signature | fingerprint / face / touch |
| Risk premium | +12 | +8 | +5 | **0** |
| Executives may use it | **no — refused** | yes | yes | yes, preferred |

`CONSOLE_KEY_NOT_PERMITTED` is enforced in three places on purpose: when a key is enrolled, when a
signature is used, and again at the payment rail — which applies its own copy of the rule, so
changing it inside SEAL would not be enough.

**The hardware tier is WebAuthn / FIDO2**, wired end to end: registration options are generated
server-side with a stored challenge, the key is created inside the authenticator, and assertions are
verified by both SEAL and the rail. The binding that makes it meaningful is the challenge — it is the
SHA-256 of the signature's core facts (domain, purpose, credential, payload hash), so a hardware
assertion proves not merely "this key was touched" but "this key authorized this exact payload for
this exact purpose".

---

## The three stages

**Stage 1 — the executive authorizes.** The console builds a canonical transaction object,
canonicalizes it with RFC 8785 (JCS) and hashes it with SHA-256. The executive's own device signs
that hash. The signed object *is* the transaction; it is not a wrapper around one.

**Stage 2 — the employee verifies and opens escrow.** The employee sees a queue of signed requests
and can only accept or reject. Payment fields are rendered as locked text, not inputs. There is no
"create payment" screen. This inverts the attack: the employee is the person being socially
engineered, so the design removes the field where attacker-supplied data would enter.

**Stage 3 — quorum inside the window.** Independent approvers confirm **the same hash**, each on
their own device. Both approve inside the window and the payment executes; the window closes and the
escrow is **voided**, retained, and flagged.

---

## What actually enforces it

```
POST http://localhost:4001/execute   →  403 APPROVAL_BUNDLE_INVALID
```

The mock payment rail is a separate process with exactly one way in. It never asks SEAL whether a
signature is good. It re-canonicalizes the intent, recomputes the hash itself, verifies the executive
signature and every approval signature — Ed25519 or WebAuthn — against **its own copy of the key
directory**, applies **its own** custody and mandate policy, and keeps **its own** settled-nonce
ledger. SEAL could be entirely compromised and the money still would not move.

`/pay` — the manual path an employee would otherwise use — answers 403 as well. If a human can still
log into a bank portal and pay by hand, the escrow is advisory, not a control.

Every refusal is reported back to SEAL and appended to the audit chain as `ATTACK_BLOCKED`, so an
attack aimed *past* SEAL still leaves evidence *inside* it. That report is a machine-to-machine
channel authenticated with a shared secret (`SEAL_RAIL_SECRET`, default `demo-rail-secret`), and it
is evidence only — it can never authorize anything, and the rail's decision does not depend on SEAL
hearing about it.

---

## What is deliberately not built yet

**Lane B — employee-originated requests.** Sometimes staff genuinely need to ask "can I settle ₹X to
this account?". That path must exist, but it must never *look* like a signed one. Rather than
half-build it, the endpoint answers `501 LANE_B_NOT_IMPLEMENTED` and the UI shows it as a closed,
amber, clearly-labelled card next to the green Lane A queue. The schema already carries the `lane`
column on intents, escrows and every audit entry, so the origin of every field is recorded from day
one — which is the field nobody logs today.

When it opens it needs: a cap (₹5,00,000), a blocking vendor-master check on new beneficiaries, and
escalation above the cap into a signature request pushed to the CFO's own device. That escalation
channel already exists — it is the same one every signature uses.

---

## Layout

```
packages/shared          canonicalization, hashing, the signature envelope, the signer interface
  /vault                 the device key vault (browser-only)
  /hardware              the WebAuthn signer (browser-only)
  /webauthn              WebAuthn verification (Node-only, used by SEAL and the rail)
packages/server          API, SQLite, risk engine, escrow lifecycle, hash-chained audit log
packages/bank            the mock payment rail — the enforcement point, verifies independently
packages/web             the console (:5173) — composes, never signs
packages/authenticator   the SEAL Authenticator (:5174) — holds the keys, the only thing that signs
packages/extension       MV3 browser extension — verify/sign media, pay and approve on WhatsApp Web
  build.mjs              esbuild bundle; Chrome loads dist/
scripts/simulate         the walkthrough and the attack suite
scripts/check-credential the device vault + signer, run headlessly
```

### Notable implementation choices

- **`node:sqlite`**, not Postgres. Node 22+ ships SQLite in core, so the whole stack runs with zero
  native dependencies and zero services to start. `UPDATE` and `DELETE` on `audit_chain` are revoked
  with `BEFORE UPDATE`/`BEFORE DELETE` triggers that `RAISE(ABORT)` — the "no writes at the DB role
  level" rule from the design, expressed with the strongest thing SQLite offers.
- **Timestamp sweeper**, not BullMQ. Expiry is derived from `expires_at` on every sweep rather than
  from a timer held in memory, so a restart cannot lose a countdown. An escrow that timed out while
  the process was down expires on the first sweep after boot, with its real expiry time intact. Same
  durability guarantee, no Redis.
- **Ed25519 via `@noble/ed25519`** on all sides, so the device, the server and the rail run
  byte-identical verification code.
- **The software signature covers the whole assertion**, not a bare hash: domain, purpose, credential
  id, custody tier, counter, presence flag and timestamp are all inside it. An `INTENT` signature
  therefore cannot be replayed as an `APPROVAL`, and the custody tier cannot be upgraded in transit.
- **Two Vite apps on two ports** rather than two routes in one. Separate origins mean separate
  `localStorage` and separate WebAuthn scoping — the isolation is real, not a convention.

---

## The holes this design usually leaves, and what happens here

**Key enrolment.** The model rests on knowing the CFO's public key, so the cheapest attack is not
forging a signature — it is registering a *new* key for the CFO. Enrolment here needs proof of
possession from the new key **and** a quorum of approvals from keys already trusted. Each of those
approvals is itself a signature, raised as a signing request and signed on the approver's own device
over the exact public key being admitted. A hijacked session cannot admit a key.

**The bootstrap ceremony.** With no active credentials there is nobody who can approve the first one.
The first two executive credentials therefore self-activate — and are stamped `BOOTSTRAP_CEREMONY` in
the audit chain and shown as such in both UIs. A real, bounded weakness, named rather than hidden.

**Replay.** Four mechanisms together: a per-intent `nonce` burned in `consumed_nonces`, bounded
`iat`/`exp` validity, a monotonic per-credential signature counter (from the signed assertion for
software keys, from the authenticator's own signed data for hardware), and the rail's independent
settled-nonce ledger.

**Session auth is deliberately weak** — a token map in memory, seeded passwords — and it barely
matters, which is the thesis. A stolen session cannot produce a signature. It can raise a signing
request, and that request lands on the real person's device showing the real fields.

### Honest limitations

- A **coerced executive under duress** will authorize a valid transaction. Duress credentials that
  sign-and-flag are future work.
- **Collusion between two approvers** defeats the quorum. Mitigation is a higher `n` at the top tier
  plus post-hoc review.
- **A compromised authenticator device** holding a software key can still be drained: the vault is
  copyable and the passphrase is typeable. That is exactly why the hardware tier exists, and why the
  risk engine still charges a premium for software keys.
- **Prompt fatigue is the real attack on this design.** If a compromised console can spam
  signature requests or caller challenges, the twentieth one gets waved through. Requests that
  could never succeed are refused before they are pushed, but rate limiting and per-device
  request budgets are not built yet.
- **A caller challenge only helps if someone raises one.** It is one click from every screen where
  pressure lands, and raising one is free and consequence-less by design — but a person who never
  asks is not protected by it. Training and the always-visible button are the mitigation; there is
  no technical one.
- **The extension's badge is a text match**, so it has false positives and false negatives. That is
  why it never blocks anything and never says "this is fake" — it only ever offers a check.
- **Denying a call needs only a session, not a key.** A deliberate asymmetry: denial only ever
  *stops* things, and making an alarmed person perform a crypto ceremony costs minutes exactly
  when minutes matter. The worst a hijacked session achieves is voiding a payment that must then
  be raised again.
- **Adoption is the real barrier.** This only works where it is enforced at the rail. A partial
  rollout leaves the old path open.
- **Lost authenticators need a recovery path**, and every recovery path is an attack surface. It must
  be quorum-gated like enrolment.

---

## Demo script

1. **Setup.** On the Authenticator, enrol Priya (CFO), Rahul (CEO) and Anita (CTO). Show the first
   two activating under the bootstrap ceremony and the third waiting for two signed approvals — then
   give those approvals from the other two devices.
2. **The happy path.** On the console, Priya composes a ₹42,00,000 vendor payment and presses *Send
   to my device*. The console says "waiting for your device". The phone lights up with the payee and
   the amount. Approve. The employee accepts — fields are locked. Rahul and Anita approve on their
   own devices; the countdown is live on every screen. The rail settles it.
3. **The attack.** Play the cloned-voice call demanding an urgent transfer to a different account.
   Let it be convincing.
4. **The kill, three ways over.**
   - The employee opens the console: the queue is empty, and there is no field in which to type
     the mule account.
   - Pretend the console itself is compromised: compose the fraudulent payment as the CFO and
     watch it appear on the real CFO's phone showing an unfamiliar payee and *"this account has
     never been paid before"*. Decline it.
   - Now the hard case. Let a real escrow exist and have "the CFO" talk the CEO through approving
     it. The CEO clicks **Verify a caller**, reads out a six-character code, and the fake cannot
     repeat it. Meanwhile the real CFO's phone asks *"are you on a video call with Rahul right
     now?"* — she taps **No — that is not me**, the escrow voids on every screen at once, and the
     next payment she originates comes up CRITICAL.
5. **The receipt.** Open the Audit tab, hit *Recompute chain*, and show the blocked attempts already
   recorded with their custody tier, their origin lane and the rules that fired.

Run `npm run sim` alongside it to show the same story with every attack asserted.

Set `SEAL_DEMO_WINDOW_SECONDS=25 npm run dev` to shrink every escrow window so the expiry path can be
shown live. It only ever shortens a window, it is written into the audit chain on every escrow it
touches, and the console shows a red badge saying so.

---

Close on the line that frames the project: **the deepfake was perfect, and it didn't matter.**
