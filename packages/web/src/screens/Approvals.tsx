import { useEffect, useState } from 'react';
import type { EscrowView, SigningRequest } from '@seal/shared';
import { api, useApi } from '../api.js';
import {
  Badge,
  Banner,
  CustodyBadge,
  Countdown,
  Empty,
  Hash,
  LockedField,
  Money,
  Panel,
  StateBadge,
  TierBadge,
} from '../components/ui.js';
import { AwaitingDevice } from '../components/AwaitingDevice.js';
import { CallerVerify } from '../components/CallerVerify.js';
import type { Session } from './Login.js';

const APPROVER_ROLES = ['CEO', 'CTO', 'TREASURY', 'CFO'];

/**
 * Stage 3, also split across two devices.
 *
 * The approver reads the escrow here and decides here, but the decision is not
 * an approval until their own device signs it. The hash they see on the phone
 * is the hash bound to this escrow and the hash the payment rail will check --
 * so an approval can never be quietly re-pointed at a different payment.
 */
export function Approvals({
  session,
  bump,
  onChanged,
}: {
  session: Session;
  bump: number;
  onChanged: () => void;
}) {
  const [tick, setTick] = useState(0);
  const { data: escrows } = useApi<EscrowView[]>('/api/escrows', `${bump}:${tick}`);
  const [openId, setOpenId] = useState<string | null>(null);
  const [pendingRequest, setPendingRequest] = useState<SigningRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [verify, setVerify] = useState(false);

  const refresh = () => {
    setTick((t) => t + 1);
    onChanged();
  };

  // Follow the newest live escrow so a demo audience never has to hunt for it.
  useEffect(() => {
    if (openId) return;
    const live = (escrows ?? []).find((e) => e.state === 'PENDING_QUORUM');
    if (live) setOpenId(live.escrow_id);
  }, [escrows, openId]);

  const selected = (escrows ?? []).find((e) => e.escrow_id === openId) ?? null;

  const decide = async (escrow: EscrowView, decision: 'APPROVE' | 'REJECT') => {
    setError(null);
    setBusy(true);
    try {
      const request = await api<SigningRequest>(`/api/escrows/${escrow.escrow_id}/approvals`, {
        body: { decision },
      });
      setPendingRequest(request);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const canApprove = APPROVER_ROLES.includes(session.role);

  return (
    <>
      <CallerVerify
        open={verify}
        onClose={() => setVerify(false)}
        context={
          selected
            ? {
                txn_id: selected.txn_id,
                escrow_id: selected.escrow_id,
                demand: `Approve ${selected.txn_id} — ${selected.intent.payee.name}`,
              }
            : undefined
        }
      />
      <h1>Approver panel</h1>
      <p className="lede">
        Two independent approvers must confirm the same hash, each on their own device. Urgency
        raises the risk tier; it never shortens the clock.
      </p>

      {pendingRequest ? (
        <AwaitingDevice
          request={pendingRequest}
          onResolved={() => refresh()}
          onDismiss={() => setPendingRequest(null)}
        />
      ) : null}
      {error ? (
        <Banner tone="bad" title="Approval refused">
          {error}
        </Banner>
      ) : null}

      <div className="grid-2">
        <Panel title="Escrows">
          {(escrows ?? []).length === 0 ? (
            <Empty>No escrows yet.</Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Escrow</th>
                  <th>Amount</th>
                  <th>Tier</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {(escrows ?? []).map((e) => (
                  <tr
                    key={e.escrow_id}
                    className="clickable"
                    onClick={() => setOpenId(e.escrow_id)}
                    style={
                      openId === e.escrow_id ? { outline: '1px solid var(--accent)' } : undefined
                    }
                  >
                    <td className="mono">
                      {e.escrow_id}
                      <div className="dim">{e.txn_id}</div>
                    </td>
                    <td>
                      <Money value={e.intent.amount.value} />
                    </td>
                    <td>
                      <TierBadge tier={e.risk.tier} />
                    </td>
                    <td>
                      <StateBadge state={e.state} />
                      <div className="dim">
                        {e.approvals.filter((a) => a.decision === 'APPROVE').length} /{' '}
                        {e.required_approvals}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        {selected ? (
          <div>
            <Panel
              title={selected.escrow_id}
              aside={
                <div className="row">
                  <TierBadge tier={selected.risk.tier} />
                  <StateBadge state={selected.state} />
                </div>
              }
            >
              {selected.state === 'PENDING_QUORUM' ? (
                <div className="row" style={{ marginBottom: 14 }}>
                  <div>
                    <div className="dim" style={{ fontSize: 11, letterSpacing: '.08em' }}>
                      TIME LEFT IN THE WINDOW
                    </div>
                    <Countdown
                      seconds={selected.seconds_remaining}
                      total={selected.risk.window_minutes * 60}
                    />
                  </div>
                  <div className="spacer" />
                  <div style={{ textAlign: 'right' }}>
                    <div className="countdown">
                      {selected.approvals.filter((a) => a.decision === 'APPROVE').length}/
                      {selected.required_approvals}
                    </div>
                    <div className="dim">approvals</div>
                  </div>
                </div>
              ) : null}

              {selected.state === 'EXPIRED' ? (
                <Banner tone="bad" title="VOIDED — the window closed">
                  Nothing executed. The record is retained and the originator was alerted: an escrow
                  that times out is the single best fraud signal this system produces, so it is
                  never deleted.
                </Banner>
              ) : null}
              {selected.state === 'EXECUTED' ? (
                <Banner tone="ok" title="EXECUTED">
                  Settled by the payment rail with reference{' '}
                  <span className="mono">{selected.receipt?.reference}</span> after it independently
                  re-verified every signature in the bundle.
                </Banner>
              ) : null}
              {selected.state === 'REJECTED' ? (
                <Banner tone="bad" title="REJECTED">
                  {selected.receipt?.error
                    ? `The rail refused the bundle: ${selected.receipt.error}`
                    : 'An approver declined. The intent is dead; it cannot be revived or resubmitted.'}
                </Banner>
              ) : null}

              <LockedField label="Payee" value={selected.intent.payee.name} />
              <LockedField label="Account" value={selected.intent.payee.account} />
              <LockedField label="IFSC" value={selected.intent.payee.ifsc} />
              <LockedField label="Amount" value={<Money value={selected.intent.amount.value} />} />
              <LockedField label="Purpose" value={selected.intent.purpose} />

              <div className="row" style={{ margin: '10px 0' }}>
                <Badge tone="ok">lane A · verified intent</Badge>
                <CustodyBadge kind={selected.signer.device_kind} />
                <span className="dim">signed by {selected.signer.user_id}</span>
                <Hash value={selected.intent_hash} chars={18} />
              </div>

              {selected.state === 'PENDING_QUORUM' && canApprove ? (
                <>
                  <div className="row" style={{ marginTop: 14 }}>
                    <button
                      className="btn danger"
                      disabled={busy}
                      onClick={() => decide(selected, 'REJECT')}
                    >
                      Decline on my device
                    </button>
                    <div className="spacer" />
                    <button
                      className="btn good"
                      disabled={busy}
                      onClick={() => decide(selected, 'APPROVE')}
                    >
                      Approve on my device
                    </button>
                  </div>
                  <p className="dim" style={{ fontSize: 12, marginTop: 8 }}>
                    Either button sends the decision to your enrolled device. Nothing is recorded
                    until you sign it there.
                  </p>

                  {/* This is the sharp end. The employee's queue is empty when a
                      deepfake calls, but an approver has a real escrow in front
                      of them -- so a convincing voice saying "approve it, I just
                      signed it" is the attack that actually has something to
                      push against. */}
                  <div className="banner warn" style={{ marginTop: 14, marginBottom: 0 }}>
                    <div style={{ width: '100%' }}>
                      <div className="big">NOBODY LEGITIMATE WILL CALL YOU ABOUT THIS</div>
                      <p>
                        Approvals arrive here and on your device — never by phone, video or chat. If
                        someone is talking you through this one, that is the attack, however much
                        they look and sound like {selected.signer.user_id}.
                      </p>
                      <button
                        className="btn sm danger"
                        style={{ marginTop: 8 }}
                        onClick={() => setVerify(true)}
                      >
                        Someone is on a call about this — verify them
                      </button>
                    </div>
                  </div>
                </>
              ) : null}
            </Panel>

            <Panel title="Why this tier">
              <div className="row" style={{ marginBottom: 10 }}>
                <Badge tone="accent">score {selected.risk.score}</Badge>
                <Badge>{selected.required_approvals} approvals required</Badge>
                <Badge>{selected.risk.window_minutes} minute window</Badge>
              </div>
              <ul className="muted" style={{ margin: 0, paddingLeft: 18 }}>
                {selected.risk.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </Panel>

            <Panel title="Approval rail">
              {selected.approvals.length === 0 ? (
                <Empty>No approvals yet.</Empty>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Approver</th>
                      <th>Decision</th>
                      <th>Signed on</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.approvals.map((a) => (
                      <tr key={a.approver_id}>
                        <td>
                          {a.approver_id}
                          <div className="dim">
                            {a.role} · {new Date(a.at).toLocaleTimeString()}
                          </div>
                        </td>
                        <td>
                          <Badge tone={a.decision === 'APPROVE' ? 'ok' : 'bad'}>{a.decision}</Badge>
                        </td>
                        <td>
                          <CustodyBadge kind={a.device_kind} />
                          <div style={{ marginTop: 4 }}>
                            <Hash value={a.signature} chars={12} />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>
          </div>
        ) : (
          <Panel title="Detail">
            <Empty>Select an escrow.</Empty>
          </Panel>
        )}
      </div>
    </>
  );
}
