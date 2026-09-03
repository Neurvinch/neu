import { formatINR } from '@seal/shared';
import type { EscrowView } from '@seal/shared';
import { useApi } from '../api.js';
import {
  Badge,
  Banner,
  Countdown,
  Empty,
  Money,
  Panel,
  StateBadge,
  TierBadge,
} from '../components/ui.js';

interface Metrics {
  escrows: { executed: number; expired: number; rejected: number; pending: number; total: number };
  attack_block: { blocked_attempts: number; blocked_at_rail: number };
  legitimate_success_rate: number | null;
  median_verification_seconds: number | null;
  prevented_value: string;
  settled_value: string;
  audit: {
    chain_ok: boolean;
    entries: number;
    break_at_seq: number | null;
    completeness_pct: number;
  };
}

/**
 * The SecOps view. Every number here is computed from the audit chain rather
 * than asserted -- which is the practical payoff of having put everything in
 * one chain in the first place.
 */
export function Console({ bump }: { bump: number }) {
  const { data: m } = useApi<Metrics>('/api/metrics', bump);
  const { data: escrows } = useApi<EscrowView[]>('/api/escrows', bump);

  const live = (escrows ?? []).filter((e) => e.state === 'PENDING_QUORUM');
  const voided = (escrows ?? []).filter((e) => e.state === 'EXPIRED' || e.state === 'REJECTED');

  return (
    <>
      <h1>Risk console</h1>
      <p className="lede">
        Live escrows, voided escrows and the integrity of the record, in one place.
      </p>

      {m ? (
        <>
          <div className="tiles" style={{ marginBottom: 16 }}>
            <Tile n={String(m.attack_block.blocked_attempts)} t="attempts blocked" />
            <Tile
              n={m.legitimate_success_rate === null ? '—' : `${m.legitimate_success_rate}%`}
              t="legitimate success"
            />
            <Tile
              n={
                m.median_verification_seconds === null
                  ? '—'
                  : `${m.median_verification_seconds < 90 ? Math.round(m.median_verification_seconds) + 's' : Math.round(m.median_verification_seconds / 60) + 'm'}`
              }
              t="median sign → settle"
            />
            <Tile n={formatINR(m.settled_value)} t="value settled" />
            <Tile n={formatINR(m.prevented_value)} t="value not paid out" />
            <Tile n={`${m.audit.completeness_pct}%`} t="audit completeness" />
          </div>

          {m.audit.chain_ok ? (
            <Banner tone="ok" title={`AUDIT CHAIN INTACT — ${m.audit.entries} entries`}>
              Every entry hashes to its stored value and links to its predecessor. Refusals at the
              payment rail are reported back and chained here too ({m.attack_block.blocked_at_rail}{' '}
              so far), so an attack aimed past SEAL still leaves evidence inside it.
            </Banner>
          ) : (
            <Banner tone="bad" title={`AUDIT CHAIN BROKEN AT #${m.audit.break_at_seq}`}>
              The record has been altered. Treat everything from that entry onward as unreliable.
            </Banner>
          )}

          <Panel
            title="VIT Chennai PS1 Compliance Matrix — Deepfake-Resistant Executive Authorization"
            aside={<Badge tone="accent">Cybersecurity Track</Badge>}
          >
            <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 12 }}>
              Demonstrating direct architectural solutions to all five core vulnerabilities outlined in
              Problem Statement PS1:
            </div>
            <table style={{ fontSize: 12 }}>
              <thead>
                <tr>
                  <th style={{ width: '22%' }}>PS1 Core Issue</th>
                  <th style={{ width: '43%' }}>SEAL Architectural Defense</th>
                  <th style={{ width: '20%' }}>Enforcement Point</th>
                  <th style={{ width: '15%' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><strong>1. Human Trust Outside Control</strong></td>
                  <td>Employee queue allows zero free-form payee/account composition; only pre-signed objects can be accepted.</td>
                  <td>Console / Queue UI</td>
                  <td><Badge tone="ok">ENFORCED</Badge></td>
                </tr>
                <tr>
                  <td><strong>2. Deepfake Detection Insufficient</strong></td>
                  <td>Zero reliance on probabilistic voice classifiers. Authority requires unforgeable Ed25519 WebCrypto signature.</td>
                  <td>Out-of-band Authenticator</td>
                  <td><Badge tone="ok">ENFORCED</Badge></td>
                </tr>
                <tr>
                  <td><strong>3. Auth != Intent Binding</strong></td>
                  <td>RFC 8785 canonical JSON hashing seals payee, amount, account, IFSC, and purpose under immutable payload hash.</td>
                  <td>Cryptographic Envelopes</td>
                  <td><Badge tone="ok">ENFORCED</Badge></td>
                </tr>
                <tr>
                  <td><strong>4. High-Pressure Workflow Bypass</strong></td>
                  <td>Urgency raises risk tier (HIGH/CRITICAL) and demands 2-of-2 quorum; urgency never shortens the escrow window.</td>
                  <td>Risk Engine (`risk.ts`)</td>
                  <td><Badge tone="ok">ENFORCED</Badge></td>
                </tr>
                <tr>
                  <td><strong>5. Evidence Fragmentation</strong></td>
                  <td>Unified SHA-256 forward hash chain binds all requests, risk scores, approvers, rail receipts, and blocked attacks.</td>
                  <td>Append-only Audit Chain</td>
                  <td><Badge tone="ok">ENFORCED</Badge></td>
                </tr>
              </tbody>
            </table>
          </Panel>
        </>
      ) : null}

      <div className="grid-2">
        <Panel title="Live escrows" aside={<Badge tone="accent">{live.length}</Badge>}>
          {live.length === 0 ? (
            <Empty>Nothing in flight.</Empty>
          ) : (
            <div className="stack">
              {live.map((e) => (
                <div className="card laneA" key={e.escrow_id}>
                  <div className="row">
                    <span className="mono">{e.txn_id}</span>
                    <TierBadge tier={e.risk.tier} />
                    <div className="spacer" />
                    <Money value={e.intent.amount.value} />
                  </div>
                  <div className="row" style={{ marginTop: 8 }}>
                    <div>
                      <div className="dim" style={{ fontSize: 11 }}>
                        {e.intent.payee.name}
                      </div>
                      <div className="dim mono" style={{ fontSize: 11 }}>
                        {e.approvals.filter((a) => a.decision === 'APPROVE').length}/
                        {e.required_approvals} approvals
                      </div>
                    </div>
                    <div className="spacer" />
                    <Countdown
                      seconds={e.seconds_remaining}
                      total={e.risk.window_minutes * 60}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel
          title="Voided and refused"
          aside={<Badge tone={voided.length ? 'bad' : 'plain'}>{voided.length}</Badge>}
        >
          <p className="muted" style={{ marginTop: 0 }}>
            An escrow that timed out is never deleted. It is the clearest fraud signal the system
            produces, and a second attempt against the same account raises the score on the next one.
          </p>
          {voided.length === 0 ? (
            <Empty>Nothing voided.</Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Transaction</th>
                  <th>Payee</th>
                  <th>Amount</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {voided.map((e) => (
                  <tr key={e.escrow_id}>
                    <td className="mono">{e.txn_id}</td>
                    <td>
                      {e.intent.payee.name}
                      <div className="dim mono">{e.intent.payee.account}</div>
                    </td>
                    <td>
                      <Money value={e.intent.amount.value} />
                    </td>
                    <td>
                      <StateBadge state={e.state} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </>
  );
}

function Tile({ n, t }: { n: string; t: string }) {
  return (
    <div className="tile">
      <div className="n">{n}</div>
      <div className="t">{t}</div>
    </div>
  );
}
