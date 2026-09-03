import { useState } from 'react';
import type { AuditEntry, ChainVerification } from '@seal/shared';
import { api, useApi } from '../api.js';
import { Badge, Banner, Empty, Hash, Panel } from '../components/ui.js';

const TONE: Record<string, 'ok' | 'warn' | 'bad' | 'accent' | 'plain'> = {
  INTENT_SIGNED: 'ok',
  INTENT_ACCEPTED: 'accent',
  ESCROW_OPENED: 'accent',
  APPROVAL_RECORDED: 'ok',
  QUORUM_MET: 'ok',
  PAYMENT_SUBMITTED: 'accent',
  EXECUTED: 'ok',
  CREDENTIAL_ENROLLED: 'ok',
  CREDENTIAL_ENROLL_APPROVED: 'accent',
  CREDENTIAL_ENROLL_REQUESTED: 'plain',
  ESCROW_EXPIRED: 'bad',
  INTENT_REJECTED: 'bad',
  APPROVAL_REJECTED: 'bad',
  INTENT_VERIFY_FAILED: 'bad',
  PAYMENT_REFUSED: 'bad',
  ATTACK_BLOCKED: 'bad',
};

/**
 * One chain, not five systems correlated after the fact.
 *
 * Telephony metadata, session risk, device identity, payment details and
 * approval records normally live in separate places and only get joined
 * together during an incident review. Here every state change -- including
 * every refusal -- is one entry in one hash-linked log, and the origin lane of
 * the data is a field in it. Six months later, "employee-entered, CFO-confirmed
 * at 14:11" and "CFO-signed at 14:01" are different answers, and this is the
 * only place that can tell them apart.
 */
export function Audit({ bump }: { bump: number }) {
  const [txn, setTxn] = useState('');
  const [tick, setTick] = useState(0);
  const dep = `${bump}:${tick}`;

  const { data: recent } = useApi<AuditEntry[]>('/api/audit?limit=300', dep);
  const [verification, setVerification] = useState<(ChainVerification & { txn_id?: string }) | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const entries = (recent ?? []).filter((e) => !txn || e.txn_id === txn);
  const txns = Array.from(new Set((recent ?? []).map((e) => e.txn_id).filter(Boolean))) as string[];

  const verify = async () => {
    setError(null);
    try {
      const target = txn || txns[txns.length - 1];
      if (!target) return setError('Nothing to verify yet.');
      setVerification(await api(`/api/audit/${target}/verify`));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <>
      <h1>Audit chain</h1>
      <p className="lede">
        Append-only and hash-linked: <span className="mono">entry.prev_hash = SHA256(previous entry)</span>.
        A retroactive edit breaks the chain from that point forward and the verifier reports exactly
        where. <code>UPDATE</code> and <code>DELETE</code> are revoked on this table at the database
        level, so tampering fails at the storage layer rather than being merely discouraged.
      </p>

      <Panel
        title="Verify"
        aside={
          <div className="row">
            <select value={txn} onChange={(e) => setTxn(e.target.value)} style={{ width: 200 }}>
              <option value="">all transactions</option>
              {txns.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <button className="btn sm" onClick={() => setTick((t) => t + 1)}>
              Refresh
            </button>
            <button className="btn sm primary" onClick={verify}>
              Recompute chain
            </button>
          </div>
        }
      >
        {error ? <p className="error">{error}</p> : null}
        {verification ? (
          verification.ok ? (
            <Banner tone="ok" title="CHAIN INTACT">
              Recomputed {verification.entries_checked} entries from genesis. Every stored hash
              matches its recomputed value and every link matches its predecessor.
            </Banner>
          ) : (
            <Banner tone="bad" title={`CHAIN BROKEN AT ENTRY #${verification.break_at_seq}`}>
              {verification.reason}. Everything from that point on is suspect.
            </Banner>
          )
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            Recompute the chain to check it independently of anything the UI has told you.
          </p>
        )}
      </Panel>

      <Panel title={txn ? `Chain for ${txn}` : 'Recent entries'}>
        {entries.length === 0 ? (
          <Empty>Nothing recorded yet.</Empty>
        ) : (
          <div className="chain">
            {entries.map((e) => (
              <div className="chain-entry" key={e.seq}>
                <div className="seq">#{e.seq}</div>
                <div>
                  <div className="row">
                    <span className="type">{e.type}</span>
                    <Badge tone={TONE[e.type] ?? 'plain'}>{e.actor ?? 'system'}</Badge>
                    {e.txn_id ? <span className="dim mono">{e.txn_id}</span> : null}
                    <div className="spacer" />
                    <span className="dim">{new Date(e.at).toLocaleTimeString()}</span>
                  </div>
                  <Details payload={e.payload} />
                  <div className="hashline">
                    prev <Hash value={e.prev_hash} chars={10} /> → this{' '}
                    <Hash value={e.entry_hash} chars={10} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </>
  );
}

/** The fields an auditor actually asks about, surfaced without opening the JSON. */
function Details({ payload }: { payload: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  const highlights: Array<[string, string]> = [];

  const put = (k: string, v: unknown) => {
    if (v === undefined || v === null) return;
    highlights.push([k, typeof v === 'object' ? JSON.stringify(v) : String(v)]);
  };

  put('origin lane', payload.lane);
  put('origin', payload.origin);
  put('binding', payload.binding);
  put('decision', payload.decision);
  put('risk', (payload.risk as { tier?: string })?.tier);
  put('rules', (payload.risk as { rules_fired?: string[] })?.rules_fired?.join(', '));
  put('code', payload.code);
  put('failed checks', (payload.failed_checks as string[])?.join(', '));
  put('via', payload.via);
  put('alert', payload.alert);

  return (
    <div style={{ margin: '4px 0 6px' }}>
      {highlights.length > 0 ? (
        <div className="row" style={{ gap: 12 }}>
          {highlights.map(([k, v]) => (
            <span key={k} className="dim" style={{ fontSize: 12 }}>
              {k}: <span className="mono" style={{ color: 'var(--muted)' }}>{v}</span>
            </span>
          ))}
        </div>
      ) : null}
      <button className="btn sm ghost" style={{ marginTop: 4 }} onClick={() => setOpen((o) => !o)}>
        {open ? 'hide payload' : 'payload'}
      </button>
      {open ? (
        <pre
          className="mono"
          style={{
            background: 'var(--bg)',
            border: '1px solid var(--line)',
            borderRadius: 8,
            padding: 10,
            overflowX: 'auto',
          }}
        >
          {JSON.stringify(payload, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}
