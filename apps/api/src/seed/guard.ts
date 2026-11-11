// The demo seed creates users whose password is published in the README. It must never run against a
// production deployment that serves real teams (deploy rehearsal: it ran under NODE_ENV=production, and the
// api image ships dist/seed/main.js). Production is allowed only as a fake-provider staging demo, which is
// exactly the ALLOW_FAKE_PROVIDERS=true escape hatch of config.ts.
import { accessSync, constants, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class SeedRefused extends Error {
  override readonly name = 'SeedRefused';
}

export function assertSeedAllowed(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV !== 'production') return;
  const allow = (env.ALLOW_FAKE_PROVIDERS ?? '').trim();
  if (allow === 'true' || allow === '1') return;
  throw new SeedRefused('refusing to seed demo users with a public password into a production deployment (NODE_ENV=production without ALLOW_FAKE_PROVIDERS=true)');
}

/**
 * The Owner's TOTP secret exists only in the credentials file the seed writes at the END. If that write fails
 * (deploy rehearsal: /app/.demo is not writable in the api image), the tenant is created but the Owner can never
 * sign in, and a re-run refuses because the tenant exists. So the seed proves the file is writable first.
 */
export function assertCredentialsWritable(path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    accessSync(dirname(path), constants.W_OK);
  } catch (e) {
    throw new SeedRefused(`cannot write the demo credentials file (${(e as { code?: string }).code ?? 'error'}): mount a writable directory at ${dirname(path)} first; nothing was seeded`);
  }
}
