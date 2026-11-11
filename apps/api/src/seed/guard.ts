// The demo seed creates users whose password is published in the README. It must never run against a
// production deployment that serves real teams (deploy rehearsal: it ran under NODE_ENV=production, and the
// api image ships dist/seed/main.js). Production is allowed only as a fake-provider staging demo, which is
// exactly the ALLOW_FAKE_PROVIDERS=true escape hatch of config.ts.
export class SeedRefused extends Error {
  override readonly name = 'SeedRefused';
}

export function assertSeedAllowed(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV !== 'production') return;
  const allow = (env.ALLOW_FAKE_PROVIDERS ?? '').trim();
  if (allow === 'true' || allow === '1') return;
  throw new SeedRefused('refusing to seed demo users with a public password into a production deployment (NODE_ENV=production without ALLOW_FAKE_PROVIDERS=true)');
}
