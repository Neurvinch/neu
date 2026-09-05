/**
 * Admit every pending key enrolment, using the simulated executive devices.
 *
 *   npm run admit
 *
 * This is a convenience for demos and development, not a bypass. It performs
 * exactly the ceremony the UI performs: for each pending request it raises a
 * signing request and answers it with a real Ed25519 signature over the exact
 * public key being admitted. It works only because `data/sim-devices.json`
 * holds those executives' private keys -- without them this script can do
 * nothing the server would accept.
 *
 * Why it exists: after `npm run sim` the organisation is past its bootstrap
 * ceremony, so a key enrolled by hand from the UI sits at PENDING until two
 * executives sign it in. If those executives only exist as simulated devices,
 * there is no browser to click in.
 */
import { api, approveEnrollment, enroll, fmt } from './lib.js';

interface Row {
  id: string;
  user_id: string;
  name: string;
  role: string;
  state: string;
  device_kind: string;
  credential_id: string;
  approvals: number;
  required_approvals: number;
}

const APPROVERS = ['u_priya', 'u_rahul', 'u_anita', 'u_vikram'];

async function main() {
  await api('/api/health').catch(() => {
    console.error('SEAL backend is not running. Start it with: npm run dev');
    process.exit(1);
  });

  const devices = [];
  for (const id of APPROVERS) {
    try {
      devices.push(await enroll(id, `${id} device`));
    } catch {
      // No stored key for this person, so they cannot vouch for anyone.
    }
  }

  if (devices.length === 0) {
    console.error('No simulated devices available. Run "npm run sim" first.');
    process.exit(1);
  }

  const pending = (
    await api<Row[]>('/api/credentials/enrollments', { token: devices[0].token })
  ).filter((e) => e.state === 'PENDING');

  if (pending.length === 0) {
    fmt.title('Nothing is pending. Every enrolled key is already admitted.');
    return;
  }

  for (const req of pending) {
    fmt.head(`${req.name} (${req.role}) — ${req.device_kind} key`);
    fmt.info(req.credential_id);

    for (const approver of devices) {
      // Nobody admits their own key; that is the whole point of the quorum.
      if (approver.id === req.user_id) continue;
      try {
        const out = (await approveEnrollment(approver, req.id)) as {
          result?: { approvals: number; required: number; activated: boolean };
        };
        const r = out.result;
        fmt.step(
          `signed by ${approver.name}: ${r?.approvals}/${r?.required}` +
            (r?.activated ? '  ->  ACTIVE' : ''),
        );
        if (r?.activated) break;
      } catch (e) {
        fmt.warn(`${approver.name} could not sign: ${(e as { error?: string }).error ?? e}`);
      }
    }
  }

  const left = (
    await api<Row[]>('/api/credentials/enrollments', { token: devices[0].token })
  ).filter((e) => e.state === 'PENDING');
  fmt.title(
    left.length === 0
      ? 'All keys admitted. Refresh the Authenticator and the badge will read ACTIVE.'
      : `${left.length} still pending — no eligible approver holds a key.`,
  );
}

main().catch((e) => {
  console.error('\nadmit-pending failed:', e);
  process.exit(1);
});
