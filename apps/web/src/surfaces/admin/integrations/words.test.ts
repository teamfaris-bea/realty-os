// The Integrations page's pack names mirror the API catalog's PACK_GATES (b11 sends-gates/F5, api-ui/F6): every pack
// the API can list gets its own name, never the generic one.
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NEVER_CLEARED_PACKS } from './types.js';
import { packName } from './words.js';

const here = dirname(fileURLToPath(import.meta.url));

/** The keys of PACK_GATES in apps/api/src/integrations/catalog.ts, read as text (apps/web does not depend on @realty/api). */
function apiPackKeys(): string[] {
  const text = readFileSync(resolve(here, '../../../../../api/src/integrations/catalog.ts'), 'utf8');
  const start = text.indexOf('export const PACK_GATES');
  const body = text.slice(start, text.indexOf('};', start));
  return [...body.matchAll(/^\s*'(platform:[a-z_]+)':/gm)].map((m) => m[1]!);
}

describe('pack names', () => {
  it('R-INT-6: every platform pack the API catalog gates on and the page shows has its own name (platform:cma included)', () => {
    const keys = apiPackKeys();
    expect(keys.length).toBeGreaterThanOrEqual(11);
    expect(keys).toContain('platform:cma');
    // platform:meta is never shown (D2, NEVER_CLEARED_PACKS), so it needs no name
    expect(keys.filter((k) => !NEVER_CLEARED_PACKS.includes(k) && packName(k) === 'Another feature')).toEqual([]);
    expect(packName('platform:cma')).toBe('Client CMAs and seller value ranges');
    // an unknown key still gets the generic name
    expect(packName('platform:not_a_pack')).toBe('Another feature');
  });
});
