import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** repo root -> packages/server/src -> ../../.. */
export const ROOT = path.resolve(here, '..', '..', '..');
export const DATA_DIR = path.join(ROOT, 'data');

export const CONFIG = {
  port: Number(process.env.SEAL_PORT ?? 4000),
  dbFile: path.join(DATA_DIR, 'seal.db'),
  /** Published to the payment rail so the bank can verify without asking us. */
  keyDirectoryFile: path.join(DATA_DIR, 'key-directory.json'),
  bankUrl: process.env.SEAL_BANK_URL ?? 'http://localhost:4001',
  /** Shared secret the rail uses to report refusals back into the audit chain. */
  railSecret: process.env.SEAL_RAIL_SECRET ?? 'demo-rail-secret',
  orgId: 'acme-corp',
  sweepIntervalMs: 1000,
  /**
   * Demo-only: shrink every escrow window to N seconds so the expiry path can
   * be shown live instead of waiting fifteen minutes. It never lengthens a
   * window, it is written into the audit chain on every escrow it touches, and
   * it is unset by default.
   */
  demoWindowSeconds: process.env.SEAL_DEMO_WINDOW_SECONDS
    ? Number(process.env.SEAL_DEMO_WINDOW_SECONDS)
    : null,
} as const;
