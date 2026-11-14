// The Integrations page's pack names against the API catalog (batch 10 review api-ui/F3; batch 11 sends-gates/F5,
// api-ui/F6): every pack the API can list gets its own name, never the generic one. Read as text, as
// shell/errorMessages.test.ts reads errors.ts: apps/web does not depend on @realty/api.
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NEVER_CLEARED_PACKS } from './types.js';
import { capabilityName, capabilityReason, packName } from './words.js';

const here = dirname(fileURLToPath(import.meta.url));
const catalog = readFileSync(resolve(here, '../../../../../api/src/integrations/catalog.ts'), 'utf8');

/** The `'platform:…'` strings of one `export const NAME ... = { ... };` or `[ ... ];` block of catalog.ts. */
function keysOf(name: string): string[] {
  const start = catalog.indexOf(`export const ${name}`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const end = catalog.indexOf(';\n', start);
  return [...catalog.slice(start, end).matchAll(/'(platform:[a-z_]+)'/g)].map((m) => m[1]!);
}

/** The keys of PACK_GATES in apps/api/src/integrations/catalog.ts (one `'platform:…':` per line). */
function apiPackKeys(): string[] {
  const start = catalog.indexOf('export const PACK_GATES');
  const body = catalog.slice(start, catalog.indexOf('};', start));
  return [...body.matchAll(/^\s*'(platform:[a-z_]+)':/gm)].map((m) => m[1]!);
}

describe('pack names (R-INT-6)', () => {
  it('R-INT-6 b10 review api-ui/F3, b11 sends-gates/F5: every platform pack the API catalog gates on and the page shows has its own name here, never "Another feature" (platform:cma included; platform:meta is never shown)', () => {
    const gates = apiPackKeys();
    expect(gates.length).toBeGreaterThanOrEqual(11);
    expect(gates).toContain('platform:cma');
    // platform:meta is never shown (D2): the API's and the page's never-cleared lists agree, so it needs no name
    const hidden = keysOf('NEVER_CLEARED_PACKS');
    expect(hidden).toEqual(['platform:meta']);
    expect([...NEVER_CLEARED_PACKS]).toEqual(hidden);
    const unnamed = gates.filter((k) => !hidden.includes(k) && packName(k) === 'Another feature');
    expect(unnamed).toEqual([]);
    // an unknown key still gets the generic name
    expect(packName('platform:not_a_pack')).toBe('Another feature');
  });

  it('b12 review ui-1, ui-pack-isa-1: the API catalog\'s pack lines the page prints under each name never call the assistant "AI"', () => {
    const start = catalog.indexOf('export const PACK_GATES');
    const body = catalog.slice(start, catalog.indexOf('};', start));
    const lines = [...body.matchAll(/^\s*'platform:[a-z_]+': (['"])(.*)\1,/gm)].map((m) => m[2]!);
    expect(lines.length).toBe(apiPackKeys().length);
    expect(lines.filter((l) => /\bAI\b/.test(l))).toEqual([]);
  });

  it('b14 round 2 (R-INT-6, R-ISA-18): the recent-sales emails pack is named for what ISA-3 built (batch 13), never "a later version", is not in the API\'s not-built list, and matches the API catalog\'s line', () => {
    expect(packName('platform:ai_isa_seller_data')).toBe("The assistant's recent-sales emails");
    expect(packName('platform:ai_isa_seller_data')).not.toMatch(/later version|not built/);
    expect(keysOf('NOT_BUILT_PACKS')).not.toContain('platform:ai_isa_seller_data');
    const start = catalog.indexOf('export const PACK_GATES');
    const line = catalog.slice(start, catalog.indexOf('};', start)).match(/^\s*'platform:ai_isa_seller_data': "([^"]*)"/m)![1];
    expect(packName('platform:ai_isa_seller_data')).toBe(line);
  });

  it('D9 R-CMA-10 b13 audit V2B-1: platform:cma is named for everything built behind it (V2-A client CMAs, V2-B seller value ranges and in-house notes), never "a later version", and matches the API catalog\'s line', () => {
    expect(packName('platform:cma')).toBe('Client CMAs, seller value ranges and in-house home-value notes');
    expect(keysOf('NOT_BUILT_PACKS')).not.toContain('platform:cma');
    const start = catalog.indexOf('export const PACK_GATES');
    const line = catalog.slice(start, catalog.indexOf('};', start)).match(/^\s*'platform:cma': '([^']*)'/m)![1];
    expect(packName('platform:cma')).toBe(line);
  });
});

describe('capability lines (b12 review ui-4; R-INT-6)', () => {
  it('b12 review ui-4: the Google Business Profile capabilities read in words, and a reason names each pack once, as written', () => {
    expect(capabilityName('read_reviews')).toBe('Read reviews');
    expect(capabilityName('reply_reviews')).toBe('Reply to reviews');
    const why = (k: string) => capabilityReason({ name: 'reply_reviews', available: false, reason: `Waits for counsel review of ${k}.` } as never);
    expect(why('platform:gbp')).toBe('Waits for counsel review of the Google Business Profile rules.');
    expect(why('platform:fair_housing')).toBe('Waits for counsel review of the fair-housing rules for publishing marketing.');
    expect(why('platform:ads')).toBe('Waits for counsel review of the Google Ads budget rules.');
    for (const k of apiPackKeys()) expect(why(k), k).not.toMatch(/rules\) rules|rules rules|\bgoogle\b/);
  });
});
