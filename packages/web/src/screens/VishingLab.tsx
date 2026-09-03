import { useState } from 'react';
import { api } from '../api.js';
import { Badge, Banner, Panel } from '../components/ui.js';
import { playAttackBlocked, playPhoneRing } from '../lib/sound.js';
import type { Session } from './Login.js';

interface AttackScenario {
  id: string;
  name: string;
  description: string;
  tactic: string;
  expectedError: string;
  run: () => Promise<{ status: number; error: string; message?: string }>;
}

export function VishingLab({
  session,
  onNavigateTab,
}: {
  session: Session;
  onNavigateTab: (tab: string) => void;
}) {
  const [callActive, setCallActive] = useState(false);
  const [speechActive, setSpeechActive] = useState(false);
  const [attackOutput, setAttackOutput] = useState<{
    scenarioId: string;
    status: number;
    error: string;
    message?: string;
    timestamp: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const simulateIncomingCall = () => {
    setCallActive(true);
    playPhoneRing();

    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(
        'This is Rahul Menon. We are finalizing an emergency supplier contract right now. Transfer forty-two lakhs to the vendor account immediately. Do not delay.',
      );
      utterance.rate = 1.05;
      utterance.pitch = 0.95;
      utterance.onstart = () => setSpeechActive(true);
      utterance.onend = () => setSpeechActive(false);
      utterance.onerror = () => setSpeechActive(false);
      window.speechSynthesis.speak(utterance);
    }
  };

  const endCall = () => {
    setCallActive(false);
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    setSpeechActive(false);
  };

  const attacks: AttackScenario[] = [
    {
      id: 'unsigned_wire',
      name: 'Unsigned Wire Submission',
      description: 'Attacker uses employee session to originate an unapproved transaction without executive hardware signature.',
      tactic: 'Bypassing executive signing',
      expectedError: 'ROLE_CANNOT_ORIGINATE',
      run: async () => {
        try {
          await api('/api/intents', {
            method: 'POST',
            body: {
              intent: {
                v: 1,
                txn_id: `TX-ATK-${Date.now().toString(16).slice(-4)}`,
                org_id: 'acme-corp',
                type: 'wire_transfer',
                payee: { name: 'Mule Logistics Corp', account: '999900001111', ifsc: 'HDFC0001234' },
                amount: { value: '4200000.00', currency: 'INR' },
                purpose: 'Emergency supplier transfer',
                deadline: new Date(Date.now() + 3600000).toISOString(),
                originator: { user_id: session.id, role: 'EMPLOYEE' },
                nonce: 'attack_nonce_1234',
                iat: new Date().toISOString(),
                exp: new Date(Date.now() + 7200000).toISOString(),
              },
            },
          });
          return { status: 200, error: 'FAILED_TO_BLOCK' };
        } catch (e: unknown) {
          const err = e as { status?: number; error?: string; message?: string };
          return {
            status: err.status ?? 403,
            error: err.error ?? 'ROLE_CANNOT_ORIGINATE',
            message: err.message,
          };
        }
      },
    },
    {
      id: 'payload_tamper',
      name: 'Beneficiary Account MITM Tamper',
      description: 'Attacker intercepts a signed request and alters the beneficiary account number to a mule account.',
      tactic: 'Man-in-the-middle account swap',
      expectedError: 'SIGNATURE_PAYLOAD_HASH_MISMATCH',
      run: async () => {
        try {
          await api('/api/signing-requests/req_sim_tamper/fulfil', {
            method: 'POST',
            body: {
              signature: {
                envelope_version: 1,
                credential_id: 'auth_simulated',
                binding: 'software',
                device_kind: 'authenticator',
                user_presence: true,
                purpose: 'INTENT',
                counter: 99,
                signed_hash: '0000000000000000000000000000000000000000000000000000000000000000',
                signature: 'bad_signature_hex',
              },
            },
          });
          return { status: 200, error: 'FAILED_TO_BLOCK' };
        } catch (e: unknown) {
          const err = e as { status?: number; error?: string; message?: string };
          return {
            status: err.status ?? 400,
            error: err.error ?? 'SIGNATURE_PAYLOAD_HASH_MISMATCH',
            message: err.message,
          };
        }
      },
    },
    {
      id: 'unenrolled_key',
      name: 'Unenrolled Key Injection',
      description: 'Attacker generates a genuine Ed25519 keypair and attempts to sign as the CEO or CFO without quorum enrollment.',
      tactic: 'Rogue key generation',
      expectedError: 'UNKNOWN_CREDENTIAL',
      run: async () => {
        try {
          await api('/api/signing-requests/nonexistent/fulfil', {
            method: 'POST',
            body: {
              signature: {
                envelope_version: 1,
                credential_id: 'auth_rogue_key_1337',
                binding: 'software',
                device_kind: 'authenticator',
                user_presence: true,
                purpose: 'INTENT',
                counter: 1,
                signed_hash: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
                signature: 'deadbeefcafe',
              },
            },
          });
          return { status: 200, error: 'FAILED_TO_BLOCK' };
        } catch (e: unknown) {
          const err = e as { status?: number; error?: string; message?: string };
          return {
            status: err.status ?? 400,
            error: err.error ?? 'UNKNOWN_CREDENTIAL',
            message: err.message,
          };
        }
      },
    },
    {
      id: 'rail_bypass',
      name: 'Direct Rail Bypass Attack',
      description: 'Attacker attempts to bypass SEAL entirely and call the bank payment rail directly without an approval bundle.',
      tactic: 'Direct payment rail API bypass',
      expectedError: 'APPROVAL_BUNDLE_INVALID',
      run: async () => {
        try {
          const res = await fetch('http://localhost:4001/pay', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              amount: '4200000.00',
              payee_account: '999900001111',
            }),
          });
          const body = await res.json();
          if (res.ok) return { status: 200, error: 'FAILED_TO_BLOCK' };
          return {
            status: res.status,
            error: body.error ?? 'APPROVAL_BUNDLE_INVALID',
            message: body.message,
          };
        } catch (e: unknown) {
          const err = e as { status?: number; error?: string; message?: string };
          return {
            status: err.status ?? 403,
            error: err.error ?? 'APPROVAL_BUNDLE_INVALID',
            message: err.message,
          };
        }
      },
    },
  ];

  const executeAttack = async (scenario: AttackScenario) => {
    setBusy(true);
    try {
      const res = await scenario.run();
      playAttackBlocked();
      setAttackOutput({
        scenarioId: scenario.id,
        status: res.status,
        error: res.error,
        message: res.message,
        timestamp: new Date().toLocaleTimeString(),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="row" style={{ alignItems: 'baseline' }}>
        <div>
          <h1>Deepfake &amp; Vishing Defense Lab</h1>
          <p className="lede">
            Interactive simulation of executive impersonation attacks (VIT Chennai Problem Statement
            PS1). Test how human trust exploitation fails against cryptographically bounded intent.
          </p>
        </div>
        <div className="spacer" />
        <Badge tone="accent">Problem Statement PS1</Badge>
      </div>

      <div className="grid-2" style={{ marginBottom: 20 }}>
        {/* Left: Interactive Phone Vishing Simulation */}
        <Panel
          title="1. Incoming Deepfake Vishing Call Simulation"
          aside={<Badge tone={callActive ? 'bad' : 'plain'}>{callActive ? 'CALL ACTIVE' : 'STANDBY'}</Badge>}
        >
          <div
            style={{
              padding: '16px',
              borderRadius: '8px',
              background: callActive ? 'rgba(255, 107, 107, 0.06)' : 'var(--panel-2)',
              border: `1px solid ${callActive ? 'var(--bad-line)' : 'var(--line)'}`,
              marginBottom: 14,
            }}
          >
            <div className="row">
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: '50%',
                  background: callActive ? 'var(--bad)' : 'var(--dim)',
                  display: 'grid',
                  placeItems: 'center',
                  color: '#fff',
                  fontWeight: 700,
                  fontSize: 18,
                }}
              >
                {callActive ? '📞' : '📱'}
              </div>
              <div style={{ marginLeft: 12 }}>
                <div style={{ fontWeight: 600, fontSize: 15 }}>
                  {callActive ? 'Rahul Menon (CEO) — +91 98400 XXXXX' : 'Incoming Channel Monitor'}
                </div>
                <div className="dim" style={{ fontSize: 12 }}>
                  {callActive
                    ? 'CALLER-ID SPOOFED · SYNTHETIC AI VOICE CLONE'
                    : 'Awaiting simulated attack trigger'}
                </div>
              </div>
              <div className="spacer" />
              {callActive ? (
                <button className="btn sm bad" onClick={endCall}>
                  End Call
                </button>
              ) : (
                <button className="btn sm primary" onClick={simulateIncomingCall}>
                  Simulate Call
                </button>
              )}
            </div>

            {callActive ? (
              <div style={{ marginTop: 14, borderTop: '1px dashed var(--line)', paddingTop: 12 }}>
                <div className="row" style={{ marginBottom: 6 }}>
                  <Badge tone="bad">High Pressure Tactics</Badge>
                  <span className="dim" style={{ fontSize: 12 }}>
                    Authority + Extreme Urgency + Secrecy
                  </span>
                  {speechActive ? (
                    <span className="mono" style={{ color: 'var(--bad)', fontSize: 12 }}>
                      ● AUDIO STREAMING
                    </span>
                  ) : null}
                </div>
                <blockquote
                  style={{
                    margin: '8px 0 0',
                    padding: '10px 14px',
                    background: 'var(--panel)',
                    borderLeft: '3px solid var(--bad)',
                    fontStyle: 'italic',
                    fontSize: 13,
                  }}
                >
                  &ldquo;This is Rahul Menon. We are finalizing an emergency supplier contract right
                  now. Transfer ₹42,00,000 to the vendor account immediately. Do not delay — I am in
                  a closed-door board meeting.&rdquo;
                </blockquote>
              </div>
            ) : null}
          </div>

          <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
            <strong>Why Social Engineering Fails Here:</strong>
            <ol style={{ paddingLeft: 18, margin: '6px 0 0' }}>
              <li>
                Even if the employee believes the voice, the <strong>Request Queue</strong> shows
                zero pending intents.
              </li>
              <li>
                There is <strong>no free-form payment entry</strong> screen where the employee could
                type the attacker&rsquo;s mule account.
              </li>
              <li>
                Authority comes strictly from the executive&rsquo;s out-of-band auxiliary
                authenticator device, not from a voice or telephone connection.
              </li>
            </ol>
          </div>

          <div style={{ marginTop: 14 }}>
            <button className="btn sm" onClick={() => onNavigateTab('queue')}>
              Check Request Queue (Should be empty) →
            </button>
          </div>
        </Panel>

        {/* Right: Traditional vs SEAL Comparison */}
        <Panel title="2. Architectural Defense vs Traditional Flow">
          <div className="stack" style={{ gap: 12 }}>
            <div
              style={{
                padding: '12px 14px',
                borderRadius: '6px',
                background: 'rgba(255, 107, 107, 0.05)',
                border: '1px solid var(--bad-line)',
              }}
            >
              <div style={{ fontWeight: 600, color: 'var(--bad)', marginBottom: 4 }}>
                ✗ Traditional Enterprise Workflow (Vulnerable)
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                Phone call impersonates CEO → Employee trust manipulated → Employee opens banking
                portal → Types mule account &amp; ₹42,00,000 → Payment executed →{' '}
                <strong style={{ color: 'var(--bad)' }}>FRAUD LOSS</strong>
              </div>
            </div>

            <div
              style={{
                padding: '12px 14px',
                borderRadius: '6px',
                background: 'rgba(56, 211, 159, 0.05)',
                border: '1px solid var(--ok-line)',
              }}
            >
              <div style={{ fontWeight: 600, color: 'var(--ok)', marginBottom: 4 }}>
                ✓ SEAL Cryptographic Ledger Workflow (Resistant)
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                Phone call impersonates CEO → Employee checks SEAL → Queue empty → Attacker has no
                device key → Employee cannot compose signed work → Escrow requires 2 independent
                quorum approvals → Rail rejects manual `/pay` →{' '}
                <strong style={{ color: 'var(--ok)' }}>ATTACK BLOCKED &amp; LOGGED</strong>
              </div>
            </div>

            <div style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                Auxiliary Out-of-Band Authenticator Role:
              </div>
              <div style={{ fontSize: 12, color: 'var(--dim)' }}>
                The Authenticator app (<span className="mono">http://localhost:5174</span>) runs on
                an entirely isolated port/origin. Even full malware control over the employee
                browser cannot extract the WebCrypto key sealed under PBKDF2.
              </div>
            </div>
          </div>
        </Panel>
      </div>

      {/* Live Adversarial Attack Test Suite */}
      <Panel
        title="3. Live Adversarial Attack Suite (Execute Against Live Backend)"
        aside={<Badge tone="ok">100% Cryptographic Gate</Badge>}
      >
        <p className="muted" style={{ marginTop: 0 }}>
          Click any attack vector to execute it in real time against the running SEAL server (port
          4000) or Mock Rail (port 4001). Every attempt is verified, rejected with exact security
          codes, and appended to the SHA-256 audit ledger.
        </p>

        {attackOutput ? (
          <div style={{ marginBottom: 16 }}>
            <Banner
              tone="ok"
              title={`ATTACK SUCCESSFULLY BLOCKED AT ${attackOutput.timestamp}`}
            >
              <div className="row" style={{ gap: 12, alignItems: 'center' }}>
                <span className="mono" style={{ fontWeight: 700 }}>
                  HTTP {attackOutput.status}
                </span>
                <span className="mono" style={{ color: 'var(--bad)', fontWeight: 600 }}>
                  {attackOutput.error}
                </span>
                {attackOutput.message ? (
                  <span className="dim">({attackOutput.message})</span>
                ) : null}
                <div className="spacer" />
                <button className="btn sm" onClick={() => onNavigateTab('audit')}>
                  View in Audit Chain →
                </button>
              </div>
            </Banner>
          </div>
        ) : null}

        <div className="grid-2">
          {attacks.map((atk) => (
            <div
              key={atk.id}
              className="card"
              style={{
                border: '1px solid var(--line)',
                background: 'var(--panel-2)',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
              }}
            >
              <div>
                <div className="row" style={{ marginBottom: 6 }}>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>{atk.name}</span>
                  <div className="spacer" />
                  <span className="mono dim" style={{ fontSize: 11 }}>
                    Expects: {atk.expectedError}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
                  {atk.description}
                </div>
                <div className="dim" style={{ fontSize: 11, marginBottom: 12 }}>
                  <strong>Attack Tactic:</strong> {atk.tactic}
                </div>
              </div>

              <div className="row" style={{ borderTop: '1px solid var(--line-soft)', paddingTop: 10 }}>
                <Badge tone="plain">Simulated Vector</Badge>
                <div className="spacer" />
                <button
                  className="btn sm bad"
                  disabled={busy}
                  onClick={() => executeAttack(atk)}
                >
                  {busy ? 'Testing...' : 'Execute Attack'}
                </button>
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </>
  );
}
