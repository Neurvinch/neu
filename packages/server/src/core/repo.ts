import type {
  ApprovalAssertion,
  ApprovalRecord,
  CredentialBinding,
  DeviceKind,
  Lane,
  Role,
  SignatureEnvelope,
  TransactionIntent,
} from '@seal/shared';
import { db } from '../db.js';

export interface UserRow {
  id: string;
  name: string;
  role: Role;
  email: string | null;
  demo_password: string;
  approval_limit_paise: number;
  created_at: string;
}

export interface CredentialRow {
  credential_id: string;
  user_id: string;
  binding: CredentialBinding;
  device_kind: DeviceKind;
  public_key: string;
  webauthn_id: string | null;
  aaguid: string | null;
  label: string | null;
  counter: number;
  state: 'PENDING' | 'ACTIVE' | 'REVOKED';
  created_at: string;
  activated_at: string | null;
}

export interface IntentRow {
  txn_id: string;
  org_id: string;
  intent_json: string;
  intent_hash: string;
  signature_json: string;
  credential_id: string;
  signer_id: string;
  lane: Lane;
  state: 'SIGNED' | 'ACCEPTED' | 'REJECTED' | 'CONSUMED';
  created_at: string;
}

export interface EscrowRow {
  escrow_id: string;
  txn_id: string;
  intent_hash: string;
  lane: Lane;
  state: string;
  opened_by: string;
  opened_at: string;
  expires_at: string;
  risk_json: string;
  required_approvals: number;
  receipt_json: string | null;
  closed_at: string | null;
}

export const getUser = (id: string) =>
  db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as UserRow | undefined;

export const listUsers = () =>
  db.prepare(`SELECT * FROM users ORDER BY role, name`).all() as unknown as UserRow[];

export const getCredential = (id: string) =>
  db.prepare(`SELECT * FROM credentials WHERE credential_id = ?`).get(id) as
    | CredentialRow
    | undefined;

export const credentialsFor = (userId: string) =>
  db
    .prepare(`SELECT * FROM credentials WHERE user_id = ? ORDER BY created_at`)
    .all(userId) as unknown as CredentialRow[];

export const getIntentRow = (txnId: string) =>
  db.prepare(`SELECT * FROM intents WHERE txn_id = ?`).get(txnId) as IntentRow | undefined;

export const getEscrowRow = (escrowId: string) =>
  db.prepare(`SELECT * FROM escrows WHERE escrow_id = ?`).get(escrowId) as EscrowRow | undefined;

export const escrowForTxn = (txnId: string) =>
  db
    .prepare(`SELECT * FROM escrows WHERE txn_id = ? ORDER BY opened_at DESC LIMIT 1`)
    .get(txnId) as EscrowRow | undefined;

export const parseIntent = (row: IntentRow): TransactionIntent => JSON.parse(row.intent_json);
export const parseSignature = (row: IntentRow): SignatureEnvelope => JSON.parse(row.signature_json);

export interface ApprovalRow {
  escrow_id: string;
  approver_id: string;
  decision: 'APPROVE' | 'REJECT';
  assertion_json: string;
  envelope_json: string;
  credential_id: string;
  binding: CredentialBinding;
  device_kind: DeviceKind;
  at: string;
}

export const approvalsFor = (escrowId: string) =>
  db
    .prepare(`SELECT * FROM approvals WHERE escrow_id = ? ORDER BY at ASC`)
    .all(escrowId) as unknown as ApprovalRow[];

export function approvalRecords(escrowId: string): ApprovalRecord[] {
  return approvalsFor(escrowId).map((a) => {
    const env: SignatureEnvelope = JSON.parse(a.envelope_json);
    const user = getUser(a.approver_id);
    return {
      approver_id: a.approver_id,
      role: (user?.role ?? 'EMPLOYEE') as Role,
      decision: a.decision,
      at: a.at,
      binding: a.binding,
      device_kind: a.device_kind,
      credential_id: a.credential_id,
      // Hardware assertions carry the signature inside the WebAuthn response.
      signature: 'signature' in env ? env.signature : env.response.signature,
    };
  });
}

export const parseAssertion = (a: ApprovalRow): ApprovalAssertion => JSON.parse(a.assertion_json);
