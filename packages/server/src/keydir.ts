import fs from 'node:fs';
import { CONFIG } from './config.js';
import { db } from './db.js';

/**
 * The payment rail must be able to verify an approval bundle *without* asking
 * SEAL whether the signatures are good -- otherwise "the bank verifies
 * independently" is a claim, not a fact. So every activated credential is
 * published to a key directory the bank reads on its own.
 *
 * In production this is a signed, versioned directory (or the bank's own
 * corporate-mandate registry). Here it is a file both processes can see.
 */
export function publishKeyDirectory(): void {
  const rows = db
    .prepare(
      `SELECT c.credential_id, c.binding, c.device_kind, c.public_key, c.webauthn_id,
              c.aaguid, c.state, c.activated_at,
              u.id AS user_id, u.role, u.name, u.approval_limit_paise
       FROM credentials c JOIN users u ON u.id = c.user_id
       WHERE c.state = 'ACTIVE'
       ORDER BY c.credential_id`,
    )
    .all() as unknown as Array<Record<string, unknown>>;

  const directory = {
    org_id: CONFIG.orgId,
    updated_at: new Date().toISOString(),
    credentials: Object.fromEntries(
      rows.map((r) => [
        r.credential_id as string,
        {
          user_id: r.user_id,
          name: r.name,
          role: r.role,
          binding: r.binding,
          device_kind: r.device_kind,
          public_key: r.public_key,
          webauthn_id: r.webauthn_id,
          aaguid: r.aaguid,
          mandate_paise: Number(r.approval_limit_paise),
          activated_at: r.activated_at,
        },
      ]),
    ),
  };

  fs.writeFileSync(CONFIG.keyDirectoryFile, JSON.stringify(directory, null, 2));
}
