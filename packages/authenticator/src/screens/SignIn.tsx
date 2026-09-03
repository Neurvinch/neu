import { useState } from 'react';
import { api, setToken, useApi } from '../api.js';

export interface Session {
  id: string;
  name: string;
  role: string;
  limit_paise: number;
}

interface Person {
  id: string;
  name: string;
  role: string;
  credentials: number;
}

const SIGNING_ROLES = ['CFO', 'CEO', 'CTO', 'TREASURY'];

export function SignIn({ onSignIn }: { onSignIn: (s: Session) => void }) {
  const { data: people } = useApi<Person[]>('/api/users');
  const [picked, setPicked] = useState<string | null>(null);
  const [password, setPassword] = useState('demo');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      const out = await api<{ token: string; user: Session }>('/api/session', {
        body: { user_id: picked, password },
      });
      setToken(out.token);
      onSignIn(out.user);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Everyone can sign in, but only these roles ever receive signing requests.
  const signers = (people ?? []).filter((p) => SIGNING_ROLES.includes(p.role));
  const others = (people ?? []).filter((p) => !SIGNING_ROLES.includes(p.role));

  return (
    <div className="phone">
      <header className="bar">
        <div className="mark">S</div>
        <div>
          <div style={{ fontWeight: 700 }}>SEAL Authenticator</div>
          <div className="dim" style={{ fontSize: 11 }}>
            the device that holds the key
          </div>
        </div>
      </header>

      <main className="body">
        <h1>Whose device is this?</h1>
        <p>
          Set this up once, on the phone or laptop that stays with you. Payment requests composed on
          the console will arrive here for you to look at and authorize. Nothing signs without you.
        </p>

        <div className="people" style={{ marginBottom: 14 }}>
          {signers.map((p) => (
            <button
              key={p.id}
              className={`person ${picked === p.id ? 'on' : ''}`}
              onClick={() => setPicked(p.id)}
            >
              <div style={{ fontWeight: 600 }}>{p.name}</div>
              <div className="r">
                {p.role} · {p.credentials} key{p.credentials === 1 ? '' : 's'} enrolled
              </div>
            </button>
          ))}
        </div>

        {others.length > 0 ? (
          <details style={{ marginBottom: 14 }}>
            <summary className="dim" style={{ cursor: 'pointer', fontSize: 13 }}>
              Other staff
            </summary>
            <div className="people" style={{ marginTop: 8 }}>
              {others.map((p) => (
                <button
                  key={p.id}
                  className={`person ${picked === p.id ? 'on' : ''}`}
                  onClick={() => setPicked(p.id)}
                >
                  <div style={{ fontWeight: 600 }}>{p.name}</div>
                  <div className="r">{p.role}</div>
                </button>
              ))}
            </div>
          </details>
        ) : null}

        <label className="field">
          <span className="lbl">Demo password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </label>

        {error ? <p className="error">{error}</p> : null}

        <button className="btn primary" disabled={!picked || busy} onClick={submit}>
          {busy ? 'Unlocking…' : 'Set up this device'}
        </button>

        <div className="banner info" style={{ marginTop: 16 }}>
          <div className="big">Signing in is not authority</div>
          <p>
            A session lets you see requests. Authorizing one needs the key held on this device, and
            that key never leaves it — not to the console, not to the server.
          </p>
        </div>
      </main>
    </div>
  );
}
