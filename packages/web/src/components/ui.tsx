import { useEffect, useState, type ReactNode } from 'react';
import { DEVICE_ASSURANCE, formatINR } from '@seal/shared';
import type { DeviceKind, RiskTier } from '@seal/shared';

export function Badge({
  tone = 'plain',
  title,
  children,
}: {
  tone?: 'plain' | 'ok' | 'warn' | 'bad' | 'accent';
  title?: string;
  children: ReactNode;
}) {
  return (
    <span className={`badge ${tone}`} title={title}>
      {children}
    </span>
  );
}

export function Banner({
  tone,
  title,
  children,
}: {
  tone: 'ok' | 'warn' | 'bad' | 'info';
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className={`banner ${tone}`}>
      <div>
        <div className="big">{title}</div>
        {children ? <p>{children}</p> : null}
      </div>
    </div>
  );
}

/**
 * The custody badge appears anywhere a signature is shown.
 *
 * Three tiers, three colours, and never a green tick implying more assurance
 * than there is: an authenticator-app key is a real improvement over a phone
 * call but it is not a hardware key, and a console key is not fit to authorize
 * a payment at all.
 */
const CUSTODY_LABEL: Record<DeviceKind, string> = {
  console: 'console key',
  extension: 'extension key',
  authenticator: 'authenticator app',
  hardware: 'hardware key',
};

export function CustodyBadge({ kind }: { kind: DeviceKind }) {
  const tone =
    kind === 'hardware' ? 'ok' : kind === 'console' ? 'bad' : 'warn';
  return (
    <Badge tone={tone} title={`${DEVICE_ASSURANCE[kind].label} · risk premium +${DEVICE_ASSURANCE[kind].riskPremium}`}>
      {CUSTODY_LABEL[kind]}
    </Badge>
  );
}

export function TierBadge({ tier }: { tier: RiskTier }) {
  const tone = tier === 'CRITICAL' ? 'bad' : tier === 'HIGH' ? 'warn' : tier === 'MEDIUM' ? 'accent' : 'ok';
  return <Badge tone={tone}>{tier} risk</Badge>;
}

export function StateBadge({ state }: { state: string }) {
  const tone =
    state === 'EXECUTED'
      ? 'ok'
      : state === 'PENDING_QUORUM'
        ? 'accent'
        : state === 'EXPIRED' || state === 'REJECTED'
          ? 'bad'
          : 'plain';
  return <Badge tone={tone}>{state.replace('_', ' ')}</Badge>;
}

export function Hash({ value, chars = 12 }: { value: string; chars?: number }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="hashchip"
      title={`${value}\n(click to copy)`}
      onClick={() => {
        navigator.clipboard?.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? 'copied' : `${value.slice(0, chars)}…`}
    </button>
  );
}

export function Money({ value }: { value: string }) {
  return <span className="mono">{formatINR(value)}</span>;
}

/** A field the employee is not allowed to change, rendered so that it looks it. */
export function LockedField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <label className="field locked">
      <span className="lbl">{label}</span>
      <div className="val">{value}</div>
      <span className="lock">locked</span>
    </label>
  );
}

export function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="field">
      <span className="lbl">{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/**
 * Server-authoritative countdown. `seconds` comes from the server on every
 * update; this only ticks between updates, so a client with a wrong clock
 * cannot show itself more time than the escrow actually has.
 */
export function Countdown({ seconds, total }: { seconds: number; total: number }) {
  const [left, setLeft] = useState(seconds);
  useEffect(() => setLeft(seconds), [seconds]);
  useEffect(() => {
    const id = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, []);

  const pct = total > 0 ? Math.max(0, Math.min(100, (left / total) * 100)) : 0;
  const level = left <= 60 ? 'urgent' : left <= 300 ? 'warn' : '';
  const mm = String(Math.floor(left / 60)).padStart(2, '0');
  const ss = String(left % 60).padStart(2, '0');

  return (
    <div>
      <div className={`countdown ${level}`}>
        {mm}:{ss}
      </div>
      <div className={`meter ${level}`}>
        <i style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Panel({
  title,
  aside,
  children,
}: {
  title?: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      {title ? (
        <div className="panel-head">
          <h2>{title}</h2>
          <div className="spacer" />
          {aside}
        </div>
      ) : null}
      {children}
    </section>
  );
}
