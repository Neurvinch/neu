import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = path.join(root, 'data');

for (const f of fs.existsSync(data) ? fs.readdirSync(data) : []) {
  if (/^(seal\.db|bank-ledger\.json|key-directory\.json)/.test(f)) {
    fs.rmSync(path.join(data, f), { force: true });
    console.log(`removed data/${f}`);
  }
}
console.log('Fresh start. Run "npm run seed", then re-enroll every device.');
