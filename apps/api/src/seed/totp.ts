// pnpm demo:totp — prints the demo Owner's current 6-digit sign-in code (from .demo/credentials.json,
// written by `pnpm seed`). Dev demo only: the secret exists in that file because the seed enrolled it.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOTP_PERIOD_S, totpCode, totpStep } from '../auth/totp.js';

const path = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.demo/credentials.json');
if (!existsSync(path)) {
  process.stderr.write('No demo credentials yet. Run `pnpm seed` first.\n');
  process.exit(1);
}
const c = JSON.parse(readFileSync(path, 'utf8')) as { ownerTotpSecret: string; users: { owner: { email: string } } };
const now = Date.now();
const left = TOTP_PERIOD_S - Math.floor(now / 1000) % TOTP_PERIOD_S;
process.stdout.write(`${totpCode(c.ownerTotpSecret, totpStep(now))}  (Owner ${c.users.owner.email}; valid for ${left} more seconds)\n`);
