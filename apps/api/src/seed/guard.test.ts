// The demo seed refuses a real production deployment (deploy rehearsal: it ran under NODE_ENV=production).
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SeedRefused, assertCredentialsWritable, assertSeedAllowed } from './guard.js';

describe('seed guard', () => {
  it('refuses NODE_ENV=production unless ALLOW_FAKE_PROVIDERS=true (a staging demo)', () => {
    for (const allow of [undefined, '', 'false', '0', 'yes']) expect(() => assertSeedAllowed({ NODE_ENV: 'production', ALLOW_FAKE_PROVIDERS: allow }), String(allow)).toThrow(SeedRefused);
    for (const allow of ['true', '1']) expect(() => assertSeedAllowed({ NODE_ENV: 'production', ALLOW_FAKE_PROVIDERS: allow })).not.toThrow();
    for (const env of [undefined, 'development', 'test']) expect(() => assertSeedAllowed({ NODE_ENV: env })).not.toThrow();
  });

  it('runs before the seed touches the database', () => {
    const body = mainBody();
    expect(body.indexOf('assertSeedAllowed(process.env)')).toBeGreaterThan(-1);
    expect(body.indexOf('assertSeedAllowed(process.env)')).toBeLessThan(body.indexOf('resetDatabase('));
    expect(body.indexOf('assertSeedAllowed(process.env)')).toBeLessThan(body.indexOf('new pg.Pool('));
  });

  it('refuses before seeding when the credentials file cannot be written (the Owner TOTP secret would be lost)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'seed-guard-'));
    try {
      writeFileSync(join(dir, 'file'), '');
      // a path under a regular file cannot be created, even by root (the rehearsal's /app/.demo failed with EACCES)
      expect(() => assertCredentialsWritable(join(dir, 'file', '.demo', 'credentials.json'))).toThrow(/cannot write the demo credentials file \(ENOTDIR\).*nothing was seeded/);
      expect(() => assertCredentialsWritable(join(dir, '.demo', 'credentials.json'))).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const main = mainBody();
    expect(main.indexOf('assertCredentialsWritable(CREDENTIALS_PATH)')).toBeGreaterThan(-1);
    expect(main.indexOf('assertCredentialsWritable(CREDENTIALS_PATH)')).toBeLessThan(main.indexOf('new pg.Pool('));
  });
});

function mainBody(): string {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  return main.slice(main.indexOf('async function main('));
}
