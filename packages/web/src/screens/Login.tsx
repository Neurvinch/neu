import { useState } from 'react';
import { api, setToken, useApi } from '../api.js';
import { Banner, Panel } from '../components/ui.js';

interface Person {
  id: string;
  name: string;
  role: string;
  credentials: number;
}

export interface Session {
  id: string;
  name: string;
  role: string;
  limit_paise: number;
}

export function Login({ onLogin }: { onLogin: (s: Session) => void }) {
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
      onLogin(out.user);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="box">
        <div className="brand" style={{ marginBottom: 18 }}>
          SEAL <small>Signed Executive Authorization Ledger · Lane A</small>
        </div>

        <Panel title="Who is at this device?">
          <p className="lede">
            Signing in gets you a session. It does not get you authority: an approval still needs a
            signature from a key held on this device, and this demo seeds no keys — every device
            enrols its own.
          </p>

          <div className="people">
            {(people ?? []).map((p) => (
              <button
                key={p.id}
                className={`person ${picked === p.id ? 'on' : ''}`}
                onClick={() => setPicked(p.id)}
              >
                <div>{p.name}</div>
                <div className="r">
                  {p.role} · {p.credentials} key{p.credentials === 1 ? '' : 's'}
                </div>
              </button>
            ))}
          </div>

          <label className="field" style={{ marginTop: 16 }}>
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
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </Panel>

        <Banner tone="info" title="Every seeded account uses the password “demo”">
          Session auth is deliberately the weakest part of this system. A stolen session cannot
          produce an intent signature or an approval signature, so the worst it can do is move a
          genuine request one step along a path that still requires a quorum of keys.
        </Banner>
      </div>
    </div>
  );
}
