import { useState } from 'react';
import type { DeviceKind, SigningRequest } from '@seal/shared';
import { api, useApi } from '../api.js';
import { Badge, Banner, CustodyBadge, Empty, Hash, Panel } from '../components/ui.js';
import { AwaitingDevice } from '../components/AwaitingDevice.js';
import { hashOf, vault } from '../lib/vault.js';
import type { Session } from './Login.js';

const AUTHENTICATOR_URL = import.meta.env.VITE_AUTHENTICATOR_URL ?? 'http://localhost:5174';

interface Enrollment {
  id: string;
  user_id: string;
  name: string;
  role: string;
  credential_id: string;
  public_key: string;
  binding: string;
  device_kind: DeviceKind;
  state: string;
  credential_state: string;
  required_approvals: number;
  approvals: number;
  approvers: Array<{ approver_id: string; at: string }>;
  created_at: string;
}

interface Me {
  id: string;
  credentials: Array<{
    credential_id: string;
    binding: string;
    device_kind: DeviceKind;
    state: string;
    counter: number;
    label: string | null;
  }>;
}

const EXECUTIVE_ROLES = ['CFO', 'CEO', 'CTO', 'TREASURY'];

/**
 * The key ceremony, seen from the console.
 *
 * This is the most attacked surface in the design and the one most systems
 * leave open: if registering a new key for the CFO is easy, nobody needs to
 * forge a signature. So enrolment needs proof of possession from the new key
 * AND a quorum of signed approvals from keys already trusted -- and those
 * approvals are themselves signed on the approver's own device.
 */
export function Devices({ session, bump }: { session: Session; bump: number }) {
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);
  const dep = `${bump}:${tick}`;

  const { data: me } = useApi<Me>('/api/me', dep);
  const { data: enrollments } = useApi<Enrollment[]>('/api/credentials/enrollments', dep);
  const [pendingRequest, setPendingRequest] = useState<SigningRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pass1, setPass1] = useState('');
  const [pass2, setPass2] = useState('');

  const isExecutive = EXECUTIVE_ROLES.includes(session.role);
  const consoleVault = vault.load(session.id);
  const serverCredentials = me?.credentials ?? [];
  const onDevice = serverCredentials.filter((c) => c.device_kind !== 'console');

  const enrolConsoleKey = async () => {
    setError(null);
    setNote(null);
    if (pass1.length < 4) return setError('Choose a passphrase of at least 4 characters.');
    if (pass1 !== pass2) return setError('The two passphrases do not match.');
    setBusy(true);
    try {
      const created = await vault.create({
        userId: session.id,
        passphrase: pass1,
        label: `${session.name.split(' ')[0]}'s console`,
      });
      const begun = await api<{ challenge: string }>('/api/credentials/enroll/begin', {
        body: { device_kind: 'console' },
      });
      const payload = {
        v: 1,
        type: 'enrollment',
        user_id: session.id,
        public_key: created.public_key,
        challenge: begun.challenge,
      };
      const proof = await vault.sign(session.id, 'ENROLLMENT', await hashOf(payload), pass1);
      const out = await api<{ required_approvals: number; bootstrap_ceremony: boolean }>(
        '/api/credentials/enroll/finish',
        {
          body: {
            device_kind: 'console',
            public_key: created.public_key,
            label: created.label,
            proof,
          },
        },
      );
      setPass1('');
      setPass2('');
      setNote(
        out.bootstrap_ceremony
          ? 'Activated under the bootstrap ceremony.'
          : `Enrolled, awaiting ${out.required_approvals} signed approval(s).`,
      );
      refresh();
    } catch (e) {
      vault.forget(session.id);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const approve = async (row: Enrollment) => {
    setError(null);
    try {
      const request = await api<SigningRequest>(
        `/api/credentials/enrollments/${row.id}/approve`,
        { body: {} },
      );
      setPendingRequest(request);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const pending = (enrollments ?? []).filter((e) => e.state === 'PENDING');

  return (
    <>
      <h1>Devices &amp; credentials</h1>
      <p className="lede">
        Authority in this system comes from a key, so this is where authority is granted — and where
        it is deliberately kept out of reach of this browser.
      </p>

      {pendingRequest ? (
        <AwaitingDevice
          request={pendingRequest}
          onResolved={() => refresh()}
          onDismiss={() => setPendingRequest(null)}
        />
      ) : null}
      {error ? (
        <Banner tone="bad" title="That did not go through">
          {error}
        </Banner>
      ) : null}

      <div className="grid-2">
        <Panel title="Your signing devices">
          {onDevice.length > 0 ? (
            <>
              <Banner tone="ok" title="You can authorize payments">
                Your keys live off this machine. The console can compose a request; only these can
                authorize it.
              </Banner>
              <table>
                <thead>
                  <tr>
                    <th>Credential</th>
                    <th>Custody</th>
                    <th>State</th>
                    <th>Signatures</th>
                  </tr>
                </thead>
                <tbody>
                  {onDevice.map((c) => (
                    <tr key={c.credential_id}>
                      <td>
                        <Hash value={c.credential_id} chars={14} />
                        <div className="dim">{c.label}</div>
                      </td>
                      <td>
                        <CustodyBadge kind={c.device_kind} />
                      </td>
                      <td>
                        <Badge tone={c.state === 'ACTIVE' ? 'ok' : 'warn'}>{c.state}</Badge>
                      </td>
                      <td className="mono">{c.counter}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <>
              <Banner tone="warn" title="No signing device enrolled">
                You cannot originate or approve a payment until you enrol a key on a device that is
                not this browser.
              </Banner>
              <p className="muted">
                Open the SEAL Authenticator on your phone or a second window, sign in as yourself,
                and enrol either a hardware key or a passphrase-sealed key there.
              </p>
              <a className="btn primary" href={AUTHENTICATOR_URL} target="_blank" rel="noreferrer">
                Open SEAL Authenticator ↗
              </a>
            </>
          )}

          {isExecutive ? (
            <p className="dim" style={{ fontSize: 12, marginTop: 14 }}>
              As {session.role}, you may not hold a signing key in this browser at all. A key here
              would let one compromised machine both write a payment and authorize it, and the
              server refuses such signatures outright.
            </p>
          ) : null}
        </Panel>

        <Panel
          title="Enrolment requests"
          aside={pending.length ? <Badge tone="warn">{pending.length} awaiting quorum</Badge> : null}
        >
          <p className="muted" style={{ marginTop: 0 }}>
            Admitting a key needs the same quorum as a large payment, and each approval is itself
            signed on the approver's own device. Otherwise the cheapest attack is not forging a
            signature — it is registering a new key for the CFO.
          </p>

          {(enrollments ?? []).length === 0 ? (
            <Empty>No enrolments yet.</Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Subject</th>
                  <th>Credential</th>
                  <th>Approvals</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(enrollments ?? []).map((row) => (
                  <tr key={row.id}>
                    <td>
                      {row.name}
                      <div className="dim">{row.role}</div>
                    </td>
                    <td>
                      <Hash value={row.credential_id} chars={12} />
                      <div style={{ marginTop: 4 }}>
                        <CustodyBadge kind={row.device_kind} />
                      </div>
                    </td>
                    <td>
                      {row.state === 'APPROVED' ? (
                        <Badge tone="ok">
                          {row.required_approvals === 0 ? 'bootstrap' : 'admitted'}
                        </Badge>
                      ) : (
                        <span className="mono">
                          {row.approvals} / {row.required_approvals}
                        </span>
                      )}
                    </td>
                    <td>
                      {row.state === 'PENDING' &&
                      row.user_id !== session.id &&
                      EXECUTIVE_ROLES.includes(session.role) ? (
                        <button className="btn sm" onClick={() => approve(row)}>
                          Sign on my device
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>

      <Panel title="The custody ladder">
        <div className="grid-2">
          <div className="card" style={{ borderLeft: '3px solid var(--bad)' }}>
            <div className="row" style={{ marginBottom: 6 }}>
              <CustodyBadge kind="console" />
              <Badge tone="bad">barred for executives</Badge>
            </div>
            <p className="muted" style={{ margin: 0 }}>
              A key in this browser. Whatever compromises this machine — malware, a hijacked
              session, an unlocked laptop — can both write a payment and sign it. Available to staff
              who do not authorize payments; refused for CFO, CEO, CTO and treasury.
            </p>
          </div>
          <div className="card laneB">
            <div className="row" style={{ marginBottom: 6 }}>
              <CustodyBadge kind="authenticator" />
              <Badge tone="warn">+5 risk</Badge>
            </div>
            <p className="muted" style={{ margin: 0 }}>
              A passphrase-sealed key in the SEAL Authenticator, on a separate device at a separate
              origin. The console can ask and cannot sign. Still ultimately copyable by malware
              running on that device, which is what the remaining premium prices in.
            </p>
          </div>
          <div className="card laneA">
            <div className="row" style={{ marginBottom: 6 }}>
              <CustodyBadge kind="hardware" />
              <Badge tone="ok">no premium</Badge>
            </div>
            <p className="muted" style={{ margin: 0 }}>
              WebAuthn / FIDO2 — Windows Hello, Touch ID, or a physical security key. The private
              key is generated inside the authenticator and cannot be exported at all, and every
              signature needs a physical gesture that malware cannot perform. Origin binding comes
              free, which closes the phishing path.
            </p>
          </div>
          <div className="card">
            <div className="row" style={{ marginBottom: 6 }}>
              <Badge tone="accent">the same envelope throughout</Badge>
            </div>
            <p className="muted" style={{ margin: 0 }}>
              All three produce the same signature envelope, and every verifier — this server, the
              approver screens, the payment rail — reads a <span className="mono">device_kind</span>{' '}
              field rather than branching on key type. A mixed estate during rollout is
              representable and auditable, and the custody tier is inside the signature, so it
              cannot be upgraded in transit.
            </p>
          </div>
        </div>
      </Panel>

      {!isExecutive ? (
        <Panel title="Console key (staff only)">
          {consoleVault ? (
            <>
              <p className="muted" style={{ marginTop: 0 }}>
                A console-resident key for <span className="mono">{consoleVault.credential_id}</span>
                . It authorizes nothing today — Lane B, where staff-originated requests get signed,
                is not built yet.
              </p>
              <button
                className="btn danger sm"
                onClick={() => {
                  if (confirm('Delete the key in this browser? It cannot be recovered.')) {
                    vault.forget(session.id);
                    refresh();
                  }
                }}
              >
                Destroy this credential
              </button>
            </>
          ) : (
            <>
              <p className="muted" style={{ marginTop: 0 }}>
                Staff who do not authorize payments may hold a key here. It is the weakest tier and
                is refused for any executive role.
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
                  onKeyDown={(e) => e.key === 'Enter' && enrolConsoleKey()}
                />
              </label>
              <button className="btn" onClick={enrolConsoleKey} disabled={busy}>
                {busy ? 'Generating…' : 'Enrol a console key'}
              </button>
            </>
          )}
          {note ? (
            <p className="muted" style={{ marginTop: 12 }}>
              {note}
            </p>
          ) : null}
        </Panel>
      ) : null}
    </>
  );
}
