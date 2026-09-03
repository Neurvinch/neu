import { useCallback, useMemo, useState } from 'react';
import { api, setToken, useApi, useEvents } from './api.js';
import { Login, type Session } from './screens/Login.js';
import { Devices } from './screens/Devices.js';
import { Compose } from './screens/Compose.js';
import { Queue } from './screens/Queue.js';
import { Approvals } from './screens/Approvals.js';
import { Audit } from './screens/Audit.js';
import { Console as RiskConsole } from './screens/Console.js';
import { VishingLab } from './screens/VishingLab.js';
import { Badge } from './components/ui.js';
import { vault } from './lib/vault.js';
import { playAttackBlocked, playSettlementChime } from './lib/sound.js';

type Tab = 'compose' | 'queue' | 'approvals' | 'devices' | 'audit' | 'console' | 'lab';

const TABS: Record<Tab, { label: string; roles: string[] }> = {
  compose: { label: 'Compose & sign', roles: ['CFO', 'CEO', 'TREASURY'] },
  queue: { label: 'Request queue', roles: ['EMPLOYEE', 'CFO', 'CEO', 'CTO', 'TREASURY'] },
  approvals: { label: 'Approvals', roles: ['CEO', 'CTO', 'TREASURY', 'CFO', 'SECOPS', 'AUDITOR'] },
  devices: { label: 'Devices', roles: ['*'] },
  lab: { label: 'Attack lab · Deepfake defense', roles: ['*'] },
  audit: { label: 'Audit', roles: ['*'] },
  console: { label: 'Risk console', roles: ['SECOPS', 'AUDITOR', 'CFO', 'CEO', 'CTO', 'TREASURY'] },
};

const DEFAULT_TAB: Record<string, Tab> = {
  CFO: 'compose',
  CEO: 'approvals',
  CTO: 'approvals',
  TREASURY: 'approvals',
  EMPLOYEE: 'queue',
  AUDITOR: 'audit',
  SECOPS: 'console',
};

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [tab, setTab] = useState<Tab>('devices');
  const [bump, setBump] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);
  const { data: policy } = useApi<{ demo_window_seconds: number | null }>(
    session ? '/api/policy' : null,
    bump,
  );

  const refresh = useCallback(() => setBump((b) => b + 1), []);

  // Everything re-reads from the server on any server-side change, so no two
  // screens can disagree about the state of an escrow.
  useEvents((type, data) => {
    refresh();
    const d = data as { txn_id?: string; failed_checks?: string[]; state?: string };
    if (type === 'escrow.expired') {
      setFlash(`Escrow voided — ${d.txn_id} timed out. Originator alerted.`);
      playAttackBlocked();
    }
    if (type === 'rail.refused') {
      setFlash(`Payment rail refused a bundle: ${d.failed_checks?.join(', ')}`);
      playAttackBlocked();
    }
    if (type === 'intent.rejected') {
      setFlash(`A request was refused (${d.txn_id ?? 'unknown'}).`);
      playAttackBlocked();
    }
    if (type === 'escrow.settled') {
      setFlash(`Payment settled on rail — ${d.txn_id}`);
      playSettlementChime();
    }
    if (type === 'signing.requested') setFlash('A signature request was pushed to an enrolled device.');
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => setFlash(null), 6000);
  });

  const tabs = useMemo(() => {
    if (!session) return [] as Tab[];
    return (Object.keys(TABS) as Tab[]).filter(
      (t) => TABS[t].roles.includes('*') || TABS[t].roles.includes(session.role),
    );
  }, [session]);

  const onLogin = (s: Session) => {
    setSession(s);
    setTab(DEFAULT_TAB[s.role] ?? 'devices');
  };

  if (!session) return <Login onLogin={onLogin} />;

  // A key in *this browser* is the weakest tier, so the header reports it as a
  // caution rather than as reassurance. Signing devices are listed on the
  // Devices tab, which reads them from the server.
  const consoleKey = !!vault.load(session.id);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          SEAL <small>Lane A · software-bound credentials</small>
        </div>
        {policy?.demo_window_seconds ? (
          <Badge tone="bad">demo: windows shortened to {policy.demo_window_seconds}s</Badge>
        ) : null}

        <nav className="tabs">
          {tabs.map((t) => (
            <button
              key={t}
              className={`tab ${tab === t ? 'active' : ''}`}
              onClick={() => setTab(t)}
            >
              {TABS[t].label}
            </button>
          ))}
        </nav>

        <div className="whoami">
          <div style={{ textAlign: 'right' }}>
            <div>{session.name}</div>
            <div className="dim" style={{ fontSize: 11, letterSpacing: '.08em' }}>
              {session.role}
            </div>
          </div>
          {consoleKey ? <Badge tone="bad">console key present</Badge> : null}
          <button
            className="btn sm ghost"
            onClick={async () => {
              await api('/api/session', { method: 'DELETE' }).catch(() => undefined);
              setToken(null);
              setSession(null);
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="main">
        {flash ? (
          <div className="banner warn" style={{ marginBottom: 16 }}>
            <div>
              <div className="big">{flash}</div>
            </div>
          </div>
        ) : null}

        {tab === 'compose' ? <Compose session={session} onSigned={refresh} /> : null}
        {tab === 'queue' ? <Queue session={session} bump={bump} onChanged={refresh} /> : null}
        {tab === 'approvals' ? (
          <Approvals session={session} bump={bump} onChanged={refresh} />
        ) : null}
        {tab === 'devices' ? <Devices session={session} bump={bump} /> : null}
        {tab === 'lab' ? (
          <VishingLab session={session} onNavigateTab={(t) => setTab(t as Tab)} />
        ) : null}
        {tab === 'audit' ? <Audit bump={bump} /> : null}
        {tab === 'console' ? <RiskConsole bump={bump} /> : null}
      </main>
    </div>
  );
}

let flashTimer: ReturnType<typeof setTimeout> | null = null;
