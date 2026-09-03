import { useCallback, useEffect, useState } from 'react';
import type { SigningRequest } from '@seal/shared';
import { api, setToken, useApi, useEvents } from './api.js';
import { Enrol } from './screens/Enrol.js';
import { Requests } from './screens/Requests.js';
import { SignIn, type Session } from './screens/SignIn.js';
import { localCredentials } from './lib/device.js';

/**
 * SEAL Authenticator.
 *
 * The executive's signing device. It is a separate app on a separate origin
 * with a separate key store, and it is the only place in the system where a
 * signature can be produced. The console can compose a payment and ask; it
 * cannot sign, and nothing it does can make this app sign either.
 */
export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [bump, setBump] = useState(0);
  const [tab, setTab] = useState<'requests' | 'keys'>('requests');
  const refresh = useCallback(() => setBump((b) => b + 1), []);

  const { data: requests } = useApi<SigningRequest[]>(
    session ? '/api/signing-requests' : null,
    bump,
  );

  useEvents((type, data) => {
    const req = data as SigningRequest;
    // Only wake up for requests addressed to the person holding this device.
    if (!session || req?.subject_user_id === session.id || type === 'enrollment.changed') {
      refresh();
    }
  });

  const credentials = session ? localCredentials(session.id) : [];
  const pending = (requests ?? []).filter(
    (r) => r.state === 'PENDING' && r.subject_user_id === session?.id,
  );

  // A device with no key can do nothing useful, so send them straight to
  // enrolment rather than to an empty inbox.
  useEffect(() => {
    if (session && credentials.length === 0) setTab('keys');
  }, [session, credentials.length]);

  if (!session) return <SignIn onSignIn={setSession} />;

  return (
    <div className="phone">
      <header className="bar">
        <div className="mark">S</div>
        <div>
          <div style={{ fontWeight: 700, letterSpacing: '0.02em' }}>Authenticator</div>
          <div className="dim" style={{ fontSize: 11 }}>
            {credentials.length > 0 ? 'key on this device' : 'no key yet'}
          </div>
        </div>
        <div className="who">
          <div>{session.name}</div>
          <div className="dim">{session.role}</div>
        </div>
      </header>

      <div
        style={{
          padding: '6px 16px',
          background: 'rgba(56, 211, 159, 0.08)',
          borderBottom: '1px solid rgba(56, 211, 159, 0.25)',
          fontSize: 11,
          color: 'var(--ok, #38d39f)',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <span style={{ fontWeight: 700 }}>AUXILIARY SIGNING ORIGIN (:5174)</span>
        <span>·</span>
        <span style={{ color: 'var(--text-dim, #8a98b4)' }}>Out-of-band WebCrypto key vault</span>
      </div>

      <div className="row" style={{ padding: '10px 16px 0' }}>
        <button
          className={`btn sm ${tab === 'requests' ? 'primary' : 'ghost'}`}
          onClick={() => setTab('requests')}
        >
          Requests{pending.length > 0 ? ` (${pending.length})` : ''}
        </button>
        <button
          className={`btn sm ${tab === 'keys' ? 'primary' : 'ghost'}`}
          onClick={() => setTab('keys')}
        >
          This device
        </button>
        <div className="spacer" />
        <button
          className="btn sm ghost"
          onClick={async () => {
            await api('/api/session', { method: 'DELETE' }).catch(() => undefined);
            setToken(null);
            setSession(null);
          }}
        >
          Lock
        </button>
      </div>

      <main className="body">
        {tab === 'requests' ? (
          <Requests session={session} requests={requests ?? []} onChanged={refresh} />
        ) : (
          <Enrol session={session} bump={bump} onChanged={refresh} />
        )}
      </main>
    </div>
  );
}
