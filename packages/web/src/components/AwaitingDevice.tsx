import { useEffect, useState } from 'react';
import type { SigningRequest } from '@seal/shared';
import { api } from '../api.js';
import { Badge, Hash } from './ui.js';

const AUTHENTICATOR_URL =
  import.meta.env.VITE_AUTHENTICATOR_URL ?? 'http://localhost:5174';

/**
 * The console's half of the out-of-band handshake.
 *
 * Once a signing request is raised there is nothing more the console can do but
 * wait. It cannot sign, it cannot cancel on the executive's behalf, and it
 * cannot alter the payload -- the hash shown here is fixed and is the hash the
 * device will sign. This component just watches.
 */
export function AwaitingDevice({
  request,
  onResolved,
  onDismiss,
}: {
  request: SigningRequest;
  onResolved?: (r: SigningRequest) => void;
  onDismiss?: () => void;
}) {
  const [live, setLive] = useState<SigningRequest>(request);
  const [left, setLeft] = useState(request.seconds_remaining);

  useEffect(() => {
    setLive(request);
    setLeft(request.seconds_remaining);
  }, [request]);

  useEffect(() => {
    if (live.state !== 'PENDING') return;
    const tick = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    const poll = setInterval(async () => {
      try {
        const next = await api<SigningRequest>(`/api/signing-requests/${live.id}`);
        if (next.state !== live.state) {
          setLive(next);
          onResolved?.(next);
        } else {
          setLeft(next.seconds_remaining);
        }
      } catch {
        /* transient; the next tick retries */
      }
    }, 1500);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [live, onResolved]);

  const mm = String(Math.floor(left / 60)).padStart(2, '0');
  const ss = String(left % 60).padStart(2, '0');

  if (live.state === 'SIGNED') {
    return (
      <div className="banner ok">
        <div>
          <div className="big">AUTHORIZED ON YOUR DEVICE</div>
          <p>
            Signed and accepted. {live.purpose === 'INTENT' ? 'The request is now in the employee queue.' : null}
            {onDismiss ? (
              <>
                {' '}
                <button className="btn sm ghost" onClick={onDismiss}>
                  dismiss
                </button>
              </>
            ) : null}
          </p>
        </div>
      </div>
    );
  }

  if (live.state === 'DECLINED') {
    return (
      <div className="banner bad">
        <div>
          <div className="big">DECLINED ON YOUR DEVICE</div>
          <p>
            {live.error ?? 'Declined.'} Nothing was authorized, and the refusal is in the audit
            chain.
            {onDismiss ? (
              <>
                {' '}
                <button className="btn sm ghost" onClick={onDismiss}>
                  dismiss
                </button>
              </>
            ) : null}
          </p>
        </div>
      </div>
    );
  }

  if (live.state === 'EXPIRED' || live.state === 'FAILED') {
    return (
      <div className="banner bad">
        <div>
          <div className="big">{live.state === 'EXPIRED' ? 'REQUEST TIMED OUT' : 'SIGNATURE REJECTED'}</div>
          <p>
            {live.error ?? 'The signing request was not completed in time.'} Nothing was authorized.
            {onDismiss ? (
              <>
                {' '}
                <button className="btn sm ghost" onClick={onDismiss}>
                  dismiss
                </button>
              </>
            ) : null}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="banner warn">
      <div style={{ width: '100%' }}>
        <div className="row">
          <span className="big">WAITING FOR YOUR DEVICE</span>
          <div className="spacer" />
          <span className="mono">
            {mm}:{ss}
          </span>
        </div>
        <p>
          The console cannot sign this — it holds no key. Open the SEAL Authenticator on your phone
          or second device, check the payee and the amount, and authorize it there.
        </p>
        <div className="row" style={{ marginTop: 8 }}>
          <Badge tone="warn">{live.purpose.toLowerCase()}</Badge>
          <span className="dim">hash the device will sign</span>
          <Hash value={live.payload_hash} chars={18} />
          <div className="spacer" />
          <a className="btn sm" href={AUTHENTICATOR_URL} target="_blank" rel="noreferrer">
            Open Authenticator ↗
          </a>
        </div>
      </div>
    </div>
  );
}
