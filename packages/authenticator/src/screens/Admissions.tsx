import { useState } from 'react';
import type { SigningRequest } from '@seal/shared';
import { api } from '../api.js';
import { localCredentials, signWith, type Credential } from '../lib/device.js';
import type { Session } from './SignIn.js';

const EXECUTIVE_ROLES = ['CFO', 'CEO', 'CTO', 'TREASURY'];

export interface Enrollment {
  id: string;
  user_id: string;
  name: string;
  role: string;
  credential_id: string;
  public_key: string;
  device_kind: string;
  state: string;
  required_approvals: number;
  approvals: number;
}

/**
 * Admitting somebody else's new key.
 *
 * This used to be reachable only from the console, which left anyone enrolling
 * a key staring at PENDING with nothing to do about it. The quorum is the point
 * of the ceremony, so the way to satisfy it has to be in the same place people
 * already are.
 *
 * One tap does both halves: raises the signing request and answers it with the
 * key on this device. They are still two separate acts on the server -- a
 * request that is chained, and a signature over the exact public key being
 * admitted -- so nothing is weakened by putting them behind one button.
 */
export function Admissions({
  session,
  enrollments,
  onChanged,
}: {
  session: Session;
  enrollments: Enrollment[];
  onChanged: () => void;
}) {
  const credentials = localCredentials(session.id);
  const pending = enrollments.filter(
    (e) =>
      e.state === 'PENDING' &&
      e.user_id !== session.id &&
      EXECUTIVE_ROLES.includes(session.role) &&
      credentials.length > 0,
  );

  if (pending.length === 0) return null;

  return (
    <>
      <h2 style={{ marginTop: 4 }}>Keys awaiting your approval</h2>
      {pending.map((e) => (
        <AdmissionCard
          key={e.id}
          enrollment={e}
          session={session}
          credentials={credentials}
          onChanged={onChanged}
        />
      ))}
    </>
  );
}

function AdmissionCard({
  enrollment,
  session,
  credentials,
  onChanged,
}: {
  enrollment: Enrollment;
  session: Session;
  credentials: Credential[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const credential = credentials[0];
  const needsPassphrase = credential?.kind === 'authenticator';

  const approve = async () => {
    setBusy(true);
    setError(null);
    try {
      // Raise the request, then answer it with this device's key.
      const request = await api<SigningRequest>(
        `/api/credentials/enrollments/${enrollment.id}/approve`,
        { body: {} },
      );
      const signature = await signWith(
        credential,
        session.id,
        'ENROLLMENT',
        request.payload_hash,
        needsPassphrase ? passphrase : undefined,
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

  return (
    <div className="card">
      <div className="row">
        <span className="badge warn">awaiting quorum</span>
        <div className="spacer" />
        <span className="mono">
          {enrollment.approvals}/{enrollment.required_approvals}
        </span>
      </div>

      <div style={{ marginTop: 10, fontWeight: 600, fontSize: 16 }}>
        {enrollment.name} <span className="dim">({enrollment.role})</span>
      </div>
      <p style={{ marginTop: 2 }}>
        wants to add a <b>{enrollment.device_kind}</b> key
      </p>

      <dl className="facts">
        <dt>Credential</dt>
        <dd className="mono">{enrollment.credential_id}</dd>
        <dt>Public key</dt>
        <dd className="mono">{enrollment.public_key.slice(0, 32)}…</dd>
      </dl>

      {/* The one question that matters. A key admitted by mistake is a key that
          can authorize payments, so the prompt asks about the human, not the
          hex. */}
      <div className="banner warn" style={{ marginBottom: 12 }}>
        <div className="big">Only approve if you know they set this up</div>
        <p>
          Admitting this key lets {enrollment.name.split(' ')[0]} authorize payments. If you did not
          expect this, do not approve it — check with them on a channel you already trust.
        </p>
      </div>

      {needsPassphrase ? (
        <label className="field">
          <span className="lbl">Passphrase</span>
          <input
            type="password"
            value={passphrase}
            onChange={(ev) => setPassphrase(ev.target.value)}
          />
        </label>
      ) : null}

      {error ? <p className="error">{error}</p> : null}

      <button
        className="btn good"
        onClick={approve}
        disabled={busy || (needsPassphrase && !passphrase)}
      >
        {busy ? 'Signing…' : 'Sign approval'}
      </button>
    </div>
  );
}
