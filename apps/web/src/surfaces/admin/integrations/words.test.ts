// The Integrations page's pack names against the API catalog (batch 10 review api-ui/F3). Read as text, as
// shell/errorMessages.test.ts reads errors.ts: apps/web does not depend on @realty/api.
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { packName } from './words.js';

const here = dirname(fileURLToPath(import.meta.url));
const catalog = readFileSync(resolve(here, '../../../../../api/src/integrations/catalog.ts'), 'utf8');

/** The keys of one `export const NAME ... = { ... };` or `[ ... ];` block of catalog.ts. */
function keysOf(name: string): string[] {
  const start = catalog.indexOf(`export const ${name}`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const end = catalog.indexOf(';\n', start);
  return [...catalog.slice(start, end).matchAll(/'(platform:[a-z_]+)'/g)].map((m) => m[1]!);
}

describe('pack names (R-INT-6)', () => {
  it('b10 review api-ui/F3: every platform pack the API gates on has its own name here, never "Another feature" (platform:meta is never shown)', () => {
    const gates = keysOf('PACK_GATES');
    const hidden = keysOf('NEVER_CLEARED_PACKS');
    expect(gates).toContain('platform:cma');
    expect(hidden).toEqual(['platform:meta']);
    const unnamed = gates.filter((k) => !hidden.includes(k) && packName(k) === 'Another feature');
    expect(unnamed).toEqual([]);
    // an unknown key still gets the generic name
    expect(packName('platform:not_a_pack')).toBe('Another feature');
  });

  it('D9: platform:cma is named for what waits on it, and says it is not in this version (V1 shares nothing)', () => {
    expect(packName('platform:cma')).toBe('Client CMAs and seller value ranges (a later version)');
  });
});
