import { useMemo, useState } from 'react';
import { buildIntent, formatINR } from '@seal/shared';
import type { SigningRequest, TransactionIntent } from '@seal/shared';
import { api, useApi } from '../api.js';
import { Badge, Banner, Field, Panel } from '../components/ui.js';
import { AwaitingDevice } from '../components/AwaitingDevice.js';
import type { Session } from './Login.js';

interface Vendor {
  name: string;
  account: string;
  ifsc: string;
}

const local = (d: Date) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

/**
 * Stage 1, split across two devices.
 *
 * The console composes; it does not authorize. Submitting here does not create
 * a payment -- it creates a *request for a signature*, which appears on the
 * executive's own device. If nobody authorizes it there, nothing exists.
 *
 * That split is what makes a compromised console survivable. Malware that owns
 * this browser can compose whatever it likes; every one of those attempts
 * surfaces on the real executive's phone showing a payee they have never heard
 * of, and dies there.
 */
export function Compose({ session, onSigned }: { session: Session; onSigned: () => void }) {
  const { data: policy } = useApi<{ vendors: Vendor[]; org_id: string }>('/api/policy');

  const [name, setName] = useState('');
  const [account, setAccount] = useState('');
  const [ifsc, setIfsc] = useState('');
  const [amount, setAmount] = useState('4200000.00');
  const [purpose, setPurpose] = useState('Vendor settlement Q3');
  const [deadline, setDeadline] = useState(local(new Date(Date.now() + 48 * 3600_000)));
  const [validity, setValidity] = useState('90');
  const [pendingRequest, setPendingRequest] = useState<SigningRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const vendors = policy?.vendors ?? [];
  const knownAccount = vendors.find((v) => v.account === account.trim());
  const knownName = vendors.find((v) => v.name.toLowerCase() === name.trim().toLowerCase());

  const valid =
    !!name.trim() &&
    /^\d{6,20}$/.test(account.trim()) &&
    /^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc.trim().toUpperCase()) &&
    /^\d+(\.\d{1,2})?$/.test(amount.trim()) &&
    !!purpose.trim() &&
    !!deadline;

  const draft = useMemo(() => {
    if (!valid || !policy) return null;
    return buildIntent({
      org_id: policy.org_id,
      type: 'wire_transfer',
      payee: { name: name.trim(), account: account.trim(), ifsc: ifsc.trim().toUpperCase() },
      amount: { value: amount.trim(), currency: 'INR' },
      purpose: purpose.trim(),
      deadline: new Date(deadline).toISOString(),
      originator: { user_id: session.id, role: session.role as 'CFO' },
      validityMinutes: Number(validity) || 90,
    });
    // A fresh nonce and txn_id on every keystroke is fine: nothing is committed
    // until it is signed, and the signed object is the one that gets submitted.
  }, [valid, policy, name, account, ifsc, amount, purpose, deadline, validity, session]);

  const requestSignature = async () => {
    if (!draft) return;
    setError(null);
    setBusy(true);
    try {
      const intent: TransactionIntent = draft;
      const request = await api<SigningRequest>('/api/intents', { body: { intent } });
      setPendingRequest(request);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1>Compose &amp; request authorization</h1>
      <p className="lede">
        Nothing downstream will accept a payment that did not start here — and nothing starts here
        either. The console composes the request; only your own enrolled device can authorize it.
        The call, the video meeting and the email carry no authority at all.
      </p>

      {pendingRequest ? (
        <AwaitingDevice
          request={pendingRequest}
          onResolved={(r) => {
            if (r.state === 'SIGNED') onSigned();
          }}
          onDismiss={() => setPendingRequest(null)}
        />
      ) : null}

      {error ? (
        <Banner tone="bad" title="The request was refused">
          {error}
        </Banner>
      ) : null}

      <div className="grid-2">
        <Panel title="Payment details">
          <div className="row" style={{ marginBottom: 12 }}>
            <span className="dim">Quick fill from the vendor master:</span>
            {vendors.map((v) => (
              <button
                key={v.account}
                className="btn sm ghost"
                onClick={() => {
                  setName(v.name);
                  setAccount(v.account);
                  setIfsc(v.ifsc);
                }}
              >
                {v.name.split(' ')[0]}
              </button>
            ))}
          </div>

          <Field label="Payee name" value={name} onChange={setName} placeholder="Alton Logistics Pvt Ltd" />
          <Field label="Account number" value={account} onChange={setAccount} placeholder="50100234564419" />
          <Field
            label="IFSC"
            value={ifsc}
            onChange={(v) => setIfsc(v.toUpperCase())}
            placeholder="HDFC0001234"
          />
          <Field label="Amount (INR)" value={amount} onChange={setAmount} placeholder="4200000.00" />
          <Field label="Purpose" value={purpose} onChange={setPurpose} />
          <label className="field">
            <span className="lbl">Pay by</span>
            <input
              type="datetime-local"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="lbl">Signature valid for</span>
            <select value={validity} onChange={(e) => setValidity(e.target.value)}>
              <option value="15">15 minutes</option>
              <option value="30">30 minutes</option>
              <option value="90">90 minutes</option>
            </select>
          </label>

          <button
            className="btn primary"
            disabled={!draft || busy || pendingRequest?.state === 'PENDING'}
            onClick={requestSignature}
          >
            {busy ? 'Sending to your device…' : 'Send to my device to authorize'}
          </button>
          <p className="dim" style={{ fontSize: 12, marginTop: 8 }}>
            This browser holds no signing key. It can ask; it cannot authorize.
          </p>
        </Panel>

        <div>
          <Panel title="Beneficiary check">
            {!account.trim() ? (
              <p className="muted" style={{ margin: 0 }}>
                Enter an account number to see how the risk engine will read it.
              </p>
            ) : knownAccount ? (
              <>
                <Banner tone="ok" title="Known beneficiary">
                  {knownAccount.name} is in the verified vendor master.
                </Banner>
                {knownAccount.ifsc !== ifsc.trim().toUpperCase() && ifsc.trim() ? (
                  <Banner tone="warn" title="IFSC differs from the verified record">
                    On file: <span className="mono">{knownAccount.ifsc}</span>. This raises the tier.
                  </Banner>
                ) : null}
              </>
            ) : knownName ? (
              <Banner tone="bad" title="Vendor name matches, account does not">
                <span className="mono">{knownName.name}</span> is on file against account{' '}
                <span className="mono">{knownName.account}</span>. A familiar name paired with an
                unfamiliar account is the classic beneficiary swap, and it forces the highest tier.
              </Banner>
            ) : (
              <Banner tone="warn" title="New beneficiary">
                Not in the vendor master. This alone floors the risk tier at HIGH.
              </Banner>
            )}
          </Panel>

          {draft ? (
            <Panel title="What your device will be asked to sign">
              <div className="row" style={{ marginBottom: 10 }}>
                <Badge tone="ok">lane A · verified intent</Badge>
                <Badge tone="accent">{formatINR(draft.amount.value)}</Badge>
              </div>
              <pre
                className="mono"
                style={{
                  background: 'var(--bg)',
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  padding: 12,
                  overflowX: 'auto',
                  margin: 0,
                }}
              >
                {JSON.stringify(draft, null, 2)}
              </pre>
              <p className="dim" style={{ fontSize: 12 }}>
                Canonicalized with RFC 8785, hashed with SHA-256, then sent to your device. The
                nonce and the validity window are what stop this being replayed later.
              </p>
            </Panel>
          ) : null}
        </div>
      </div>
    </>
  );
}
