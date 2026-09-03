import { CONFIG } from './config.js';
import { createApp } from './app.js';
import { heartbeat } from './events.js';
import { publishKeyDirectory } from './keydir.js';
import { sweepExpired } from './core/service.js';
import { sweepSigningRequests } from './core/signing-requests.js';
import { sweepChallenges } from './core/caller.js';
import { seed } from './seed.js';

seed();
publishKeyDirectory();

const app = createApp();

/**
 * The escrow clock.
 *
 * The design called for durable delayed jobs. Expiry here is derived from
 * `expires_at` on every sweep rather than from a timer held in memory, so a
 * restart cannot lose a countdown -- an escrow that timed out while the process
 * was down is expired on the first sweep after boot, with its real expiry time
 * intact. Same durability guarantee, no Redis.
 */
setInterval(() => {
  try {
    const n = sweepExpired();
    if (n > 0) console.log(`[seal] expired ${n} escrow(s)`);
    const sigs = sweepSigningRequests();
    if (sigs > 0) console.log(`[seal] expired ${sigs} signing request(s)`);
    const calls = sweepChallenges();
    if (calls > 0) console.log(`[seal] expired ${calls} caller challenge(s)`);
  } catch (e) {
    console.error('[seal] sweep failed', e);
  }
}, CONFIG.sweepIntervalMs).unref();

setInterval(heartbeat, 25_000).unref();

app.listen(CONFIG.port, () => {
  console.log(`[seal] SEAL backend on http://localhost:${CONFIG.port}`);
  console.log(`[seal] payment rail expected at ${CONFIG.bankUrl}`);
  console.log(`[seal] key directory published to ${CONFIG.keyDirectoryFile}`);
});
