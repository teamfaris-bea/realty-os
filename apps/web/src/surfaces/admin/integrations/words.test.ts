// The Integrations page's pack names against the API catalog (batch 10 review api-ui/F3; batch 11 sends-gates/F5,
// api-ui/F6): every pack the API can list gets its own name, never the generic one. Read as text, as
// shell/errorMessages.test.ts reads errors.ts: apps/web does not depend on @realty/api.
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NEVER_CLEARED_PACKS } from './types.js';
import { packName } from './words.js';

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

  it('D9: platform:cma is named for what waits on it, and says it is not in this version (V1 shares nothing)', () => {
    expect(packName('platform:cma')).toBe('Client CMAs and seller value ranges (a later version)');
  });
});
