// b17 round 2 (L-c): docs/DATA_MODEL.md R-INT-6 quotes the Integrations page's pack line in the words catalog.ts
// packSentence writes. Since batch 17 a built capability's line reads "<name>: off, awaiting counsel review (...)"
// until counsel review is recorded and "<name>: cleared by counsel on ..." after; "<name> stays off" did not read for
// a plural name ("The assistant's recent-sales emails stays off"), so the rule must not quote it either.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { packSentence, type PlatformPack } from './catalog.js';

const DATA_MODEL = fileURLToPath(new URL('../../../../docs/DATA_MODEL.md', import.meta.url));
const rule = readFileSync(DATA_MODEL, 'utf8').split('\n').find((l) => l.startsWith('- **R-INT-6**')) ?? '';
const pack = (key: string, reviewedByCounselAt: string | null): PlatformPack => ({ key, version: '2026.11.0', reviewedByCounselAt, vendorReadyAt: null });

describe('b17 round 2 (L-c): R-INT-6 quotes the pack line as the page writes it', () => {
  it('R-INT-6: the CMA and recent-sales email packs read "off, awaiting counsel review" until reviewed and "cleared" after, as the page says them', () => {
    expect(rule).not.toBe('');
    for (const key of ['platform:cma', 'platform:ai_isa_seller_data']) {
      expect(packSentence(pack(key, null)), key).toContain(': off, awaiting counsel review (pack 2026.11.0, not yet reviewed).');
      expect(packSentence(pack(key, '2026-12-01T00:00:00Z')), key).toContain(': cleared by counsel on 2026-12-01 (pack 2026.11.0).');
    }
    expect(rule).toContain(`its line says "off, awaiting counsel review" or "cleared" like any built capability's`);
    expect(rule).toContain('its line says "off, awaiting counsel review" until counsel review is recorded ("cleared" for the pack after)');
    // the words batch 17 retired from the line
    expect(rule).not.toMatch(/"stays off"|says they stay off/);
  });
});
