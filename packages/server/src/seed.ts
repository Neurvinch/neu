import { db } from './db.js';
import { appendAudit } from './audit.js';
import { publishKeyDirectory } from './keydir.js';

/**
 * Seeds people and the vendor master only.
 *
 * It deliberately does NOT seed credentials. A private key that a server could
 * plant is not a credential -- it is a shared secret. Every key in this system
 * is generated on the device that will use it and enrolled through the
 * quorum-gated ceremony, including in the demo.
 */

const rupees = (r: number) => r * 100;

const USERS = [
  ['u_priya', 'Priya Nair', 'CFO', 'priya@acme.example', rupees(50_000_000)],
  ['u_rahul', 'Rahul Menon', 'CEO', 'rahul@acme.example', rupees(50_000_000)],
  ['u_anita', 'Anita Desai', 'CTO', 'anita@acme.example', rupees(10_000_000)],
  ['u_vikram', 'Vikram Iyer', 'TREASURY', 'vikram@acme.example', rupees(20_000_000)],
  ['u_aravind', 'Aravind Kumar', 'EMPLOYEE', 'aravind@acme.example', 0],
  ['u_meera', 'Meera Shah', 'AUDITOR', 'meera@acme.example', 0],
  ['u_devan', 'Devan Rao', 'SECOPS', 'devan@acme.example', 0],
] as const;

const VENDORS = [
  ['v_alton', 'Alton Logistics Pvt Ltd', '50100234564419', 'HDFC0001234'],
  ['v_karthik', 'Karthik Steelworks', '918200045127', 'ICIC0004512'],
  ['v_nova', 'Nova Print Services', '331299001204', 'SBIN0003312'],
] as const;

export function seed(): void {
  const now = new Date().toISOString();

  const insertUser = db.prepare(
    `INSERT OR IGNORE INTO users (id, name, role, email, demo_password, approval_limit_paise, created_at)
     VALUES (?, ?, ?, ?, 'demo', ?, ?)`,
  );
  for (const [id, name, role, email, limit] of USERS) {
    insertUser.run(id, name, role, email, limit, now);
  }

  const insertVendor = db.prepare(
    `INSERT OR IGNORE INTO vendor_master (id, name, account, ifsc, verified_at, active)
     VALUES (?, ?, ?, ?, ?, 1)`,
  );
  for (const [id, name, account, ifsc] of VENDORS) {
    insertVendor.run(id, name, account, ifsc, now);
  }

  publishKeyDirectory();
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('/seed.ts');
if (isMain) {
  seed();
  const head = db.prepare(`SELECT COUNT(*) AS n FROM audit_chain`).get() as { n: number };
  if (head.n === 0) {
    appendAudit({
      txn_id: null,
      type: 'CREDENTIAL_ENROLL_REQUESTED',
      actor: 'system',
      payload: { note: 'Genesis entry: organisation seeded, no credentials enrolled yet.' },
    });
  }
  const users = db.prepare(`SELECT COUNT(*) AS n FROM users`).get() as { n: number };
  const vendors = db.prepare(`SELECT COUNT(*) AS n FROM vendor_master`).get() as { n: number };
  console.log(`[seal] seeded ${users.n} users, ${vendors.n} vendors. Demo password for all: "demo"`);
  console.log('[seal] no credentials seeded by design -- enroll each device from the UI.');
}
