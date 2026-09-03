import { useEffect, useState } from 'react';
import type { CallerAttestation, CallerChallenge } from '@seal/shared';
import { api } from '../api.js';
import { hashOf, localCredentials, signWith, type Credential } from '../lib/device.js';
import type { Session } from './SignIn.js';

const CHANNEL_LABEL: Record<string, string> = {
  PHONE: 'a phone call',
  VIDEO: 'a video call',
  MEETING: 'a meeting',
  EMAIL: 'an email',
  CHAT: 'a chat message',
  IN_PERSON: 'in person',
};

/**
 * "Is that really you?"
 *
 * This screen exists because a signature cannot help the person on the other
 * end of a convincing video call. Someone somewhere in the company is being
 * told, by a perfect copy of this executive's face and voice, to do something.
 * They have asked. Two things can happen here, and both are useful:
 *
 *   Deny  — one tap, no ceremony. Whoever is on that call is not this person,
 *           and everyone who needs to know finds out in the same second.
 *           Anything the call was pushing for stops.
 *
 *   Read  — the code below exists here and in exactly one other place: the
 *           screen of the person being pressured. Reading it aloud proves this
 *           is a real conversation. An impersonator has the face and the voice
 *           and cannot produce three letters and three digits.
 *
 * Deny is the larger, closer, more obvious button. If somebody is going to tap
 * the wrong one under pressure, it should be the safe one.
 */
export function Callers({
  session,
  challenges,
  onChanged,
}: {
  session: Session;
  challenges: CallerChallenge[];
  onChanged: () => void;
}) {
  const mine = challenges.filter((c) => c.claimed_user_id === session.id && c.state === 'PENDING');
  if (mine.length === 0) return null;

  return (
    <>
      {mine.map((c) => (
        <CallerCard key={c.id} challenge={c} session={session} onChanged={onChanged} />
      ))}
    </>
  );
}

function CallerCard({
  challenge,
  session,
  onChanged,
}: {
  challenge: CallerChallenge;
  session: Session;
  onChanged: () => void;
}) {
  const [left, setLeft] = useState(challenge.seconds_remaining);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [confirming, setConfirming] = useState(false);
  const credentials = localCredentials(session.id);
  const [credential, setCredential] = useState<Credential | undefined>(credentials[0]);

  useEffect(() => setLeft(challenge.seconds_remaining), [challenge.seconds_remaining]);
  useEffect(() => {
    const id = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, []);

  const deny = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/caller-challenges/${challenge.id}/deny`, {
        body: { note: 'Not me' },
      });
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!credential) return setError('No key on this device.');
    setBusy(true);
    setError(null);
    try {
      const attestation = await api<CallerAttestation>(
        `/api/caller-challenges/${challenge.id}/attestation`,
      );
      const signature = await signWith(
        credential,
        session.id,
        'ATTESTATION',
        await hashOf(attestation),
        credential.kind === 'authenticator' ? passphrase : undefined,
      );
      await api(`/api/caller-challenges/${challenge.id}/confirm`, { body: { signature } });
      setPassphrase('');
      setConfirming(false);
      onChanged();
    } catch (e) {
      const msg = (e as Error).message;
      setError(
        /NotAllowed|abort/i.test(msg) ? 'The authenticator was dismissed. Nothing was signed.' : msg,
      );
    } finally {
      setBusy(false);
    }
  };

  const mm = String(Math.floor(left / 60)).padStart(2, '0');
  const ss = String(left % 60).padStart(2, '0');

  return (
    <div className="card challenge">
      <div className="row">
        <span className="badge bad pulse">verify a caller</span>
        <div className="spacer" />
        <span className="countdown">
          {mm}:{ss}
        </span>
      </div>

      <h2 style={{ marginTop: 12, marginBottom: 4, fontSize: 19 }}>
        Are you on {CHANNEL_LABEL[challenge.channel] ?? 'a call'} with {challenge.raised_by_name}{' '}
        right now?
      </h2>

      <p style={{ marginTop: 0 }}>
        They say you are asking them to:
      </p>
      <blockquote className="demand">{challenge.demand}</blockquote>

      {/* Deny first, deny biggest. Under pressure the safe answer should be the
          one your thumb lands on. */}
      <button className="btn danger big" onClick={deny} disabled={busy}>
        No — that is not me
      </button>
      <p className="dim" style={{ fontSize: 12, marginTop: 8 }}>
        Tapping this stops whatever that call is pushing for, alerts security, and records it.
        Nothing bad happens if you are wrong — a genuine payment can be raised again in a minute.
      </p>

      <div className="divider">
        <span>or, if you really are on that call</span>
      </div>

      {!showCode ? (
        <button className="btn ghost" onClick={() => setShowCode(true)} disabled={busy}>
          Show the code to read back
        </button>
      ) : (
        <>
          <div className="code-box">
            <div className="code">{challenge.code}</div>
            <div className="dim" style={{ fontSize: 12 }}>
              Read this aloud to {challenge.raised_by_name}. It is on their screen too.
            </div>
          </div>
          <p className="dim" style={{ fontSize: 12 }}>
            Never type this into a chat, an email, or a website — only say it, on the call you are
            already on. Anyone who asks you to send it in writing is phishing you.
          </p>

          {!confirming ? (
            <button className="btn" onClick={() => setConfirming(true)} disabled={busy}>
              They read it back correctly — confirm it is me
            </button>
          ) : (
            <>
              {credentials.length > 1 ? (
                <label className="field">
                  <span className="lbl">Sign with</span>
                  <select
                    value={credential?.kind}
                    onChange={(e) =>
                      setCredential(credentials.find((c) => c.kind === e.target.value))
                    }
                  >
                    {credentials.map((c) => (
                      <option key={c.kind} value={c.kind}>
                        {c.kind === 'hardware' ? 'Hardware key' : 'Software key on this app'}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {credential?.kind === 'authenticator' ? (
                <label className="field">
                  <span className="lbl">Passphrase</span>
                  <input
                    type="password"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                  />
                </label>
              ) : null}
              <button
                className="btn good"
                onClick={confirm}
                disabled={busy || (credential?.kind === 'authenticator' && !passphrase)}
              >
                {busy ? 'Signing…' : 'Yes — that is me on the call'}
              </button>
              <p className="dim" style={{ fontSize: 12, marginTop: 8 }}>
                Confirming is signed with your key, so it cannot be faked by anyone who has only
                stolen your session. It vouches for the call — it still authorizes no payment.
              </p>
            </>
          )}
        </>
      )}

      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
