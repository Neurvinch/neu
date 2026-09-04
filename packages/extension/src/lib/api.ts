import type {
  CallerChallenge,
  MediaAttestation,
  MediaKind,
  MediaLookup,
  MediaRecord,
  SignatureEnvelope,
  SigningRequest,
  TransactionIntent,
} from '@seal/shared';

const DEFAULTS = { sealUrl: 'http://localhost:4000', token: null as string | null };

export async function config() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...stored } as {
    sealUrl: string;
    token: string | null;
    userId?: string;
    userName?: string;
    userRole?: string;
  };
}

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<T> {
  const { sealUrl, token } = await config();
  const res = await fetch(`${sealUrl}${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(
      (data as { message?: string })?.message ?? (data as { error?: string })?.error ?? res.statusText,
    );
    (err as { code?: string }).code = (data as { error?: string })?.error ?? String(res.status);
    throw err;
  }
  return data as T;
}

/* --------------------------------------------------------------------------
 * The calls the extension actually makes
 * ------------------------------------------------------------------------ */

export const lookupMedia = (sha256: string) => api<MediaLookup>(`/api/media/${sha256}`);

export const mediaAttestationFor = (input: {
  sha256: string;
  kind: MediaKind;
  bytes: number;
  platform: string;
  caption: string;
}) => api<MediaAttestation>('/api/media/attestation', { body: input });

export const submitMediaSignature = (attestation: MediaAttestation, signature: SignatureEnvelope) =>
  api<MediaRecord>('/api/media/sign', { body: { attestation, signature } });

export const listSigningRequests = () => api<SigningRequest[]>('/api/signing-requests');

export const fulfilSigningRequest = (id: string, signature: SignatureEnvelope) =>
  api<SigningRequest>(`/api/signing-requests/${id}/fulfil`, { body: { signature } });

export const declineSigningRequest = (id: string, reason: string) =>
  api<SigningRequest>(`/api/signing-requests/${id}/decline`, { body: { reason } });

export const requestIntentSignature = (intent: TransactionIntent) =>
  api<SigningRequest>('/api/intents', { body: { intent } });

export const listEscrows = () => api<import('@seal/shared').EscrowView[]>('/api/escrows');

export const requestApproval = (escrowId: string, decision: 'APPROVE' | 'REJECT') =>
  api<SigningRequest>(`/api/escrows/${escrowId}/approvals`, { body: { decision } });

export const listChallenges = () => api<CallerChallenge[]>('/api/caller-challenges');

export const raiseChallenge = (input: {
  claimed_user_id: string;
  channel: string;
  demand: string;
  source?: unknown;
}) => api<CallerChallenge>('/api/caller-challenges', { body: input });

export const denyChallenge = (id: string) =>
  api<CallerChallenge>(`/api/caller-challenges/${id}/deny`, { body: { note: 'Not me' } });

export const challengeAttestation = (id: string) =>
  api<import('@seal/shared').CallerAttestation>(`/api/caller-challenges/${id}/attestation`);

export const confirmChallenge = (id: string, signature: SignatureEnvelope) =>
  api<CallerChallenge>(`/api/caller-challenges/${id}/confirm`, { body: { signature } });
