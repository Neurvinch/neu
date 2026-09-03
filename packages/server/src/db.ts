import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { CONFIG, DATA_DIR } from './config.js';

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(CONFIG.dbFile);

db.exec(`PRAGMA journal_mode = WAL;`);
db.exec(`PRAGMA foreign_keys = ON;`);

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  role                 TEXT NOT NULL,
  email                TEXT,
  demo_password        TEXT NOT NULL,
  approval_limit_paise INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credentials (
  credential_id TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  binding       TEXT NOT NULL CHECK (binding IN ('software','hardware')),
  -- Where the key physically lives. This is policy-bearing, not cosmetic:
  -- executives may not sign with a console-resident key.
  device_kind   TEXT NOT NULL CHECK (device_kind IN ('console','authenticator','hardware')),
  public_key    TEXT NOT NULL,
  -- Hardware only: the raw credential id the authenticator issued, and its
  -- model identifier. Null for software credentials.
  webauthn_id   TEXT UNIQUE,
  aaguid        TEXT,
  label         TEXT,
  counter       INTEGER NOT NULL DEFAULT 0,
  state         TEXT NOT NULL CHECK (state IN ('PENDING','ACTIVE','REVOKED')),
  created_at    TEXT NOT NULL,
  activated_at  TEXT
);

-- The out-of-band channel.
--
-- The console never holds an executive's key. It writes a row here describing
-- exactly what it wants signed; the Authenticator app reads it, renders the
-- real fields, and returns a signature. The console cannot forge one, and it
-- cannot alter what the human saw: the payload hash is fixed when the request
-- is created and checked again when the signature comes back.
CREATE TABLE IF NOT EXISTS signing_requests (
  id              TEXT PRIMARY KEY,
  purpose         TEXT NOT NULL CHECK (purpose IN ('INTENT','APPROVAL','ENROLLMENT')),
  subject_user_id TEXT NOT NULL REFERENCES users(id),
  title           TEXT NOT NULL,
  subtitle        TEXT NOT NULL,
  rows_json       TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  payload_hash    TEXT NOT NULL,
  action_json     TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('PENDING','SIGNED','DECLINED','EXPIRED','FAILED')),
  requested_by    TEXT NOT NULL,
  requested_from  TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  resolved_at     TEXT,
  envelope_json   TEXT,
  error           TEXT,
  result_json     TEXT
);

-- One-time challenges for WebAuthn ceremonies, kept server-side so a client
-- can never choose its own challenge.
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  user_id    TEXT PRIMARY KEY,
  challenge  TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Key enrollment is quorum-gated. Without this the whole model is bypassable:
-- an attacker who can register a new key "for the CFO" no longer needs the CFO.
CREATE TABLE IF NOT EXISTS enrollment_requests (
  id                 TEXT PRIMARY KEY,
  credential_id      TEXT NOT NULL REFERENCES credentials(credential_id),
  user_id            TEXT NOT NULL REFERENCES users(id),
  requested_by       TEXT NOT NULL,
  state              TEXT NOT NULL CHECK (state IN ('PENDING','APPROVED','REJECTED')),
  required_approvals INTEGER NOT NULL,
  created_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS enrollment_approvals (
  request_id     TEXT NOT NULL REFERENCES enrollment_requests(id),
  approver_id    TEXT NOT NULL REFERENCES users(id),
  assertion_json TEXT NOT NULL,
  envelope_json  TEXT NOT NULL,
  credential_id  TEXT NOT NULL,
  at             TEXT NOT NULL,
  PRIMARY KEY (request_id, approver_id)
);

CREATE TABLE IF NOT EXISTS intents (
  txn_id        TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  intent_json   TEXT NOT NULL,
  intent_hash   TEXT NOT NULL UNIQUE,
  signature_json TEXT NOT NULL,
  credential_id TEXT NOT NULL REFERENCES credentials(credential_id),
  signer_id     TEXT NOT NULL REFERENCES users(id),
  lane          TEXT NOT NULL DEFAULT 'A' CHECK (lane IN ('A','B')),
  state         TEXT NOT NULL CHECK (state IN ('SIGNED','ACCEPTED','REJECTED','CONSUMED')),
  created_at    TEXT NOT NULL
);

-- Single-use enforcement. A captured legitimate intent cannot be resubmitted.
CREATE TABLE IF NOT EXISTS consumed_nonces (
  nonce  TEXT PRIMARY KEY,
  txn_id TEXT NOT NULL,
  at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS escrows (
  escrow_id          TEXT PRIMARY KEY,
  txn_id             TEXT NOT NULL REFERENCES intents(txn_id),
  intent_hash        TEXT NOT NULL,
  lane               TEXT NOT NULL CHECK (lane IN ('A','B')),
  state              TEXT NOT NULL,
  opened_by          TEXT NOT NULL REFERENCES users(id),
  opened_at          TEXT NOT NULL,
  expires_at         TEXT NOT NULL,
  risk_json          TEXT NOT NULL,
  required_approvals INTEGER NOT NULL,
  receipt_json       TEXT,
  closed_at          TEXT
);

CREATE TABLE IF NOT EXISTS approvals (
  escrow_id      TEXT NOT NULL REFERENCES escrows(escrow_id),
  approver_id    TEXT NOT NULL REFERENCES users(id),
  decision       TEXT NOT NULL CHECK (decision IN ('APPROVE','REJECT')),
  assertion_json TEXT NOT NULL,
  envelope_json  TEXT NOT NULL,
  credential_id  TEXT NOT NULL,
  binding        TEXT NOT NULL,
  device_kind    TEXT NOT NULL,
  at             TEXT NOT NULL,
  PRIMARY KEY (escrow_id, approver_id)
);

CREATE TABLE IF NOT EXISTS vendor_master (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  account     TEXT NOT NULL,
  ifsc        TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS audit_chain (
  seq          INTEGER PRIMARY KEY,
  txn_id       TEXT,
  type         TEXT NOT NULL,
  at           TEXT NOT NULL,
  actor        TEXT,
  payload_json TEXT NOT NULL,
  prev_hash    TEXT NOT NULL,
  entry_hash   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_txn ON audit_chain(txn_id);
CREATE INDEX IF NOT EXISTS idx_escrow_state ON escrows(state, expires_at);
CREATE INDEX IF NOT EXISTS idx_intent_state ON intents(state);
CREATE INDEX IF NOT EXISTS idx_signing_subject ON signing_requests(subject_user_id, state);
`);

/**
 * "UPDATE/DELETE revoked at the DB role level" from the design, expressed with
 * the strongest thing SQLite offers. Tampering must fail loudly at the storage
 * layer, not merely be discouraged in application code.
 */
db.exec(`
CREATE TRIGGER IF NOT EXISTS audit_chain_no_update
BEFORE UPDATE ON audit_chain
BEGIN SELECT RAISE(ABORT, 'audit_chain is append-only'); END;

CREATE TRIGGER IF NOT EXISTS audit_chain_no_delete
BEFORE DELETE ON audit_chain
BEGIN SELECT RAISE(ABORT, 'audit_chain is append-only'); END;
`);

export function tx<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
