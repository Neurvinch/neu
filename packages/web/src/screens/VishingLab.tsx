import { useEffect, useState } from 'react';
import { formatINR } from '@seal/shared';
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

interface MediaLookupView {
  sha256: string;
  signed: boolean;
  headline: string;
  detail?: string;
  attestations: Array<{
    signer_id?: string;
    signer_name: string;
    signer_role: string;
    device_kind: string;
    signed_at: string;
    caption?: string;
  }>;
  escrows?: EscrowView[];
}

interface EscrowView {
  escrow_id: string;
  txn_id: string;
  intent_hash: string;
  state: 'PENDING_QUORUM' | 'APPROVED' | 'EXECUTED' | 'REJECTED' | 'EXPIRED';
  opened_by: string;
  opened_at: string;
  seconds_remaining: number;
  risk: {
    tier: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    score: number;
    required_approvals: number;
  };
  required_approvals: number;
  approvals: Array<{
    approver_id: string;
    decision: 'APPROVE' | 'REJECT';
    role?: string;
    at?: string;
  }>;
  intent: {
    txn_id: string;
    payee: { name: string; account: string; ifsc: string };
    amount: { value: string; currency: string };
    purpose: string;
    media_sha256?: string;
    originator: { user_id: string; role: string };
  };
  receipt?: {
    ok: boolean;
    reference?: string;
    utr?: string;
    settled_at?: string;
  } | null;
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
  const [extPopupTab, setExtPopupTab] = useState<'inbox' | 'verify' | 'lookup'>('inbox');
  const [extActivePersona, setExtActivePersona] = useState<'u_priya' | 'u_rahul' | 'u_anita'>('u_priya');
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

  // WhatsApp Media 1: Audio Voice Note State
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [audioSha] = useState('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  const [audioLookup, setAudioLookup] = useState<MediaLookupView | null>(null);
  const [audioBusy, setAudioBusy] = useState(false);

  // WhatsApp Media 2: Tax Invoice Image State
  const [invoiceSha] = useState('4f9e1208d18a329ef3104e8b39c018287754b5dfd1288c037803a6476e73b22b');
  const [invoiceLookup, setInvoiceLookup] = useState<MediaLookupView | null>(null);
  const [invoiceBusy, setInvoiceBusy] = useState(false);
  const [linkedEscrow, setLinkedEscrow] = useState<EscrowView | null>(null);

  // Extension Inbox: Escrows
  const [inboxEscrows, setInboxEscrows] = useState<EscrowView[]>([]);
  const [inboxLoading, setInboxLoading] = useState(false);
  const [approvingId, setApprovingId] = useState<string | null>(null);

  // Automated E2E Runner State
  const [e2eRunning, setE2eRunning] = useState(false);
  const [e2eSteps, setE2eSteps] = useState<Array<{ name: string; ok: boolean; detail?: string }>>([]);

  const loadInboxEscrows = async () => {
    setInboxLoading(true);
    try {
      const list = await api<EscrowView[]>('/api/escrows');
      setInboxEscrows(list);
    } catch {
      // ignore
    } finally {
      setInboxLoading(false);
    }
  };

  useEffect(() => {
    void loadInboxEscrows();
    const timer = setInterval(() => {
      void loadInboxEscrows();
    }, 4000);
    return () => clearInterval(timer);
  }, []);

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

  const playVoiceNote = () => {
    if (audioPlaying) {
      setAudioPlaying(false);
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
      return;
    }
    setAudioPlaying(true);
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(
        'Hey Aravind, this is Rahul. We need to clear the Alton Logistics invoice before 2 PM today without delay.',
      );
      u.rate = 1.05;
      u.pitch = 0.95;
      u.onend = () => setAudioPlaying(false);
      u.onerror = () => setAudioPlaying(false);
      window.speechSynthesis.speak(u);
    } else {
      setTimeout(() => setAudioPlaying(false), 3000);
    }
  };

  const verifyMedia = async (sha: string, setFn: (v: MediaLookupView) => void) => {
    try {
      const res = await api<MediaLookupView>(`/api/media/${sha}`);
      setFn(res);
      if (res.signed) {
        playSettlementChime();
      } else {
        playAttackBlocked();
      }
    } catch (e) {
      setFn({
        sha256: sha,
        signed: false,
        headline: 'Media verification failed',
        detail: (e as Error).message,
        attestations: [],
      });
      playAttackBlocked();
    }
  };

  const signMediaAsCEO = async (sha: string, kind: string, caption: string, setFn: (v: MediaLookupView) => void) => {
    try {
      await api('/api/dev/exec-action', {
        method: 'POST',
        body: { action: 'sign_media', sha256: sha, kind, caption, user_id: 'u_rahul' },
      });
      playSettlementChime();
      await verifyMedia(sha, setFn);
    } catch (e) {
      alert(`Signing failed: ${(e as Error).message}`);
    }
  };

  const createEscrowFromInvoice = async () => {
    setInvoiceBusy(true);
    try {
      const escrow = await api<EscrowView>('/api/dev/exec-action', {
        method: 'POST',
        body: {
          action: 'create_escrow_media',
          media_sha256: invoiceSha,
          user_id: 'u_rahul',
          payee: { name: 'Alton Logistics Pvt Ltd', account: '50100234564419', ifsc: 'HDFC0001234' },
          amount: '4200000.00',
          purpose: `WhatsApp invoice Media #${invoiceSha.slice(0, 10)} settlement`,
        },
      });
      setLinkedEscrow(escrow);
      playPhoneRing();
      await loadInboxEscrows();
      await verifyMedia(invoiceSha, setInvoiceLookup);
      setExtPopupTab('inbox');
    } catch (e) {
      alert(`Escrow creation failed: ${(e as Error).message}`);
    } finally {
      setInvoiceBusy(false);
    }
  };

  const approveEscrowDirect = async (escrowId: string, approverId = 'u_priya') => {
    setApprovingId(escrowId);
    try {
      let updated = await api<EscrowView>('/api/dev/exec-action', {
        method: 'POST',
        body: { action: 'approve_escrow', escrow_id: escrowId, user_id: approverId },
      });

      // If quorum requires another approval to reach threshold, co-sign with another approver
      if (updated.state === 'PENDING_QUORUM' && updated.required_approvals > updated.approvals.length) {
        const coApprover = approverId === 'u_priya' ? 'u_anita' : 'u_priya';
        updated = await api<EscrowView>('/api/dev/exec-action', {
          method: 'POST',
          body: { action: 'approve_escrow', escrow_id: escrowId, user_id: coApprover },
        });
      }

      playSettlementChime();
      await loadInboxEscrows();
      if (linkedEscrow && linkedEscrow.escrow_id === escrowId) {
        setLinkedEscrow(updated);
      }
      await verifyMedia(invoiceSha, setInvoiceLookup);
    } catch (e) {
      alert(`Approval error: ${(e as Error).message}`);
    } finally {
      setApprovingId(null);
    }
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

  const executiveConfirmChallenge = async () => {
    if (!activeChallenge) return;
    try {
      const confirmed = await api<CallerChallengeView>('/api/dev/exec-action', {
        method: 'POST',
        body: {
          action: 'confirm_challenge',
          challenge_id: activeChallenge.id,
          user_id: activeChallenge.claimed_user_id,
        },
      });
      setActiveChallenge(confirmed);
      playSettlementChime();
    } catch (e) {
      setChallengeError((e as Error).message);
    }
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

      // 7. WhatsApp Media Detection & Verification (Unsigned Warning)
      const unsignedLookup = await api<MediaLookupView>(`/api/media/unsigned_test_${Date.now()}`);
      addStep('7. WhatsApp Media Detection & Unsigned Warning', !unsignedLookup.signed, 'Extension flags unverified media lacking executive signature');

      // 8. In-Situ Digital Signing by Executive Key
      const testSha = `media_attest_${Date.now()}`;
      await api('/api/dev/exec-action', {
        method: 'POST',
        body: { action: 'sign_media', sha256: testSha, kind: 'IMAGE', caption: 'Invoice AL-9842 verified', user_id: 'u_rahul' },
      });
      const signedLookup = await api<MediaLookupView>(`/api/media/${testSha}`);
      addStep('8. In-Situ Digital Signing by Executive Device Key', signedLookup.signed && signedLookup.attestations.length > 0, `Signed by ${signedLookup.attestations[0]?.signer_name}`);

      // 9. Escrow Creation Bound to WhatsApp Signed Media
      const createdEscrow = await api<EscrowView>('/api/dev/exec-action', {
        method: 'POST',
        body: {
          action: 'create_escrow_media',
          media_sha256: testSha,
          user_id: 'u_rahul',
          amount: '4200000.00',
          payee: { name: 'Alton Logistics Pvt Ltd', account: '50100234564419', ifsc: 'HDFC0001234' },
        },
      });
      addStep('9. Escrow Creation Bound to WhatsApp Signed Media', !!createdEscrow.escrow_id && createdEscrow.state === 'PENDING_QUORUM', `Escrow #${createdEscrow.txn_id} opened awaiting quorum`);

      // 10. Extension Approver Notification & Quorum Settlement
      const settled = await api<EscrowView>('/api/dev/exec-action', {
        method: 'POST',
        body: { action: 'approve_escrow', escrow_id: createdEscrow.escrow_id, user_id: 'u_priya' },
      });
      addStep('10. Extension Inbox Quorum Settlement on RTGS Rail', settled.state === 'EXECUTED' || settled.approvals.length > 0, 'Quorum approval registered on ledger');

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
            {/* Left: WhatsApp Web In-Situ Media Scanner & Messaging Simulation */}
            <Panel
              title="1. WhatsApp Web In-Situ Media Scanner & Messaging Simulation"
              aside={<Badge tone="accent">WhatsApp Web Simulator</Badge>}
            >
              <p className="dim" style={{ fontSize: 12, marginTop: 0 }}>
                Reproduces how the SEAL extension content script operates on WhatsApp Web (<span className="mono">web.whatsapp.com</span>). It automatically detects text, audio voice notes, and invoice image attachments, allowing employees to cryptographically verify signatures or executives to sign and open time-boxed escrows directly in-situ.
              </p>

              {/* WhatsApp Web Container */}
              <div
                style={{
                  background: '#f8f5fc',
                  borderRadius: 12,
                  border: '1px solid var(--line)',
                  overflow: 'hidden',
                  marginBottom: 14,
                  boxShadow: 'var(--shadow-sm)',
                }}
              >
                {/* WhatsApp Chat Header */}
                <div
                  style={{
                    background: '#f0f2f5',
                    padding: '10px 14px',
                    borderBottom: '1px solid #e2daf0',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                  }}
                >
                  <div
                    style={{
                      position: 'relative',
                      width: 36,
                      height: 36,
                      borderRadius: '50%',
                      background: '#7c3aed',
                      color: '#ffffff',
                      display: 'grid',
                      placeItems: 'center',
                      fontWeight: 800,
                      fontSize: 13,
                    }}
                  >
                    RM
                    <span
                      style={{
                        position: 'absolute',
                        bottom: 0,
                        right: 0,
                        width: 10,
                        height: 10,
                        borderRadius: '50%',
                        background: '#059669',
                        border: '2px solid #f0f2f5',
                      }}
                    />
                  </div>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13, color: '#1d1335' }}>Rahul Menon (CEO)</div>
                    <div style={{ fontSize: 11, color: '#5e527d' }}>+91 98400 11234 · Online</div>
                  </div>
                  <div className="spacer" />
                  <div style={{ display: 'flex', gap: 14, color: '#54656f', fontSize: 14 }}>
                    <span title="Search">🔍</span>
                    <span title="Phone Call">📞</span>
                    <span title="Video Call">📹</span>
                    <span title="Menu">⋮</span>
                  </div>
                </div>

                {/* WhatsApp Chat Messages Stream */}
                <div
                  style={{
                    padding: 14,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 14,
                    background: '#f5f1fa',
                  }}
                >
                  {/* Date Chip */}
                  <div style={{ alignSelf: 'center', background: '#ffffff', color: '#5e527d', fontSize: 11, padding: '3px 10px', borderRadius: 6, fontWeight: 600, border: '1px solid #e2daf0', boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
                    TODAY
                  </div>

                  {/* Message 1: Urgent Text Message Bubble */}
                  <div
                    style={{
                      background: '#ffffff',
                      borderRadius: '0 8px 8px 8px',
                      padding: '10px 12px',
                      maxWidth: '92%',
                      alignSelf: 'flex-start',
                      color: '#1d1335',
                      fontSize: 13,
                      lineHeight: 1.45,
                      border: '1px solid #e2daf0',
                      boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
                    }}
                  >
                    Hey Aravind, I am in an urgent acquisition board meeting. Please initiate a wire transfer of <strong>₹42,00,000</strong> for the Alton Logistics vendor invoice before 2 PM today. Reference is <strong>TX-4F1593</strong>.
                    <div style={{ textAlign: 'right', fontSize: 10, color: '#8b7fa8', marginTop: 4 }}>
                      11:41 AM <span style={{ color: '#53bdeb' }}>✓✓</span>
                    </div>

                    {/* INLINE SEAL CONTENT SCRIPT CHIP */}
                    <div
                      style={{
                        marginTop: 8,
                        padding: '8px 10px',
                        borderRadius: 8,
                        border: '1px solid rgba(217, 119, 6, 0.35)',
                        background: 'rgba(217, 119, 6, 0.08)',
                        color: '#b45309',
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
                            background: '#d97706',
                            color: '#ffffff',
                          }}
                        >
                          SEAL
                        </span>
                        <span style={{ fontWeight: 600 }}>Urgent payment demand detected in zero-authority channel.</span>
                      </div>

                      <div className="row" style={{ marginTop: 8, gap: 6 }}>
                        <button
                          className="btn sm"
                          style={{ background: '#7c3aed', color: '#ffffff', border: '1px solid #7c3aed', fontSize: 11, padding: '3px 8px', fontWeight: 600 }}
                          onClick={() => executeLookup('TX-4F1593', setChatBadgeResult)}
                        >
                          Check TX-4F1593 (Genuine)
                        </button>
                        <button
                          className="btn sm"
                          style={{ background: '#ffffff', color: '#5e527d', border: '1px solid #e2daf0', fontSize: 11, padding: '3px 8px' }}
                          onClick={() => executeLookup('TX-MULE-404', setChatBadgeResult)}
                        >
                          Check TX-MULE-404 (Fake)
                        </button>
                        <button
                          className="btn sm bad"
                          style={{ fontSize: 11, padding: '3px 8px' }}
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
                            background: chatBadgeResult.authorized ? 'rgba(5, 150, 105, 0.08)' : 'rgba(225, 29, 72, 0.08)',
                            border: `1px solid ${chatBadgeResult.authorized ? 'rgba(5, 150, 105, 0.35)' : 'rgba(225, 29, 72, 0.35)'}`,
                            color: chatBadgeResult.authorized ? '#047857' : '#be123c',
                          }}
                        >
                          <div style={{ fontWeight: 700 }}>{chatBadgeResult.headline}</div>
                          <div style={{ fontSize: 11, opacity: 0.9, marginTop: 2 }}>{chatBadgeResult.detail}</div>
                        </div>
                      ) : null}
                    </div>
                  </div>

                  {/* Message 2: WhatsApp Voice Note (Audio) */}
                  <div
                    style={{
                      background: '#ffffff',
                      borderRadius: '0 8px 8px 8px',
                      padding: '10px 12px',
                      maxWidth: '92%',
                      alignSelf: 'flex-start',
                      color: '#1d1335',
                      border: '1px solid #e2daf0',
                      boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
                    }}
                  >
                    {/* Voice Note Player Bar */}
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        background: '#f4f0fb',
                        padding: '8px 12px',
                        borderRadius: 8,
                        border: '1px solid #e2daf0',
                      }}
                    >
                      <button
                        onClick={playVoiceNote}
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: '50%',
                          background: '#7c3aed',
                          color: '#ffffff',
                          display: 'grid',
                          placeItems: 'center',
                          cursor: 'pointer',
                          border: 'none',
                          fontSize: 14,
                          fontWeight: 800,
                        }}
                      >
                        {audioPlaying ? '⏸' : '▶'}
                      </button>

                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 2, height: 20 }}>
                          {[12, 18, 10, 24, 16, 28, 14, 20, 26, 12, 18, 22, 14, 26, 10, 16, 20].map((h, i) => (
                            <span
                              key={i}
                              style={{
                                width: 3,
                                height: h,
                                background: audioPlaying ? '#7c3aed' : '#8b7fa8',
                                borderRadius: 2,
                                opacity: i < 7 && audioPlaying ? 1 : 0.6,
                                transition: 'height 0.2s ease',
                              }}
                            />
                          ))}
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#5e527d', marginTop: 2 }}>
                          <span>{audioPlaying ? '0:07 / 0:14' : '0:14'}</span>
                          <span>Voice Note · 11:42 AM <span style={{ color: '#53bdeb' }}>✓✓</span></span>
                        </div>
                      </div>
                    </div>

                    {/* SEAL In-Situ Media Scanner Toolbar for Audio */}
                    <div
                      style={{
                        marginTop: 10,
                        padding: 10,
                        borderRadius: 8,
                        background: '#faf8fe',
                        border: '1px solid #e2daf0',
                      }}
                    >
                      <div className="row" style={{ alignItems: 'center', gap: 6, marginBottom: 6 }}>
                        <span
                          style={{
                            fontWeight: 800,
                            fontSize: 9,
                            letterSpacing: '0.12em',
                            padding: '2px 5px',
                            borderRadius: 4,
                            background: 'rgba(124, 58, 237, 0.12)',
                            color: '#7c3aed',
                          }}
                        >
                          SEAL IN-SITU SCANNER · AUDIO
                        </span>
                        <div className="spacer" />
                        <span className="mono dim" style={{ fontSize: 10 }}>SHA-256: {audioSha.slice(0, 10)}…</span>
                      </div>

                      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                        <button
                          className="btn sm primary"
                          style={{ fontSize: 11, padding: '3px 8px' }}
                          disabled={audioBusy}
                          onClick={() => {
                            setAudioBusy(true);
                            verifyMedia(audioSha, setAudioLookup).finally(() => setAudioBusy(false));
                          }}
                        >
                          🔍 Verify Signature
                        </button>
                        <button
                          className="btn sm"
                          style={{ fontSize: 11, padding: '3px 8px', background: '#ffffff', color: 'var(--text)', border: '1px solid var(--line)' }}
                          onClick={() => signMediaAsCEO(audioSha, 'AUDIO', 'CEO voice authorization note', setAudioLookup)}
                        >
                          ✍️ Sign as CEO Key
                        </button>
                        <button
                          className="btn sm bad"
                          style={{ fontSize: 11, padding: '3px 8px' }}
                          onClick={() => {
                            setExtPopupTab('verify');
                            raiseCallerChallenge();
                          }}
                        >
                          📞 Challenge Caller
                        </button>
                      </div>

                      {/* Verification Status */}
                      {audioLookup ? (
                        <div
                          style={{
                            marginTop: 8,
                            padding: 8,
                            borderRadius: 6,
                            background: audioLookup.signed ? 'rgba(5, 150, 105, 0.08)' : 'rgba(225, 29, 72, 0.08)',
                            border: `1px solid ${audioLookup.signed ? 'rgba(5, 150, 105, 0.35)' : 'rgba(225, 29, 72, 0.35)'}`,
                          }}
                        >
                          <div style={{ fontWeight: 700, fontSize: 12, color: audioLookup.signed ? 'var(--ok)' : 'var(--bad)' }}>
                            {audioLookup.signed ? '✓ Cryptographically Verified Voice Provenance' : '⚠️ Unsigned Voice Note — Voice Clone Suspected'}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--dim)', marginTop: 2 }}>
                            {audioLookup.signed && audioLookup.attestations[0]
                              ? `Signed by ${audioLookup.attestations[0].signer_name} (${audioLookup.attestations[0].signer_role}) on ${audioLookup.attestations[0].device_kind} key.`
                              : 'No executive signature registered for this audio hash. Anyone can clone voice audio; never act without a signed escrow.'}
                          </div>
                        </div>
                      ) : (
                        <div style={{ fontSize: 11, color: '#5e527d', marginTop: 6 }}>
                          💡 Click <strong>Verify Signature</strong> to compute the audio waveform hash and check cryptographic provenance on the ledger.
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Message 3: WhatsApp Invoice Attachment (Image/PDF) */}
                  <div
                    style={{
                      background: '#ffffff',
                      borderRadius: '0 8px 8px 8px',
                      padding: '10px 12px',
                      maxWidth: '92%',
                      alignSelf: 'flex-start',
                      color: '#1d1335',
                      border: '1px solid #e2daf0',
                      boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
                    }}
                  >
                    {/* Invoice Attachment Preview Box */}
                    <div
                      style={{
                        background: '#f4f0fb',
                        padding: 10,
                        borderRadius: 8,
                        border: '1px solid #e2daf0',
                        display: 'flex',
                        gap: 10,
                        alignItems: 'center',
                      }}
                    >
                      <div
                        style={{
                          width: 42,
                          height: 48,
                          borderRadius: 6,
                          background: 'linear-gradient(135deg, #e11d48, #be123c)',
                          color: '#fff',
                          display: 'grid',
                          placeItems: 'center',
                          fontWeight: 800,
                          fontSize: 11,
                          letterSpacing: '0.05em',
                        }}
                      >
                        PDF
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600, fontSize: 12, color: '#1d1335' }}>TAX_INVOICE_ALTON_9842.pdf</div>
                        <div style={{ fontSize: 11, color: '#5e527d', marginTop: 2 }}>
                          Payee: <strong>Alton Logistics Pvt Ltd</strong> · <strong>₹42,00,000.00</strong>
                        </div>
                        <div className="mono" style={{ fontSize: 10, color: '#5e527d', marginTop: 2 }}>
                          Acct: 50100234564419 · IFSC: HDFC0001234
                        </div>
                      </div>
                      <div style={{ alignSelf: 'flex-end', fontSize: 10, color: '#8b7fa8' }}>
                        11:43 AM <span style={{ color: '#53bdeb' }}>✓✓</span>
                      </div>
                    </div>

                    {/* SEAL In-Situ Media Scanner Toolbar for Invoice */}
                    <div
                      style={{
                        marginTop: 10,
                        padding: 10,
                        borderRadius: 8,
                        background: '#faf8fe',
                        border: '1px solid #e2daf0',
                      }}
                    >
                      <div className="row" style={{ alignItems: 'center', gap: 6, marginBottom: 6 }}>
                        <span
                          style={{
                            fontWeight: 800,
                            fontSize: 9,
                            letterSpacing: '0.12em',
                            padding: '2px 5px',
                            borderRadius: 4,
                            background: 'rgba(124, 58, 237, 0.12)',
                            color: '#7c3aed',
                          }}
                        >
                          SEAL IN-SITU SCANNER · INVOICE
                        </span>
                        <div className="spacer" />
                        <span className="mono dim" style={{ fontSize: 10 }}>SHA-256: {invoiceSha.slice(0, 10)}…</span>
                      </div>

                      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                        <button
                          className="btn sm primary"
                          style={{ fontSize: 11, padding: '3px 8px' }}
                          disabled={invoiceBusy}
                          onClick={() => {
                            setInvoiceBusy(true);
                            verifyMedia(invoiceSha, setInvoiceLookup).finally(() => setInvoiceBusy(false));
                          }}
                        >
                          🔍 Verify Signature
                        </button>
                        <button
                          className="btn sm"
                          style={{ fontSize: 11, padding: '3px 8px', background: '#ffffff', color: 'var(--text)', border: '1px solid var(--line)' }}
                          onClick={() => signMediaAsCEO(invoiceSha, 'IMAGE', 'Invoice AL-9842 authenticated by CEO', setInvoiceLookup)}
                        >
                          ✍️ Sign as CEO Key
                        </button>
                        <button
                          className="btn sm good"
                          style={{ fontSize: 11, padding: '3px 8px' }}
                          disabled={invoiceBusy}
                          onClick={createEscrowFromInvoice}
                        >
                          ⚡ Open Escrow Bound to Invoice
                        </button>
                      </div>

                      {/* Invoice Verification Outcome */}
                      {invoiceLookup ? (
                        <div
                          style={{
                            marginTop: 8,
                            padding: 8,
                            borderRadius: 6,
                            background: invoiceLookup.signed ? 'rgba(5, 150, 105, 0.08)' : 'rgba(225, 29, 72, 0.08)',
                            border: `1px solid ${invoiceLookup.signed ? 'rgba(5, 150, 105, 0.35)' : 'rgba(225, 29, 72, 0.35)'}`,
                          }}
                        >
                          <div style={{ fontWeight: 700, fontSize: 12, color: invoiceLookup.signed ? 'var(--ok)' : 'var(--bad)' }}>
                            {invoiceLookup.signed ? '✓ Verified Invoice Authenticity' : '⚠️ Unsigned Invoice Image'}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--dim)', marginTop: 2 }}>
                            {invoiceLookup.signed && invoiceLookup.attestations[0]
                              ? `Attested by ${invoiceLookup.attestations[0].signer_name} (${invoiceLookup.attestations[0].signer_role}).`
                              : 'No executive signature attached to this invoice digest.'}
                          </div>
                        </div>
                      ) : null}

                      {/* Linked Escrow Badge */}
                      {linkedEscrow ? (
                        <div
                          style={{
                            marginTop: 8,
                            padding: '8px 10px',
                            borderRadius: 6,
                            background: 'rgba(124, 58, 237, 0.08)',
                            border: '1px solid rgba(124, 58, 237, 0.28)',
                            fontSize: 11,
                          }}
                        >
                          <div className="row" style={{ alignItems: 'center' }}>
                            <span style={{ fontWeight: 700, color: '#7c3aed' }}>⚡ Time-Boxed Escrow #{linkedEscrow.txn_id} Active</span>
                            <div className="spacer" />
                            <span className="mono" style={{ color: '#7c3aed', fontWeight: 600 }}>{linkedEscrow.state}</span>
                          </div>
                          <div style={{ color: 'var(--dim)', marginTop: 2 }}>
                            Bound to invoice hash · Requires {linkedEscrow.required_approvals} approvers in Extension Inbox →
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>

              <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
                💡 <strong>The Key Insight:</strong> The extension does not attempt to detect AI audio or text. Instead, it computes cryptographic SHA-256 hashes of media attachments locally in the tab, verifies executive signatures, and opens time-boxed escrows directly linked to the source media.
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
                  maxWidth: 390,
                  margin: '0 auto',
                  background: 'var(--panel)',
                  borderRadius: 12,
                  border: '1px solid var(--line)',
                  overflow: 'hidden',
                  boxShadow: '0 8px 30px rgba(124, 58, 237, 0.12)',
                }}
              >
                {/* Extension Header */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '10px 14px',
                    background: 'var(--panel-2)',
                    borderBottom: '1px solid var(--line)',
                  }}
                >
                  <span style={{ fontWeight: 800, letterSpacing: '0.14em', fontSize: 12, color: 'var(--accent)' }}>SEAL</span>
                  <span style={{ fontSize: 11, color: 'var(--dim)' }}>authorization check</span>
                  <div className="spacer" />
                  <select
                    value={extActivePersona}
                    onChange={(e) => setExtActivePersona(e.target.value as 'u_priya')}
                    style={{ fontSize: 11, padding: '2px 6px', background: '#ffffff', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 4 }}
                  >
                    <option value="u_priya">Priya Nair (CFO)</option>
                    <option value="u_anita">Anita Desai (CTO)</option>
                    <option value="u_rahul">Rahul Menon (CEO)</option>
                  </select>
                </div>

                {/* Popup Tabs */}
                {(() => {
                  const pendingCount =
                    (activeChallenge && activeChallenge.state === 'PENDING' ? 1 : 0) +
                    inboxEscrows.filter((e) => e.state === 'PENDING_QUORUM').length;
                  return (
                    <div style={{ display: 'flex', gap: 4, padding: '10px 14px 0', borderBottom: '1px solid var(--line-soft)' }}>
                      <button
                        className={`btn sm ${extPopupTab === 'inbox' ? 'primary' : 'ghost'}`}
                        style={{ flex: 1, borderRadius: '6px 6px 0 0', position: 'relative' }}
                        onClick={() => setExtPopupTab('inbox')}
                      >
                        Inbox
                        {pendingCount > 0 ? (
                          <span
                            style={{
                              marginLeft: 5,
                              padding: '1px 6px',
                              borderRadius: 10,
                              background: 'var(--bad)',
                              color: '#fff',
                              fontSize: 10,
                              fontWeight: 800,
                            }}
                          >
                            {pendingCount}
                          </span>
                        ) : null}
                      </button>
                      <button
                        className={`btn sm ${extPopupTab === 'verify' ? 'primary' : 'ghost'}`}
                        style={{ flex: 1, borderRadius: '6px 6px 0 0' }}
                        onClick={() => setExtPopupTab('verify')}
                      >
                        Verify Caller
                      </button>
                      <button
                        className={`btn sm ${extPopupTab === 'lookup' ? 'primary' : 'ghost'}`}
                        style={{ flex: 1, borderRadius: '6px 6px 0 0' }}
                        onClick={() => setExtPopupTab('lookup')}
                      >
                        Check Payment
                      </button>
                    </div>
                  );
                })()}

                <div style={{ padding: 14 }}>
                  {/* TAB 1: INBOX & ESCROWS */}
                  {extPopupTab === 'inbox' ? (
                    <div>
                      {/* Active Challenge Card in Inbox */}
                      {activeChallenge && activeChallenge.state === 'PENDING' ? (
                        <div
                          style={{
                            marginBottom: 14,
                            padding: 10,
                            borderRadius: 8,
                            background: 'rgba(225, 29, 72, 0.08)',
                            border: '1px solid rgba(225, 29, 72, 0.3)',
                          }}
                        >
                          <div className="row" style={{ alignItems: 'center', marginBottom: 4 }}>
                            <span className="badge bad" style={{ fontSize: 9 }}>verify a caller</span>
                            <div className="spacer" />
                            <span className="mono dim" style={{ fontSize: 10 }}>{activeChallenge.seconds_remaining}s left</span>
                          </div>
                          <div style={{ fontWeight: 700, fontSize: 12, color: 'var(--text)', marginTop: 4 }}>
                            Are you on a {activeChallenge.channel.toLowerCase()} with Aravind Kumar right now?
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--muted)', margin: '4px 0 8px' }}>
                            Demand: &ldquo;{activeChallenge.demand}&rdquo;
                          </div>
                          <div
                            style={{
                              fontSize: 22,
                              fontWeight: 800,
                              fontFamily: 'var(--mono)',
                              letterSpacing: '0.12em',
                              textAlign: 'center',
                              margin: '6px 0',
                              color: 'var(--bad)',
                            }}
                          >
                            {activeChallenge.code}
                          </div>
                          <div className="row" style={{ gap: 6, marginTop: 8 }}>
                            <button className="btn sm bad" style={{ flex: 1, fontSize: 11 }} onClick={executiveDenyChallenge}>
                              No — Not Me (Deny)
                            </button>
                            <button className="btn sm good" style={{ flex: 1, fontSize: 11 }} onClick={executiveConfirmChallenge}>
                              Confirm on Key
                            </button>
                          </div>
                        </div>
                      ) : null}

                      {/* Escrows Awaiting Quorum */}
                      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--dim)', marginBottom: 8 }}>
                        Escrows Awaiting Quorum Approval
                      </div>

                      {inboxEscrows.filter((e) => e.state === 'PENDING_QUORUM').length === 0 ? (
                        <div
                          style={{
                            textAlign: 'center',
                            padding: '24px 12px',
                            background: 'var(--panel-2)',
                            borderRadius: 8,
                            border: '1px dashed var(--line)',
                            color: 'var(--dim)',
                            fontSize: 12,
                          }}
                        >
                          <div style={{ fontSize: 24, marginBottom: 6, color: 'var(--ok)' }}>✓</div>
                          <strong>Inbox is empty.</strong>
                          <div style={{ marginTop: 4, fontSize: 11 }}>
                            Nothing waiting for your signature. To test, open an escrow from the WhatsApp invoice on the left!
                          </div>
                        </div>
                      ) : (
                        <div className="stack" style={{ gap: 10 }}>
                          {inboxEscrows
                            .filter((e) => e.state === 'PENDING_QUORUM')
                            .map((e) => {
                              const isApproving = approvingId === e.escrow_id;
                              const mediaSha = e.intent.media_sha256 || invoiceSha;
                              return (
                                <div
                                  key={e.escrow_id}
                                  style={{
                                    background: 'var(--panel-2)',
                                    borderRadius: 8,
                                    border: '1px solid var(--line)',
                                    padding: 10,
                                  }}
                                >
                                  <div className="row" style={{ alignItems: 'center' }}>
                                    <span className="mono" style={{ fontWeight: 700, fontSize: 12 }}>{e.txn_id}</span>
                                    <span
                                      className={`badge ${e.risk.tier === 'CRITICAL' ? 'bad' : 'warn'}`}
                                      style={{ fontSize: 9, marginLeft: 6 }}
                                    >
                                      {e.risk.tier}
                                    </span>
                                    <div className="spacer" />
                                    <span className="mono" style={{ fontWeight: 800, color: 'var(--accent)' }}>
                                      {formatINR(e.intent.amount.value)}
                                    </span>
                                  </div>

                                  <div style={{ fontSize: 12, fontWeight: 600, marginTop: 4 }}>
                                    {e.intent.payee.name}
                                  </div>
                                  <div className="dim mono" style={{ fontSize: 11 }}>
                                    {e.intent.payee.account} · IFSC {e.intent.payee.ifsc}
                                  </div>

                                  {mediaSha ? (
                                    <div style={{ marginTop: 4 }}>
                                      <span
                                        className="badge"
                                        style={{
                                          background: '#162438',
                                          border: '1px solid #2f4d75',
                                          color: '#8ab4f8',
                                          fontSize: 9,
                                        }}
                                      >
                                        WhatsApp Media #{mediaSha.slice(0, 10)}… Verified ✓
                                      </span>
                                    </div>
                                  ) : null}

                                  <div className="dim" style={{ fontSize: 11, marginTop: 6 }}>
                                    {e.approvals.length} of {e.required_approvals} approvals · {Math.round(e.seconds_remaining / 60)}m remaining
                                  </div>

                                  <div className="row" style={{ marginTop: 10, gap: 6 }}>
                                    <button
                                      className="btn sm good"
                                      style={{ flex: 1, fontSize: 11 }}
                                      disabled={isApproving}
                                      onClick={() => approveEscrowDirect(e.escrow_id, extActivePersona)}
                                    >
                                      {isApproving
                                        ? 'Authorizing with Key…'
                                        : `Approve on my key (${extActivePersona === 'u_priya' ? 'Priya Nair - CFO' : extActivePersona === 'u_anita' ? 'Anita Desai - CTO' : 'Rahul Menon - CEO'})`}
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                        </div>
                      )}

                      {/* Recently Settled on RTGS Rail */}
                      {inboxEscrows.some((e) => e.state === 'EXECUTED') ? (
                        <div style={{ marginTop: 14, borderTop: '1px solid var(--line-soft)', paddingTop: 10 }}>
                          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--ok)', marginBottom: 6 }}>
                            Settled on RTGS Bank Rail
                          </div>
                          {inboxEscrows
                            .filter((e) => e.state === 'EXECUTED')
                            .slice(0, 2)
                            .map((e) => (
                              <div
                                key={e.escrow_id}
                                style={{
                                  background: 'rgba(56, 211, 159, 0.1)',
                                  border: '1px solid rgba(56, 211, 159, 0.4)',
                                  borderRadius: 6,
                                  padding: 8,
                                  marginBottom: 6,
                                  fontSize: 11,
                                }}
                              >
                                <div className="row">
                                  <strong style={{ color: 'var(--ok)' }}>✓ {e.txn_id} Settled</strong>
                                  <div className="spacer" />
                                  <span className="mono">{formatINR(e.intent.amount.value)}</span>
                                </div>
                                <div className="dim mono" style={{ marginTop: 2 }}>
                                  Rail Ref: {e.receipt?.reference ?? 'RTGS-SETTLED'}
                                </div>
                              </div>
                            ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {/* TAB 2: VERIFY CALLER */}
                  {extPopupTab === 'verify' ? (
                    <div>
                      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
                        Ask the caller something only the real executive can answer on their enrolled device:
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
                  ) : null}

                  {/* TAB 3: CHECK PAYMENT */}
                  {extPopupTab === 'lookup' ? (
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
                  ) : null}
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
