import { useEffect, useState } from 'react';
import { api, useApi } from '../api.js';
import {
  forgetHardware,
  hashOf,
  loadHardware,
  localCredentials,
  registerHardwareCredential,
  saveHardware,
  vault,
} from '../lib/device.js';
import { platformAuthenticatorAvailable } from '@seal/shared/hardware';
import { Admissions, type Enrollment } from './Admissions.js';
import type { Session } from './SignIn.js';

interface Me {
  id: string;
  credentials: Array<{
    credential_id: string;
    binding: string;
    device_kind: string;
    state: string;
    counter: number;
    label: string | null;
    aaguid: string | null;
  }>;
}

/**
 * Enrolment on the device that will hold the key.
 *
 * Two tiers are offered here and the difference between them is stated plainly,
 * because an executive choosing between them should know what they are picking:
 * a passphrase-sealed key that malware on this device could eventually copy, or
 * a hardware credential that nothing can copy at all.
 */
export function Enrol({
  session,
  bump,
  onChanged,
}: {
  session: Session;
  bump: number;
  onChanged: () => void;
}) {
  const { data: me } = useApi<Me>('/api/me', bump);
  const { data: enrollments } = useApi<Enrollment[]>('/api/credentials/enrollments', bump);
  const [hasPlatform, setHasPlatform] = useState(false);
  const [busy, setBusy] = useState<null | 'software' | 'hardware'>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pass1, setPass1] = useState('');
  const [pass2, setPass2] = useState('');

  useEffect(() => {
    void platformAuthenticatorAvailable().then(setHasPlatform);
  }, []);

  const credentials = localCredentials(session.id);
  const swVault = vault.load(session.id);
  const hw = loadHardware(session.id);
  const serverState = (id: string) =>
    me?.credentials.find((c) => c.credential_id === id)?.state ?? 'not on server';

  /**
   * PENDING on its own is a dead end: it tells you nothing about what is
   * missing or who can supply it. This looks up the actual request so the card
   * can say "0 of 2, and here is who can sign".
   */
  const requestFor = (credentialId: string) =>
    (enrollments ?? []).find((e) => e.credential_id === credentialId && e.state === 'PENDING');

  /**
   * Retire a key properly.
   *
   * Clearing local storage alone used to leave the server still trusting the
   * credential -- so a key you believed was gone could still authorize, and the
   * authenticator refused to register again because the server still listed it
   * ("The authenticator was previously registered"). The server call has to
   * come first, and local state is only wiped once it succeeds.
   */
  const retire = async (credentialId: string, kind: 'hardware' | 'software') => {
    const label =
      kind === 'hardware'
        ? 'Retire this hardware key? It will stop being able to authorize anything, and you can enrol the same authenticator again afterwards.'
        : 'Destroy this key? It cannot be recovered, and it will stop being able to authorize anything.';
    if (!confirm(label)) return;

    setError(null);
    setNote(null);
    try {
      await api(`/api/credentials/${credentialId}/revoke`, {
        body: { reason: 'Retired from the Authenticator' },
      });
      if (kind === 'hardware') forgetHardware(session.id);
      else vault.forget(session.id);
      setNote('Key retired. It can no longer authorize anything, and the payment rail has been told.');
      onChanged();
    } catch (e) {
      setError(
        `Could not retire the key on the server, so nothing was deleted here either: ${(e as Error).message}`,
      );
    }
  };

  const describe = (result: { bootstrap_ceremony: boolean; required_approvals: number }) =>
    result.bootstrap_ceremony
      ? 'Activated under the bootstrap ceremony: fewer than two executive keys existed, so there was nobody who could approve this one. It is stamped BOOTSTRAP_CEREMONY in the audit chain.'
      : `Enrolled. It stays inactive until ${result.required_approvals} other executive(s) sign an approval admitting it.`;

  const enrolSoftware = async () => {
    setError(null);
    setNote(null);
    if (pass1.length < 4) return setError('Choose a passphrase of at least 4 characters.');
    if (pass1 !== pass2) return setError('The two passphrases do not match.');
    setBusy('software');
    try {
      const created = await vault.create({
        userId: session.id,
        passphrase: pass1,
        label: `${session.name.split(' ')[0]}'s authenticator`,
      });
      const begun = await api<{ challenge: string }>('/api/credentials/enroll/begin', {
        body: { device_kind: 'authenticator' },
      });
      const payload = {
        v: 1,
        type: 'enrollment',
        user_id: session.id,
        public_key: created.public_key,
        challenge: begun.challenge,
      };
      const proof = await vault.sign(session.id, 'ENROLLMENT', await hashOf(payload), pass1);

      const out = await api<{ bootstrap_ceremony: boolean; required_approvals: number }>(
        '/api/credentials/enroll/finish',
        {
          body: {
            device_kind: 'authenticator',
            public_key: created.public_key,
            label: created.label,
            proof,
          },
        },
      );
      setPass1('');
      setPass2('');
      setNote(describe(out));
      onChanged();
    } catch (e) {
      vault.forget(session.id);
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const enrolHardware = async () => {
    setError(null);
    setNote(null);
    setBusy('hardware');
    try {
      const begun = await api<{ options: { challenge: string } }>('/api/credentials/enroll/begin', {
        body: { device_kind: 'hardware' },
      });
      // The key is created inside the authenticator. Nothing here ever sees it.
      const registration = await registerHardwareCredential(begun.options);
      const out = await api<{
        credential_id: string;
        bootstrap_ceremony: boolean;
        required_approvals: number;
      }>('/api/credentials/enroll/finish', {
        body: {
          device_kind: 'hardware',
          registration,
          label: `${session.name.split(' ')[0]}'s security key`,
        },
      });

      const params = await api<{ rp_id: string }>('/api/webauthn/params');
      saveHardware(session.id, {
        credential_id: out.credential_id,
        webauthn_id: registration.id,
        rp_id: params.rp_id,
      });
      setNote(describe(out));
      onChanged();
    } catch (e) {
      const msg = (e as Error).message;
      setError(
        /NotAllowed|abort/i.test(msg)
          ? 'The authenticator was dismissed. Nothing was enrolled.'
          : msg,
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <h1>This device</h1>
      <p>
        Keys live here and nowhere else. The server stores a public key; the console stores nothing
        at all.
      </p>

      {note ? (
        <div className="banner ok">
          <div className="big">Enrolled</div>
          <p>{note}</p>
        </div>
      ) : null}
      {error ? (
        <div className="banner bad">
          <div className="big">That did not work</div>
          <p>{error}</p>
        </div>
      ) : null}

      {credentials.length === 0 ? (
        <div className="banner warn">
          <div className="big">No key on this device yet</div>
          <p>
            Until you enrol one, requests will arrive but you will not be able to authorize
            anything.
          </p>
        </div>
      ) : null}

      {hw ? (
        <div className="card">
          <div className="row">
            <span className="badge ok">hardware-bound key</span>
            <div className="spacer" />
            <span className="badge">{serverState(hw.credential_id)}</span>
          </div>
          <PendingNote request={requestFor(hw.credential_id)} />
          <dl className="facts">
            <dt>Credential</dt>
            <dd className="mono">{hw.credential_id}</dd>
            <dt>Custody</dt>
            <dd>Inside the authenticator. It cannot be exported, copied or read by software.</dd>
            <dt>Signatures</dt>
            <dd className="mono">
              {me?.credentials.find((c) => c.credential_id === hw.credential_id)?.counter ?? 0}
            </dd>
          </dl>
          <button className="btn danger sm" onClick={() => retire(hw.credential_id, 'hardware')}>
            Retire this key
          </button>
        </div>
      ) : (
        <div className="card">
          <div className="row" style={{ marginBottom: 8 }}>
            <span className="badge ok">strongest</span>
            <span className="dim" style={{ fontSize: 12 }}>
              recommended for executives
            </span>
          </div>
          <h2>Hardware security key</h2>
          <p style={{ marginTop: 0 }}>
            Windows Hello, Touch ID, or a physical key. The private key is generated inside the
            authenticator and cannot leave it, and every signature needs a real gesture — a
            fingerprint, a face, a touch — that malware cannot perform on your behalf.
          </p>
          {!hasPlatform ? (
            <p className="dim" style={{ fontSize: 13 }}>
              No built-in authenticator detected on this device. A plugged-in security key will
              still work.
            </p>
          ) : null}
          <button className="btn good" onClick={enrolHardware} disabled={busy !== null}>
            {busy === 'hardware' ? 'Waiting for the authenticator…' : 'Enrol a hardware key'}
          </button>
        </div>
      )}

      {swVault ? (
        <div className="card">
          <div className="row">
            <span className="badge warn">software key · this app</span>
            <div className="spacer" />
            <span className="badge">{serverState(swVault.credential_id)}</span>
          </div>
          <PendingNote request={requestFor(swVault.credential_id)} />
          <dl className="facts">
            <dt>Credential</dt>
            <dd className="mono">{swVault.credential_id}</dd>
            <dt>Custody</dt>
            <dd>
              Sealed with AES-GCM under your passphrase, on this device only. Out of reach of the
              console — but malware running here could eventually copy it.
            </dd>
            <dt>Signatures</dt>
            <dd className="mono">{swVault.counter}</dd>
          </dl>
          <button
            className="btn danger sm"
            onClick={() => retire(swVault.credential_id, 'software')}
          >
            Destroy this key
          </button>
        </div>
      ) : (
        <div className="card">
          <div className="row" style={{ marginBottom: 8 }}>
            <span className="badge warn">good</span>
            <span className="dim" style={{ fontSize: 12 }}>
              works on any device
            </span>
          </div>
          <h2>Software key on this app</h2>
          <p style={{ marginTop: 0 }}>
            Generated here and sealed with a passphrase you type for every signature. It is out of
            band from the console, which is what matters most — but unlike a hardware key it is
            ultimately copyable, so the risk engine still charges a small premium for it.
          </p>
          <label className="field">
            <span className="lbl">Passphrase</span>
            <input type="password" value={pass1} onChange={(e) => setPass1(e.target.value)} />
          </label>
          <label className="field">
            <span className="lbl">Passphrase again</span>
            <input
              type="password"
              value={pass2}
              onChange={(e) => setPass2(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && enrolSoftware()}
            />
          </label>
          <button className="btn" onClick={enrolSoftware} disabled={busy !== null}>
            {busy === 'software' ? 'Generating…' : 'Enrol a software key'}
          </button>
        </div>
      )}

      <Admissions
        session={session}
        enrollments={enrollments ?? []}
        onChanged={onChanged}
      />

      <div className="banner info">
        <div className="big">Why not just keep the key on the console?</div>
        <p>
          Because then one compromised laptop could both write a payment and authorize it. Keeping
          the key here means an attacker who owns the console still cannot move money — they have to
          convince you, looking at the real payee and the real amount, to press approve.
        </p>
      </div>
    </>
  );
}

/**
 * What a PENDING key is actually waiting for.
 *
 * Registering a new key for an executive is the cheapest attack on this
 * whole design -- far cheaper than forging a signature -- so a new key is
 * admitted only by a quorum of people who already hold one. That is worth
 * saying out loud at the moment somebody is looking at a badge that just
 * says PENDING and wondering what went wrong.
 */
function PendingNote({ request }: { request?: Enrollment }) {
  if (!request) return null;
  const remaining = Math.max(0, request.required_approvals - request.approvals);
  return (
    <div className="banner warn" style={{ marginTop: 10, marginBottom: 0 }}>
      <div className="big">
        Waiting for {remaining} more approval{remaining === 1 ? '' : 's'}
      </div>
      <p>
        {request.approvals} of {request.required_approvals} so far. Nothing is wrong — a new key
        can only be admitted by executives who already hold one, because registering a key for
        someone is easier than forging their signature. Ask another executive to open their
        Authenticator; your key will appear under “Keys awaiting your approval”.
      </p>
    </div>
  );
}
