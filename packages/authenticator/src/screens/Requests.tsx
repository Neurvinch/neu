import { useEffect, useState } from 'react';
import type { SigningRequest } from '@seal/shared';
import { api } from '../api.js';
import { localCredentials, signWith, type Credential } from '../lib/device.js';
import type { Session } from './SignIn.js';

/**
 * The inbox, and the only screen in the system where a signature is produced.
 *
 * Everything shown here is rendered from the payload that was hashed when the
 * request was raised -- never from a summary the console typed alongside it.
 * The hash under each request is the hash the signature covers and the hash the
 * payment rail will check, which is what makes "what you see is what you sign"
 * a fact rather than a slogan.
 */
export function Requests({
  session,
  requests,
  onChanged,
}: {
  session: Session;
  requests: SigningRequest[];
  onChanged: () => void;
}) {
  const mine = requests.filter((r) => r.subject_user_id === session.id);
  const pending = mine.filter((r) => r.state === 'PENDING');
  const recent = mine.filter((r) => r.state !== 'PENDING').slice(0, 6);
  const credentials = localCredentials(session.id);

  if (credentials.length === 0) {
    return (
      <>
        <h1>Requests</h1>
        <div className="banner warn">
          <div className="big">No key on this device</div>
          <p>Enrol one under “This device” before you can authorize anything.</p>
        </div>
      </>
    );
  }

  return (
    <>
      <h1>Requests</h1>
      <p>
        {pending.length === 0
          ? 'Nothing is waiting for you.'
          : `${pending.length} request${pending.length === 1 ? '' : 's'} waiting for your approval.`}
      </p>

      {pending.length === 0 ? (
        <div className="empty">
          <div style={{ fontSize: 26, marginBottom: 8 }}>✓</div>
          Nothing to authorize.
          <div style={{ marginTop: 10, fontSize: 13 }}>
            If someone is on the phone insisting a payment is urgent, this empty screen is the
            answer. Nothing reaches your key except through here.
          </div>
        </div>
      ) : (
        pending.map((r) => (
          <RequestCard
            key={r.id}
            request={r}
            session={session}
            credentials={credentials}
            onChanged={onChanged}
          />
        ))
      )}

      {recent.length > 0 ? (
        <>
          <h2 style={{ marginTop: 22 }}>Recently</h2>
          {recent.map((r) => (
            <div className="card dead" key={r.id}>
              <div className="row">
                <span
                  className={`badge ${
                    r.state === 'SIGNED' ? 'ok' : r.state === 'DECLINED' ? 'bad' : ''
                  }`}
                >
                  {r.state}
                </span>
                <div className="spacer" />
                <span className="dim" style={{ fontSize: 12 }}>
                  {new Date(r.resolved_at ?? r.created_at).toLocaleTimeString()}
                </span>
              </div>
              <div style={{ marginTop: 6, fontWeight: 600 }}>{r.title}</div>
              <div className="dim" style={{ fontSize: 12 }}>
                {r.subtitle}
              </div>
              {r.error ? (
                <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>
                  {r.error}
                </div>
              ) : null}
            </div>
          ))}
        </>
      ) : null}
    </>
  );
}

function RequestCard({
  request,
  session,
  credentials,
  onChanged,
}: {
  request: SigningRequest;
  session: Session;
  credentials: Credential[];
  onChanged: () => void;
}) {
  const [left, setLeft] = useState(request.seconds_remaining);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState('');
  // Strongest custody first: if a hardware key is present it is the default.
  const [credential, setCredential] = useState<Credential>(credentials[0]);

  useEffect(() => setLeft(request.seconds_remaining), [request.seconds_remaining]);
  useEffect(() => {
    const id = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, []);

  const amountRow = request.rows.find(([k]) => k === 'Amount');
  const payeeRow = request.rows.find(([k]) => k === 'Payee');
  const rest = request.rows.filter(([k]) => k !== 'Amount' && k !== 'Payee');

  const authorize = async () => {
    setBusy(true);
    setError(null);
    try {
      const signature = await signWith(
        credential,
        session.id,
        request.purpose,
        request.payload_hash,
        credential.kind === 'authenticator' ? passphrase : undefined,
      );
      await api(`/api/signing-requests/${request.id}/fulfil`, { body: { signature } });
      setPassphrase('');
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

  const decline = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/signing-requests/${request.id}/decline`, {
        body: { reason: 'Declined on the enrolled device' },
      });
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const mm = String(Math.floor(left / 60)).padStart(2, '0');
  const ss = String(left % 60).padStart(2, '0');

  return (
    <div className="card request">
      <div className="row">
        <span className="badge warn pulse">awaiting you</span>
        <div className="spacer" />
        <span className="countdown">
          {mm}:{ss}
        </span>
      </div>

      <h2 style={{ marginTop: 12, marginBottom: 2 }}>{request.title}</h2>
      <div className="dim" style={{ fontSize: 12, marginBottom: 10 }}>
        {request.subtitle}
      </div>

      {amountRow ? <div className="headline">{amountRow[1]}</div> : null}
      {payeeRow ? <div className="payee">to {payeeRow[1]}</div> : null}

      <dl className="facts">
        {rest.map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt>{k}</dt>
            <dd className={k === 'Intent hash' || k === 'Public key' ? 'mono' : undefined}>{v}</dd>
          </div>
        ))}
      </dl>

      <div className="banner info" style={{ marginBottom: 0 }}>
        <div className="big">Did you ask for this?</div>
        <p>
          If this arrived because someone called, emailed or messaged you asking for it — decline.
          A real request is one you started yourself, on the console, moments ago.
        </p>
      </div>

      {credentials.length > 1 ? (
        <label className="field" style={{ marginTop: 14 }}>
          <span className="lbl">Sign with</span>
          <select
            value={credential.kind}
            onChange={(e) =>
              setCredential(credentials.find((c) => c.kind === e.target.value) ?? credentials[0])
            }
          >
            {credentials.map((c) => (
              <option key={c.kind} value={c.kind}>
                {c.kind === 'hardware' ? 'Hardware key (strongest)' : 'Software key on this app'}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {credential.kind === 'authenticator' ? (
        <label className="field" style={{ marginTop: 14 }}>
          <span className="lbl">Passphrase</span>
          <input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="unlocks the key for this one signature"
          />
        </label>
      ) : (
        <p className="dim" style={{ fontSize: 13, marginTop: 14 }}>
          Your authenticator will ask for a fingerprint, face or touch. The key never leaves it.
        </p>
      )}

      {error ? <p className="error">{error}</p> : null}

      <div className="hashline">signing hash {request.payload_hash}</div>

      <div className="actions">
        <button
          className="btn good"
          disabled={busy || left === 0 || (credential.kind === 'authenticator' && !passphrase)}
          onClick={authorize}
        >
          {busy ? 'Signing…' : 'Authorize'}
        </button>
        <button className="btn danger" disabled={busy} onClick={decline}>
          I did not ask for this — decline
        </button>
      </div>
    </div>
  );
}
