// The demo seed refuses a real production deployment (deploy rehearsal: it ran under NODE_ENV=production).
import { describe, expect, it } from 'vitest';
import { SeedRefused, assertSeedAllowed } from './guard.js';

describe('seed guard', () => {
  it('refuses NODE_ENV=production unless ALLOW_FAKE_PROVIDERS=true (a staging demo)', () => {
    for (const allow of [undefined, '', 'false', '0', 'yes']) expect(() => assertSeedAllowed({ NODE_ENV: 'production', ALLOW_FAKE_PROVIDERS: allow }), String(allow)).toThrow(SeedRefused);
    for (const allow of ['true', '1']) expect(() => assertSeedAllowed({ NODE_ENV: 'production', ALLOW_FAKE_PROVIDERS: allow })).not.toThrow();
    for (const env of [undefined, 'development', 'test']) expect(() => assertSeedAllowed({ NODE_ENV: env })).not.toThrow();
  });

  it('runs before the seed touches the database', async () => {
    const { readFileSync } = await import('node:fs');
    const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
    const body = main.slice(main.indexOf('async function main('));
    expect(body.indexOf('assertSeedAllowed(process.env)')).toBeGreaterThan(-1);
    expect(body.indexOf('assertSeedAllowed(process.env)')).toBeLessThan(body.indexOf('resetDatabase('));
    expect(body.indexOf('assertSeedAllowed(process.env)')).toBeLessThan(body.indexOf('new pg.Pool('));
  });
});
