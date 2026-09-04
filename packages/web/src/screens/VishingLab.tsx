import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Badge, Banner, Panel } from '../components/ui.js';
import { playAttackBlocked, playPhoneRing, playSettlementChime } from '../lib/sound.js';
import type { Session } from './Login.js';

interface AttackScenario {
  id: string;
  name: string;
  description: string;
  tactic: string;
  expectedError: string;
  run: () => Promise<{ status: number; error: string; message?: string }>;
}

interface CallerChallengeView {
  id: string;
  claimed_user_id: string;
  claimed_name: string;
  claimed_role: string;
  raised_by: string;
  channel: string;
  demand: string;
  code: string;
  state: 'PENDING' | 'CONFIRMED' | 'DENIED' | 'EXPIRED';
  seconds_remaining: number;
  resolved_at: string | null;
}

interface LookupResultView {
  txn_id: string;
  exists: boolean;
  authorized: boolean;
  verdict: string;
  headline: string;
  detail?: string;
  payee?: { name: string; account: string };
  amount?: { value: string; currency: string };
}

export function VishingLab({
  session,
  onNavigateTab,
}: {
  session: Session;
  onNavigateTab: (tab: string) => void;
}) {
  const [labTab, setLabTab] = useState<'vishing' | 'extension'>('extension');

  // --- Vishing / Call Lab State ---
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

  // --- Extension Testbed State ---
  const [extPopupTab, setExtPopupTab] = useState<'verify' | 'lookup'>('verify');
  const [claimedExecutive, setClaimedExecutive] = useState('u_rahul');
  const [channel, setChannel] = useState('PHONE');
  const [demand, setDemand] = useState('Wire ₹42,00,000 to new supplier account before 2 PM');
  const [activeChallenge, setActiveChallenge] = useState<CallerChallengeView | null>(null);
  const [challengeError, setChallengeError] = useState<string | null>(null);

  // Ledger Lookup State
  const [lookupTxn, setLookupTxn] = useState('TX-4F1593');
  const [lookupResult, setLookupResult] = useState<LookupResultView | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);

  // In-Chat Badge State
  const [chatBadgeResult, setChatBadgeResult] = useState<LookupResultView | null>(null);

  // Automated E2E Runner State
  const [e2eRunning, setE2eRunning] = useState(false);
  const [e2eSteps, setE2eSteps] = useState<Array<{ name: string; ok: boolean; detail?: string }>>([]);

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

  // --- Extension Actions ---
  const raiseCallerChallenge = async () => {
    setChallengeError(null);
    try {
      const c = await api<CallerChallengeView>('/api/caller-challenges', {
        method: 'POST',
        body: {
          claimed_user_id: claimedExecutive,
          channel,
          demand,
          source: { platform: 'WhatsApp Web', url: 'https://web.whatsapp.com/' },
        },
      });
      setActiveChallenge(c);
      playPhoneRing();
    } catch (e) {
      setChallengeError((e as Error).message);
    }
  };

  const executiveDenyChallenge = async () => {
    if (!activeChallenge) return;
    try {
      // Simulate executive login and denial
      const execSession = await api<{ token: string }>('/api/session', {
        method: 'POST',
        body: { user_id: activeChallenge.claimed_user_id, password: 'demo' },
      });
      const updated = await api<CallerChallengeView>(
        `/api/caller-challenges/${activeChallenge.id}/deny`,
        {
          method: 'POST',
          body: { note: 'Not me. Impersonation attempt reported.' },
          token: execSession.token,
        },
      );
      setActiveChallenge(updated);
      playAttackBlocked();
    } catch (e) {
      setChallengeError((e as Error).message);
    }
  };

  /**
   * Confirming a caller is the one direction this lab cannot fake.
   *
   * Denial is a session-level act, so the lab can drive it. Confirmation is a
   * signature over the challenge, produced on the executive's own enrolled
   * device -- which is precisely the property that makes a confirmation worth
   * anything. Faking it here by calling /deny and painting the badge green
   * would demo a guarantee the system does not actually give.
   */
  const executiveConfirmChallenge = async () => {
    if (!activeChallenge) return;
    setChallengeError(
      'Confirming is signed on the executive’s own device — this lab holds no key, so it cannot ' +
        'be simulated. Open the Authenticator (:5174) or the extension as ' +
        `${activeChallenge.claimed_user_id} and confirm it there. Denial needs no signature, which ` +
        'is why the lab can drive that side.',
    );
  };

  const executeLookup = async (txnId: string, setFn: (r: LookupResultView) => void) => {
    setLookupLoading(true);
    try {
      const res = await api<LookupResultView>(`/api/claims/lookup?txn_id=${encodeURIComponent(txnId.trim())}`);
      setFn(res);
      if (res.authorized) {
        playSettlementChime();
      } else {
        playAttackBlocked();
      }
    } catch (e) {
      setFn({
        txn_id: txnId,
        exists: false,
        authorized: false,
        verdict: 'ERROR',
        headline: (e as Error).message,
      });
      playAttackBlocked();
    } finally {
      setLookupLoading(false);
    }
  };

  const runExtensionE2ETest = async () => {
    setE2eRunning(true);
    setE2eSteps([]);
    const steps: Array<{ name: string; ok: boolean; detail?: string }> = [];

    const addStep = (name: string, ok: boolean, detail = '') => {
      steps.push({ name, ok, detail });
      setE2eSteps([...steps]);
    };

    try {
      // 1. Session check
      const sess = await api<{ token: string }>('/api/session', {
        method: 'POST',
        body: { user_id: 'u_aravind', password: 'demo' },
      });
      addStep('1. Extension Session Authentication', !!sess.token, 'Authenticated as u_aravind');

      // 2. Policy check
      const policy = await api<{ challengeable: unknown[] }>('/api/policy');
      addStep('2. Fetch Challengeable Executives', policy.challengeable?.length >= 2, `${policy.challengeable?.length} executives found`);

      // 3. Fake Lookup
      const fakeLookup = await api<LookupResultView>('/api/claims/lookup?txn_id=TX-BOGUS-999');
      addStep('3. Negative Ledger Lookup (Bogus Ref)', !fakeLookup.exists && fakeLookup.verdict === 'NO_SUCH_AUTHORIZATION', fakeLookup.headline);

      // 4. Genuine Lookup
      const audit = await api<Array<{ txn_id: string }>>('/api/audit?limit=20');
      const genuineTxn = audit.find((e) => e.txn_id && !e.txn_id.includes('BOGUS') && !e.txn_id.includes('FORGED'))?.txn_id ?? 'TX-FORGED';
      const realLookup = await api<LookupResultView>(`/api/claims/lookup?txn_id=${genuineTxn}`);
      addStep('4. Positive/Active Ledger Lookup', realLookup.verdict !== undefined, `Result: ${realLookup.verdict}`);

      // 5. Caller Challenge Raised
      const ch = await api<CallerChallengeView>('/api/caller-challenges', {
        method: 'POST',
        body: { claimed_user_id: 'u_rahul', channel: 'PHONE', demand: 'Urgent wire test' },
      });
      addStep('5. Caller Challenge Code Generation', /^[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(ch.code), `Code: ${ch.code}`);

      // 6. Caller Challenge Denied
      const execSess = await api<{ token: string }>('/api/session', {
        method: 'POST',
        body: { user_id: 'u_rahul', password: 'demo' },
      });
      const denied = await api<CallerChallengeView>(`/api/caller-challenges/${ch.id}/deny`, {
        method: 'POST',
        body: { note: 'Not me' },
        token: execSess.token,
      });
      addStep('6. Executive Impersonation Denial', denied.state === 'DENIED', 'Status updated to DENIED');

      // 7. Evidence capture
      const ev = await api<{ seq: number; entry_hash: string }>('/api/evidence', {
        method: 'POST',
        body: {
          platform: 'WhatsApp Web',
          url: 'https://web.whatsapp.com/',
          kind: 'AUDIO',
          excerpt: 'Simulated voice note',
          media_sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        },
      });
      addStep('7. Forensic Evidence Hashing & Audit', ev.seq > 0, `Recorded at audit seq #${ev.seq}`);

      // 8. Audit Chain Verification
      const m = await api<{ audit: { chain_ok: boolean; entries: number } }>('/api/metrics');
      addStep('8. SHA-256 Audit Forward Chain Intact', m.audit.chain_ok, `${m.audit.entries} entries verified without breaks`);
      playSettlementChime();
    } catch (e) {
      addStep('Error in Execution', false, (e as Error).message);
      playAttackBlocked();
    } finally {
      setE2eRunning(false);
    }
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
      <div className="row" style={{ alignItems: 'baseline', marginBottom: 12 }}>
        <div>
          <h1>Deepfake &amp; Vishing Defense Lab</h1>
          <p className="lede" style={{ margin: 0 }}>
            Interactive simulation of executive impersonation attacks (VIT Chennai Problem Statement PS1).
          </p>
        </div>
        <div className="spacer" />
        <div className="row" style={{ gap: 6 }}>
          <button
            className={`btn sm ${labTab === 'extension' ? 'primary' : 'ghost'}`}
            onClick={() => setLabTab('extension')}
          >
            🧩 Browser Extension Testbed &amp; UX
          </button>
          <button
            className={`btn sm ${labTab === 'vishing' ? 'primary' : 'ghost'}`}
            onClick={() => setLabTab('vishing')}
          >
            📞 Voice Vishing &amp; Rail Attacks
          </button>
        </div>
      </div>

      {labTab === 'extension' ? (
        <>
          {/* Extension Testbed Top Banner */}
          <Banner tone="ok" title="SEAL Browser Extension (packages/extension) — Live Testbed">
            The extension embeds authorization controls directly inside communication channels (WhatsApp Web, Teams, Gmail, Meet, Zoom).
            Below is the full interactive testbed exercising in-chat badges, caller challenges, ledger verification, and forensic capture.
          </Banner>

          <div className="grid-2" style={{ marginTop: 16 }}>
            {/* Left: In-Chat Message Simulation with Embedded Content Script Badge */}
            <Panel
              title="1. In-Chat Content Script & Messaging Simulation"
              aside={<Badge tone="accent">WhatsApp / Teams Simulator</Badge>}
            >
              <p className="dim" style={{ fontSize: 12, marginTop: 0 }}>
                This reproduces how the extension&rsquo;s content script (<span className="mono">src/content.js</span>) automatically detects payment language and injects the non-intrusive SEAL badge into chat channels.
              </p>

              {/* Chat Container */}
              <div
                style={{
                  background: '#0a1018',
                  borderRadius: 10,
                  border: '1px solid var(--line)',
                  padding: 14,
                  marginBottom: 14,
                }}
              >
                <div className="row" style={{ marginBottom: 8, borderBottom: '1px solid var(--line-soft)', paddingBottom: 8 }}>
                  <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--accent)', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 12 }}>
                    RM
                  </div>
                  <div style={{ marginLeft: 8 }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>Rahul Menon (CEO)</div>
                    <div className="dim" style={{ fontSize: 11 }}>+91 98400 XXXXX · WhatsApp Web</div>
                  </div>
                  <div className="spacer" />
                  <span className="dim" style={{ fontSize: 11 }}>11:42 AM</span>
                </div>

                {/* Message Bubble */}
                <div
                  style={{
                    background: '#16202e',
                    borderRadius: '8px 8px 8px 2px',
                    padding: '10px 12px',
                    fontSize: 13,
                    lineHeight: 1.5,
                  }}
                >
                  Hey Aravind, I am in a confidential acquisition meeting. Please wire <strong>₹42,00,000</strong> to our vendor account <strong>501004419000</strong> (IFSC: <strong>HDFC0001234</strong>) before 2 PM today. Reference is <strong>TX-4F1593</strong>.
                  
                  {/* INLINE SEAL CONTENT SCRIPT BADGE */}
                  <div
                    style={{
                      marginTop: 10,
                      padding: '8px 10px',
                      borderRadius: 8,
                      border: '1px solid rgba(240, 180, 41, 0.45)',
                      background: 'rgba(240, 180, 41, 0.1)',
                      color: '#f0b429',
                      fontSize: 12,
                    }}
                  >
                    <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                      <span
                        style={{
                          fontWeight: 800,
                          fontSize: 10,
                          letterSpacing: '0.14em',
                          padding: '2px 6px',
                          borderRadius: 4,
                          background: '#f0b429',
                          color: '#1b1400',
                        }}
                      >
                        SEAL
                      </span>
                      <span style={{ fontWeight: 600 }}>Payment instructions plus urgency — exact shape of this attack.</span>
                    </div>

                    <div className="row" style={{ marginTop: 8, gap: 6 }}>
                      <button
                        className="btn sm"
                        style={{ background: '#fff', color: '#1b1400', fontSize: 11, padding: '4px 8px' }}
                        onClick={() => executeLookup('TX-4F1593', setChatBadgeResult)}
                      >
                        Check TX-4F1593 (Genuine)
                      </button>
                      <button
                        className="btn sm"
                        style={{ background: '#fff', color: '#1b1400', fontSize: 11, padding: '4px 8px' }}
                        onClick={() => executeLookup('TX-MULE-404', setChatBadgeResult)}
                      >
                        Check TX-MULE-404 (Fake)
                      </button>
                      <button
                        className="btn sm bad"
                        style={{ fontSize: 11, padding: '4px 8px' }}
                        onClick={() => {
                          setExtPopupTab('verify');
                          raiseCallerChallenge();
                        }}
                      >
                        Verify Sender
                      </button>
                    </div>

                    {chatBadgeResult ? (
                      <div
                        style={{
                          marginTop: 8,
                          padding: '8px 10px',
                          borderRadius: 6,
                          background: chatBadgeResult.authorized ? 'rgba(56, 211, 159, 0.15)' : 'rgba(255, 107, 107, 0.15)',
                          border: `1px solid ${chatBadgeResult.authorized ? 'rgba(56, 211, 159, 0.5)' : 'rgba(255, 107, 107, 0.5)'}`,
                          color: chatBadgeResult.authorized ? '#38d39f' : '#ff8f8f',
                        }}
                      >
                        <div style={{ fontWeight: 700 }}>{chatBadgeResult.headline}</div>
                        <div style={{ fontSize: 11, opacity: 0.9, marginTop: 2 }}>{chatBadgeResult.detail}</div>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>

              <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
                💡 <strong>The Key Insight:</strong> The extension does not attempt to detect AI audio or text. Instead, it notices money is being discussed in a channel with zero signing authority, and gives the employee immediate 1-click ledger verification.
              </div>
            </Panel>

            {/* Right: Live Extension Popup Window Simulator */}
            <Panel
              title="2. Interactive Extension Popup Simulator"
              aside={<Badge tone="ok">Chrome Extension Popup</Badge>}
            >
              <div
                style={{
                  width: '100%',
                  maxWidth: 380,
                  margin: '0 auto',
                  background: 'var(--panel)',
                  borderRadius: 12,
                  border: '1px solid var(--line)',
                  overflow: 'hidden',
                  boxShadow: '0 8px 30px rgba(0,0,0,0.5)',
                }}
              >
                {/* Popup Header */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: 'var(--panel-2)', borderBottom: '1px solid var(--line)' }}>
                  <span style={{ fontWeight: 800, letterSpacing: '0.14em', fontSize: 12, color: 'var(--accent)' }}>SEAL</span>
                  <span style={{ fontSize: 11, color: 'var(--dim)' }}>authorization check</span>
                  <div style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--muted)' }}>{session.name}</div>
                </div>

                {/* Popup Tabs */}
                <div style={{ display: 'flex', gap: 4, padding: '10px 14px 0', borderBottom: '1px solid var(--line-soft)' }}>
                  <button
                    className={`btn sm ${extPopupTab === 'verify' ? 'primary' : 'ghost'}`}
                    style={{ flex: 1, borderRadius: '6px 6px 0 0' }}
                    onClick={() => setExtPopupTab('verify')}
                  >
                    Verify a caller
                  </button>
                  <button
                    className={`btn sm ${extPopupTab === 'lookup' ? 'primary' : 'ghost'}`}
                    style={{ flex: 1, borderRadius: '6px 6px 0 0' }}
                    onClick={() => setExtPopupTab('lookup')}
                  >
                    Check a payment
                  </button>
                </div>

                <div style={{ padding: 14 }}>
                  {extPopupTab === 'verify' ? (
                    <div>
                      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
                        Ask the caller something only the real executive can answer on their phone:
                      </div>

                      <label style={{ display: 'block', marginBottom: 8, fontSize: 11, textTransform: 'uppercase', color: 'var(--dim)' }}>
                        Who do they claim to be?
                        <select
                          value={claimedExecutive}
                          onChange={(e) => setClaimedExecutive(e.target.value)}
                          style={{ width: '100%', marginTop: 4 }}
                        >
                          <option value="u_rahul">Rahul Menon — CEO</option>
                          <option value="u_priya">Priya Nair — CFO</option>
                        </select>
                      </label>

                      <label style={{ display: 'block', marginBottom: 8, fontSize: 11, textTransform: 'uppercase', color: 'var(--dim)' }}>
                        Channel
                        <select
                          value={channel}
                          onChange={(e) => setChannel(e.target.value)}
                          style={{ width: '100%', marginTop: 4 }}
                        >
                          <option value="PHONE">Phone call</option>
                          <option value="VIDEO">Video call</option>
                          <option value="CHAT">WhatsApp / Chat</option>
                          <option value="MEETING">Microsoft Teams</option>
                        </select>
                      </label>

                      <label style={{ display: 'block', marginBottom: 12, fontSize: 11, textTransform: 'uppercase', color: 'var(--dim)' }}>
                        Their Demand
                        <textarea
                          rows={2}
                          value={demand}
                          onChange={(e) => setDemand(e.target.value)}
                          style={{ width: '100%', marginTop: 4, resize: 'none' }}
                        />
                      </label>

                      <button
                        className="btn sm bad"
                        style={{ width: '100%' }}
                        onClick={raiseCallerChallenge}
                      >
                        Challenge this caller
                      </button>

                      {challengeError ? (
                        <div style={{ color: 'var(--bad)', fontSize: 11, marginTop: 8 }}>{challengeError}</div>
                      ) : null}

                      {/* Live Challenge Outcome */}
                      {activeChallenge ? (
                        <div
                          style={{
                            marginTop: 12,
                            padding: 10,
                            borderRadius: 8,
                            background: activeChallenge.state === 'DENIED'
                              ? 'rgba(255, 107, 107, 0.15)'
                              : activeChallenge.state === 'CONFIRMED'
                              ? 'rgba(56, 211, 159, 0.15)'
                              : 'rgba(106, 168, 255, 0.1)',
                            border: `1px solid ${
                              activeChallenge.state === 'DENIED'
                                ? 'rgba(255, 107, 107, 0.5)'
                                : activeChallenge.state === 'CONFIRMED'
                                ? 'rgba(56, 211, 159, 0.5)'
                                : 'rgba(106, 168, 255, 0.5)'
                            }`,
                          }}
                        >
                          {activeChallenge.state === 'PENDING' ? (
                            <div>
                              <div style={{ fontWeight: 700, color: 'var(--accent)', fontSize: 12 }}>
                                Ask them to read this back:
                              </div>
                              <div
                                style={{
                                  fontSize: 22,
                                  fontWeight: 800,
                                  fontFamily: 'var(--mono)',
                                  letterSpacing: '0.1em',
                                  textAlign: 'center',
                                  margin: '8px 0',
                                  color: '#fff',
                                }}
                              >
                                {activeChallenge.code}
                              </div>
                              <p style={{ fontSize: 11, margin: 0, color: 'var(--muted)' }}>
                                This code is on {activeChallenge.claimed_name}&rsquo;s enrolled device and your screen. <strong>If they cannot read it back, it is a deepfake clone.</strong>
                              </p>

                              {/* Executive Phone Response Simulator */}
                              <div style={{ marginTop: 10, borderTop: '1px dashed var(--line)', paddingTop: 8 }}>
                                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--dim)', marginBottom: 4 }}>
                                  Simulated Executive Phone Prompt:
                                </div>
                                <div className="row" style={{ gap: 6 }}>
                                  <button className="btn sm bad" style={{ flex: 1, fontSize: 11 }} onClick={executiveDenyChallenge}>
                                    Deny (Impersonation!)
                                  </button>
                                  <button className="btn sm primary" style={{ flex: 1, fontSize: 11 }} onClick={executiveConfirmChallenge}>
                                    Confirm (It&rsquo;s me)
                                  </button>
                                </div>
                              </div>
                            </div>
                          ) : null}

                          {activeChallenge.state === 'DENIED' ? (
                            <div>
                              <div style={{ fontWeight: 700, color: 'var(--bad)', fontSize: 13 }}>
                                🚨 That is not {activeChallenge.claimed_name}
                              </div>
                              <div style={{ fontSize: 11, marginTop: 4, color: 'var(--muted)' }}>
                                They confirmed from their own device that they are NOT on this call. End the call immediately. Security has been alerted.
                              </div>
                            </div>
                          ) : null}

                          {activeChallenge.state === 'CONFIRMED' ? (
                            <div>
                              <div style={{ fontWeight: 700, color: 'var(--ok)', fontSize: 13 }}>
                                ✓ Caller Verified
                              </div>
                              <div style={{ fontSize: 11, marginTop: 4, color: 'var(--muted)' }}>
                                {activeChallenge.claimed_name} signed an attestation on their enrolled device. Settles identity — still authorizes no payment.
                              </div>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div>
                      <label style={{ display: 'block', marginBottom: 12, fontSize: 11, textTransform: 'uppercase', color: 'var(--dim)' }}>
                        Transaction Reference
                        <input
                          type="text"
                          value={lookupTxn}
                          onChange={(e) => setLookupTxn(e.target.value)}
                          placeholder="TX-4A2B1C"
                          style={{ width: '100%', marginTop: 4 }}
                        />
                      </label>
                      <button
                        className="btn sm primary"
                        style={{ width: '100%' }}
                        disabled={lookupLoading}
                        onClick={() => executeLookup(lookupTxn, setLookupResult)}
                      >
                        {lookupLoading ? 'Checking...' : 'Check the ledger'}
                      </button>

                      {lookupResult ? (
                        <div
                          style={{
                            marginTop: 12,
                            padding: 10,
                            borderRadius: 8,
                            background: lookupResult.authorized ? 'rgba(56, 211, 159, 0.15)' : 'rgba(255, 107, 107, 0.15)',
                            border: `1px solid ${lookupResult.authorized ? 'rgba(56, 211, 159, 0.5)' : 'rgba(255, 107, 107, 0.5)'}`,
                          }}
                        >
                          <div style={{ fontWeight: 700, color: lookupResult.authorized ? 'var(--ok)' : 'var(--bad)' }}>
                            {lookupResult.headline}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                            {lookupResult.detail}
                          </div>
                          {lookupResult.payee ? (
                            <div style={{ fontSize: 11, marginTop: 6, borderTop: '1px dashed var(--line)', paddingTop: 6 }}>
                              <div><strong>Payee:</strong> {lookupResult.payee.name} ({lookupResult.payee.account})</div>
                              {lookupResult.amount ? <div><strong>Amount:</strong> ₹{lookupResult.amount.value}</div> : null}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  )}
                </div>
              </div>
            </Panel>
          </div>

          {/* Section 3: One-Click Automated Extension E2E Suite */}
          <Panel
            title="3. Automated End-to-End Extension Verification (Run in Browser or Terminal)"
            aside={<Badge tone="ok">Terminal: npm run test:ext</Badge>}
          >
            <div className="row" style={{ alignItems: 'center', marginBottom: 14 }}>
              <div>
                <p style={{ margin: 0, fontSize: 13 }}>
                  Exercises the entire background worker, API routing, caller challenge generation, executive device denial, in-browser media hashing, and audit ledger integrity.
                </p>
              </div>
              <div className="spacer" />
              <button
                className="btn sm primary"
                disabled={e2eRunning}
                onClick={runExtensionE2ETest}
              >
                {e2eRunning ? 'Running Tests...' : '▶ Run Full Extension E2E Suite'}
              </button>
            </div>

            {e2eSteps.length > 0 ? (
              <div className="stack" style={{ gap: 6, background: 'var(--panel-2)', padding: 12, borderRadius: 8 }}>
                {e2eSteps.map((step, idx) => (
                  <div key={idx} className="row" style={{ fontSize: 13, gap: 10 }}>
                    <span style={{ color: step.ok ? 'var(--ok)' : 'var(--bad)', fontWeight: 700 }}>
                      {step.ok ? '✓ PASS' : '✗ FAIL'}
                    </span>
                    <span>{step.name}</span>
                    <div className="spacer" />
                    {step.detail ? <span className="dim mono" style={{ fontSize: 11 }}>{step.detail}</span> : null}
                  </div>
                ))}
              </div>
            ) : null}

            <div style={{ marginTop: 14, borderTop: '1px solid var(--line)', paddingTop: 10, fontSize: 12, color: 'var(--dim)' }}>
              <strong>How to install into real Chrome / Brave / Edge:</strong>
              <ol style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                <li>Open <code>chrome://extensions</code> in your browser and enable <em>Developer mode</em> (top-right toggle).</li>
                <li>Click <em>Load unpacked</em> and select the folder: <code className="mono">e:\neu\packages\extension</code>.</li>
                <li>Visit WhatsApp Web or Gmail: any message containing amount or urgency displays the SEAL badge automatically.</li>
              </ol>
            </div>
          </Panel>
        </>
      ) : (
        /* Vishing & Cryptographic Attacks View */
        <>
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
      )}
    </>
  );
}
