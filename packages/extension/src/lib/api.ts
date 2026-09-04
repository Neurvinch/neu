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

/**
 * Every key config() needs must appear here.
 *
 * chrome.storage.local.get(obj) returns *only* the keys present in obj, so
 * anything omitted comes back undefined no matter what was stored. Leaving the
 * identity fields out meant the extension forgot who you were the moment the
 * popup asked, and every signing path failed with "Sign in first".
 */
const DEFAULTS = {
  sealUrl: 'http://localhost:4000',
  token: null as string | null,
  userId: null as string | null,
  userName: null as string | null,
  userRole: null as string | null,
};

export type Config = typeof DEFAULTS;

export async function config(): Promise<Config> {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...stored } as Config;
}

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<T> {
  const { sealUrl, token } = await config();
  let res: Response;
  try {
    res = await fetch(`${sealUrl}${path}`, {
      method: opts.method ?? (opts.body ? 'POST' : 'GET'),
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    // See the note in the other clients: naming the unreachable service
    // is the only part of a transport failure worth showing a person.
    const err = new Error(
      `Cannot reach SEAL at ${sealUrl}. Is it running, and is the URL right under Key -> Server?`,
    ) as Error & { code?: string };
    err.code = 'SEAL_UNREACHABLE';
    throw err;
  }
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
