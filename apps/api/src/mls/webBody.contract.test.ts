// The web MLS page's PUT body against the API's own schema (b13 review B13S-1 / F1-ui). ISA-3 made `ai_isa_comps` a
// required key of the strict ValuationPackBody; the web's valuation editor built its body from five keys, so every
// "Save valuation use" was refused VALIDATION_FAILED and the section could never be stamped reviewed from the product
// (admin.ts stamps it only when every VALUATION_PACK_KEYS value is marked). apps/web does not depend on @realty/api, and
// the API does not depend on apps/web: the web's pure model (apps/web/src/surfaces/integrations/mls/pack.ts, no imports)
// is loaded by path, as data the API's schema must accept.
import { describe, expect, it } from 'vitest';
import { PACK_KEYS, VALUATION_PACK_KEYS, packView } from './admin.js';
import { LicensePackBody } from './routes.js';
import { REVIEWED_PACK } from './testing.js';

type Marked = Record<string, { value: unknown; counselReviewed: boolean }>;
interface WebPack {
  VALUATION_KEYS: readonly string[];
  PACK_KEYS: readonly string[];
  pickPack: (raw: unknown) => { values: Record<string, unknown>; marks: Record<string, boolean>; valuation: { values: Record<string, unknown>; marks: Record<string, boolean> } };
  packBody: (values: Record<string, unknown>, marks: Record<string, boolean>) => Marked;
  valuationBody: (values: Record<string, unknown>, marks: Record<string, boolean>) => Marked;
}
const WEB_PACK = new URL('../../../web/src/surfaces/integrations/mls/pack.ts', import.meta.url).href;
const web = async () => (await import(/* @vite-ignore */ WEB_PACK)) as WebPack;

describe('the web MLS page body is one the API accepts (B13S-1, R-CMA-6, D9)', () => {
  it('R-CMA-6: the web valuation editor knows every valuation key the API requires and stamps on, in the same order', async () => {
    const w = await web();
    expect([...w.VALUATION_KEYS]).toEqual([...VALUATION_PACK_KEYS]);
    expect([...w.PACK_KEYS]).toEqual([...PACK_KEYS]);
  });

  it('R-CMA-6 D9: the body the page sends for a stored pack (with or without a valuation section) parses with LicensePackBody, and the AI seller-data use stays off', async () => {
    const w = await web();
    const stored = [
      REVIEWED_PACK,
      { ...REVIEWED_PACK, valuation: { agent_cma: true, client_cma: false, automated_notes: false, ai_isa_comps: false, avm_flag_scope: 'all_client_outputs', statements: { CA: { text: 'Test statement.', min_point_size: 12 } }, reviewed_by_counsel_at: null } },
    ];
    for (const s of stored) {
      const view = w.pickPack(JSON.parse(JSON.stringify(packView(s))));
      const marksAll = Object.fromEntries(Object.keys(view.valuation.marks).map((k) => [k, true]));
      for (const marks of [view.valuation.marks, marksAll]) {
        const body = { ...w.packBody(view.values, view.marks), valuation: w.valuationBody(view.valuation.values, marks) };
        const r = LicensePackBody.safeParse(body);
        expect(r.success ? [] : r.error.issues.map((i) => i.path.join('.'))).toEqual([]);
        expect(body.valuation['ai_isa_comps']).toEqual({ value: false, counselReviewed: marks === marksAll });
      }
    }
  });
});
