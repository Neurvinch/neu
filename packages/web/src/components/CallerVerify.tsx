import { useEffect, useState } from 'react';
import type { CallerChallenge, CallerChannel } from '@seal/shared';
import { api, useApi } from '../api.js';
import { Badge } from './ui.js';

const CHANNELS: Array<[CallerChannel, string]> = [
  ['VIDEO', 'Video call'],
  ['PHONE', 'Phone call'],
  ['MEETING', 'Online meeting'],
  ['CHAT', 'Chat / WhatsApp'],
  ['EMAIL', 'Email'],
  ['IN_PERSON', 'In person'],
];

interface Person {
  id: string;
  name: string;
  role: string;
}

/**
 * The panic path.
 *
 * Everything else in this system protects the transaction. This protects the
 * person — the employee or approver sitting in front of a screen while a
 * flawless copy of their CFO's face and voice tells them to hurry up.
 *
 * They are not asked to judge whether the video looks right. Nobody can do that
 * reliably and the problem statement says so. They are given a question the
 * fake cannot answer: a code that exists only on the real executive's enrolled
 * device. Read it back, or you are not who you say you are.
 *
 * Raising a challenge is deliberately free of consequence. It costs one click,
 * it never blocks legitimate work, and being wrong about it is fine. The only
 * expensive mistake available here is not asking.
 */
export function CallerVerify({
  open,
  onClose,
  context,
}: {
  open: boolean;
  onClose: () => void;
  context?: { txn_id?: string; escrow_id?: string; demand?: string };
}) {
  const { data: policy } = useApi<{ challengeable: Person[] }>(open ? '/api/policy' : null);
  const [claimed, setClaimed] = useState<string | null>(null);
  const [channel, setChannel] = useState<CallerChannel>('VIDEO');
  const [demand, setDemand] = useState(context?.demand ?? '');
  const [challenge, setChallenge] = useState<CallerChallenge | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setChallenge(null);
      setError(null);
      setDemand(context?.demand ?? '');
    }
  }, [open, context?.demand]);

  // Watch for the executive's answer.
  useEffect(() => {
    if (!challenge || challenge.state !== 'PENDING') return;
    const id = setInterval(async () => {
      try {
        const next = await api<CallerChallenge>(`/api/caller-challenges/${challenge.id}`);
        setChallenge(next);
      } catch {
        /* transient */
      }
    }, 1500);
    return () => clearInterval(id);
  }, [challenge]);

  if (!open) return null;

  const raise = async () => {
    if (!claimed) return;
    setBusy(true);
    setError(null);
    try {
      setChallenge(
        await api<CallerChallenge>('/api/caller-challenges', {
          body: {
            claimed_user_id: claimed,
            channel,
            demand: demand.trim() || 'Not stated',
            txn_id: context?.txn_id ?? null,
            escrow_id: context?.escrow_id ?? null,
          },
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        {!challenge ? (
          <>
            <h2>Someone is asking you to do something</h2>
            <p className="muted" style={{ marginTop: 0 }}>
              You are not going to be asked whether the video looks real. You are going to ask them
              something only the real person can answer.
            </p>

            <label className="field">
              <span className="lbl">Who do they claim to be?</span>
              <div className="people">
                {(policy?.challengeable ?? []).map((p) => (
                  <button
                    key={p.id}
                    className={`person ${claimed === p.id ? 'on' : ''}`}
                    onClick={() => setClaimed(p.id)}
                  >
                    <div>{p.name}</div>
                    <div className="r">{p.role}</div>
                  </button>
                ))}
              </div>
            </label>

            <label className="field">
              <span className="lbl">How did they reach you?</span>
              <select value={channel} onChange={(e) => setChannel(e.target.value as CallerChannel)}>
                {CHANNELS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span className="lbl">What are they asking for?</span>
              <input
                value={demand}
                onChange={(e) => setDemand(e.target.value)}
                placeholder="Wire 42L to a new account before the bank closes"
              />
            </label>

            {error ? <p className="error">{error}</p> : null}

            <div className="row">
              <button className="btn ghost" onClick={onClose}>
                Cancel
              </button>
              <div className="spacer" />
              <button className="btn primary" disabled={!claimed || busy} onClick={raise}>
                {busy ? 'Sending…' : 'Challenge this caller'}
              </button>
            </div>
          </>
        ) : (
          <Result challenge={challenge} onClose={onClose} />
        )}
      </div>
    </div>
  );
}

function Result({ challenge, onClose }: { challenge: CallerChallenge; onClose: () => void }) {
  const [left, setLeft] = useState(challenge.seconds_remaining);
  useEffect(() => setLeft(challenge.seconds_remaining), [challenge.seconds_remaining]);
  useEffect(() => {
    const id = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, []);

  if (challenge.state === 'DENIED') {
    return (
      <>
        <div className="banner bad">
          <div>
            <div className="big">THAT IS NOT {challenge.claimed_name.toUpperCase()}</div>
            <p>
              {challenge.claimed_name} has confirmed, from their own device, that they are not on
              this {challenge.channel.toLowerCase().replace('_', ' ')}. You are being impersonated
              at right now.
            </p>
          </div>
        </div>
        <p className="muted">
          End the call. Do not act on anything it asked for. Security has been alerted and anything
          this call was pushing for has been stopped. It is all in the audit chain.
        </p>
        <button className="btn danger" onClick={onClose}>
          Close and end the call
        </button>
      </>
    );
  }

  if (challenge.state === 'CONFIRMED') {
    return (
      <>
        <div className="banner ok">
          <div>
            <div className="big">CALLER VERIFIED</div>
            <p>
              {challenge.claimed_name} signed a confirmation on their enrolled device that they are
              on this call.
            </p>
          </div>
        </div>
        <p className="muted">
          That confirms who you are talking to. It does not authorize anything — a payment still
          needs a signed request, and a genuine executive will raise one from their own device
          rather than asking you to.
        </p>
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </>
    );
  }

  if (challenge.state === 'EXPIRED') {
    return (
      <>
        <div className="banner warn">
          <div>
            <div className="big">NO ANSWER</div>
            <p>
              {challenge.claimed_name} did not respond. Treat this caller as unverified.
            </p>
          </div>
        </div>
        <p className="muted">
          Silence is not a pass. Do not act on the request. Reach {challenge.claimed_name} on a
          number you already had — not one this caller gave you.
        </p>
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </>
    );
  }

  const mm = String(Math.floor(left / 60)).padStart(2, '0');
  const ss = String(left % 60).padStart(2, '0');

  return (
    <>
      <h2>Ask them to read this back</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        This code is on {challenge.claimed_name}&apos;s device and on your screen. Nowhere else.
      </p>

      <div className="code-box">
        <div className="code">{challenge.code}</div>
      </div>

      <p className="muted">
        Say out loud: <em>&ldquo;Before I do anything — open your SEAL app and read me the
        code.&rdquo;</em>
      </p>

      <div className="banner warn">
        <div>
          <div className="big">IF THEY CANNOT READ IT BACK, IT IS NOT THEM</div>
          <p>
            Excuses to expect: &ldquo;I&apos;m driving&rdquo;, &ldquo;my phone is dead&rdquo;,
            &ldquo;there&apos;s no time for this&rdquo;, &ldquo;just do it, I&apos;ll approve it
            after&rdquo;. A real executive will read six characters.
          </p>
        </div>
      </div>

      <div className="row">
        <Badge tone="warn">waiting for {challenge.claimed_name}</Badge>
        <div className="spacer" />
        <span className="mono">
          {mm}:{ss}
        </span>
      </div>

      <p className="dim" style={{ fontSize: 12 }}>
        {challenge.claimed_name} is also being asked, on their device, whether they are on this call
        at all — so this gets answered even if the caller stalls.
      </p>

      <button className="btn ghost" onClick={onClose} style={{ marginTop: 12 }}>
        Close
      </button>
    </>
  );
}
