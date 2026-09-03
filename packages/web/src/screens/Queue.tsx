import { useState } from 'react';
import type { SignatureEnvelope, TransactionIntent } from '@seal/shared';
import { api, useApi } from '../api.js';
import {
  Badge,
  Banner,
  CustodyBadge,
  Empty,
  Hash,
  LockedField,
  Money,
  Panel,
} from '../components/ui.js';
import { CallerVerify } from '../components/CallerVerify.js';
import type { Session } from './Login.js';

interface QueueItem {
  txn_id: string;
  lane: 'A' | 'B';
  intent: TransactionIntent;
  intent_hash: string;
  signature: SignatureEnvelope;
  created_at: string;
  signer: {
    user_id: string;
    name: string;
    role: string;
    binding: 'software' | 'hardware';
    device_kind: 'console' | 'authenticator' | 'hardware';
    credential_id: string;
    key_age_days: number;
  };
}

/**
 * Stage 2. The employee is the person being socially engineered, so this screen
 * removes the field where attacker-supplied data would otherwise enter. There
 * is no "create payment" button and no editable payee. Accept or reject, and
 * nothing else.
 */
export function Queue({ session, bump, onChanged }: { session: Session; bump: number; onChanged: () => void }) {
  const [tick, setTick] = useState(0);
  const { data: items } = useApi<QueueItem[]>('/api/intents', `${bump}:${tick}`);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<{ escrow_id: string; txn_id: string } | null>(null);
  const [verify, setVerify] = useState(false);

  const refresh = () => {
    setTick((t) => t + 1);
    onChanged();
  };

  const selected = (items ?? []).find((i) => i.txn_id === open) ?? null;

  const accept = async (item: QueueItem) => {
    setBusy(true);
    setError(null);
    try {
      const escrow = await api<{ escrow_id: string }>(`/api/intents/${item.txn_id}/accept`, {
        method: 'POST',
      });
      setOpened({ escrow_id: escrow.escrow_id, txn_id: item.txn_id });
      setOpen(null);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reject = async (item: QueueItem) => {
    const reason = prompt('Why are you rejecting this request?') ?? '';
    if (!reason) return;
    setBusy(true);
    try {
      await api(`/api/intents/${item.txn_id}/reject`, { method: 'POST', body: { reason } });
      setOpen(null);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <CallerVerify open={verify} onClose={() => setVerify(false)} />
      <h1>Request queue</h1>
      <p className="lede">
        Everything here arrived already signed by an executive. You can accept it or reject it. There
        is nowhere on this screen to type a payee, an account or an amount — which is precisely why a
        phone call cannot get money moved through you.
      </p>

      {opened ? (
        <Banner tone="ok" title={`Escrow opened for ${opened.txn_id}`}>
          <span className="mono">{opened.escrow_id}</span> is now with the approvers and the clock is
          running. You have no further say in it, and no way to alter it.
        </Banner>
      ) : null}
      {error ? <Banner tone="bad" title="That did not go through">{error}</Banner> : null}

      <Banner tone="info" title="If someone is calling you about a payment">
        This queue is your ground truth. If no signed request is sitting here, no authorization
        exists — whatever the person on the call looks and sounds like. Phone calls, video meetings
        and emails carry zero signing authority, and no genuine executive will ever ask you to work
        around that.{' '}
        <button className="btn sm danger" style={{ marginTop: 8 }} onClick={() => setVerify(true)}>
          Verify who is calling me
        </button>
      </Banner>

      <div className="grid-2">
        <Panel
          title="Signed requests"
          aside={<Badge tone={items?.length ? 'accent' : 'plain'}>{items?.length ?? 0} waiting</Badge>}
        >
          {(items ?? []).length === 0 ? (
            <Empty>
              Nothing is waiting.
              <div style={{ marginTop: 8 }} className="dim">
                If someone is on the phone insisting a payment is urgent, this empty queue is your
                answer. There is no signed request, so there is nothing to process.
              </div>
              {/* The moment of maximum pressure. Do not leave someone staring at
                  an empty screen with a "CFO" shouting at them -- give them the
                  next move. */}
              <button className="btn danger" style={{ marginTop: 14 }} onClick={() => setVerify(true)}>
                Someone is pressuring me right now
              </button>
            </Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Transaction</th>
                  <th>Payee</th>
                  <th>Amount</th>
                  <th>Signed by</th>
                </tr>
              </thead>
              <tbody>
                {(items ?? []).map((i) => (
                  <tr key={i.txn_id} className="clickable" onClick={() => setOpen(i.txn_id)}>
                    <td className="mono">{i.txn_id}</td>
                    <td>{i.intent.payee.name}</td>
                    <td>
                      <Money value={i.intent.amount.value} />
                    </td>
                    <td>
                      {i.signer.name}
                      <div className="dim">{i.signer.role}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="Raise a request yourself">
          <div className="card laneB dead">
            <div className="row" style={{ marginBottom: 8 }}>
              <Badge tone="warn">lane B · unverified origin</Badge>
              <Badge tone="bad">not built yet</Badge>
            </div>
            <p className="muted" style={{ marginTop: 0 }}>
              An employee-originated request is a claim, not a verified intent, and it must never
              render like a signed one — different colour, different banner, different wording. If
              the two screens look alike, the quorum becomes theatre and approvers rubber-stamp
              attacker-supplied data because it arrived inside a clean-looking process.
            </p>
            <p className="muted">
              Lane A is what ships today, so this path is closed rather than half-built: the API
              answers <span className="mono">501 LANE_B_NOT_IMPLEMENTED</span>. When it opens it will
              be capped, blocked on beneficiaries outside the vendor master, and escalated to the
              CFO's own device for a signature above the cap.
            </p>
            <button className="btn" disabled>
              Raise unverified request
            </button>
          </div>
        </Panel>
      </div>

      {selected ? (
        <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && setOpen(null)}>
          <div className="modal">
            <h2>Verify request {selected.txn_id}</h2>

            <Banner tone="ok" title="SIGNATURE VALID">
              Verified server-side against {selected.signer.name}'s enrolled key, which was signed
              on their own device — not on the machine that composed this. The fields below are the
              fields that were signed.
            </Banner>

            <div className="row" style={{ marginBottom: 14 }}>
              <Badge tone="ok">lane A · verified intent</Badge>
              <CustodyBadge kind={selected.signer.device_kind} />
              <Badge>key age {selected.signer.key_age_days}d</Badge>
            </div>

            <LockedField label="Payee" value={selected.intent.payee.name} />
            <LockedField label="Account" value={selected.intent.payee.account} />
            <LockedField label="IFSC" value={selected.intent.payee.ifsc} />
            <LockedField label="Amount" value={<Money value={selected.intent.amount.value} />} />
            <LockedField label="Purpose" value={selected.intent.purpose} />
            <LockedField
              label="Pay by"
              value={new Date(selected.intent.deadline).toLocaleString()}
            />

            <dl className="kv" style={{ marginTop: 14 }}>
              <dt>Signer</dt>
              <dd>
                {selected.signer.name} · {selected.signer.role}
              </dd>
              <dt>Credential</dt>
              <dd className="mono">{selected.signer.credential_id}</dd>
              <dt>Signature counter</dt>
              <dd className="mono">{selected.signature.counter}</dd>
              <dt>Intent hash</dt>
              <dd>
                <Hash value={selected.intent_hash} chars={28} />
              </dd>
              <dt>Signature valid until</dt>
              <dd>{new Date(selected.intent.exp).toLocaleTimeString()}</dd>
            </dl>

            <p className="dim" style={{ fontSize: 12 }}>
              Altering any field above changes the hash, and the signature no longer verifies. That
              is why these are rendered as text and not as inputs.
            </p>

            <div className="row" style={{ marginTop: 16 }}>
              <button className="btn danger" onClick={() => reject(selected)} disabled={busy}>
                Reject
              </button>
              <div className="spacer" />
              <button className="btn ghost" onClick={() => setOpen(null)} disabled={busy}>
                Close
              </button>
              <button className="btn good" onClick={() => accept(selected)} disabled={busy}>
                {busy ? 'Opening escrow…' : 'Accept and open escrow'}
              </button>
            </div>
            {session.role !== 'EMPLOYEE' ? (
              <p className="dim" style={{ fontSize: 12, marginTop: 10 }}>
                Note: accepting here makes you the opener, and an opener can never also approve.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
