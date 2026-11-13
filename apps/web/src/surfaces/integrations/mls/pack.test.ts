// The licence-pack editor's model (module 41) against core/listings: the editor lists exactly core's DISPLAY_FIELDS (a
// field it did not know would be dropped from a stored pack on the next save, as the D9 sold fields once were), every
// field has words, and a re-save keeps every stored field. The display editor never sends the D9 valuation section: the
// server keeps the stored one when the body omits it (apps/api/src/mls/valuation.test.ts, "a PUT without valuation keys
// keeps the stored section"). The valuation section has its own editor and save (b10 review api-ui/F2), parsed here to
// the strictest values when missing or unreadable.
import { DISPLAY_FIELDS as CORE_DISPLAY_FIELDS, USPS_REGIONS as CORE_USPS_REGIONS } from '@realty/core/listings';
import { describe, expect, it } from 'vitest';
import { DISPLAY_FIELDS, FIELD_WORDS, PACK_KEYS, USPS_REGIONS, VALUATION_KEYS, packBody, pickPack, valuationBody } from './pack.js';

const SOLD_FIELDS = ['closePrice', 'closeDate', 'yearBuilt', 'lotSize', 'subdivision'];

describe('licence-pack editor model (module 41)', () => {
  it('R-MLS-2: lists exactly core DISPLAY_FIELDS, in order, each with words', () => {
    expect([...DISPLAY_FIELDS]).toEqual([...CORE_DISPLAY_FIELDS]);
    for (const f of DISPLAY_FIELDS) expect([f, typeof FIELD_WORDS[f]]).toEqual([f, 'string']);
  });

  it('R-MLS-2 D9: a re-save keeps the stored sold fields (closePrice, closeDate, yearBuilt, lotSize, subdivision) and sends no valuation section', () => {
    const stored = ['status', 'listPrice', ...SOLD_FIELDS];
    const view = pickPack({
      values: PACK_KEYS.map((key) => ({ key, value: key === 'client_fields' || key === 'public_fields' ? stored : key === 'client_statuses' ? ['active', 'sold'] : key === 'public_statuses' ? [] : null, counselReviewed: true })),
      reviewedByCounselAt: '2026-11-02T10:00:00.000Z',
      unreviewedCount: 0,
      sentence: '',
    });
    expect(view.values.client_fields).toEqual(stored);
    const body = packBody(view.values, view.marks) as Record<string, { value: unknown }>;
    expect(body['client_fields']!.value).toEqual(stored);
    expect(body['public_fields']!.value).toEqual(stored);
    expect(Object.keys(body).sort()).toEqual([...PACK_KEYS].sort());
    expect('valuation' in body).toBe(false);
  });

  it('D9 b10 api-ui/F2: the valuation section parses to the strictest values when missing or unreadable, never a ticked client use; its states are core USPS_REGIONS', () => {
    expect(USPS_REGIONS).toEqual(CORE_USPS_REGIONS);
    const none = pickPack({ values: [], reviewedByCounselAt: null, unreviewedCount: 9, sentence: '' }).valuation;
    expect(none.values).toEqual({ agent_cma: false, client_cma: false, automated_notes: false, avm_flag_scope: 'all_client_outputs', statements: [] });
    expect(Object.values(none.marks).some(Boolean)).toBe(false);
    const odd = pickPack({
      values: [],
      valuation: {
        values: [
          { key: 'agent_cma', value: 'yes', counselReviewed: 'true' },
          { key: 'client_cma', value: 1, counselReviewed: true },
          { key: 'avm_flag_scope', value: 'anything', counselReviewed: true },
          { key: 'statements', value: [{ region: 'ZZ', text: 'x', minPointSize: 12 }, { region: 'CA', text: 'Ok.', minPointSize: 12 }, { region: 'NY', text: 7, minPointSize: 12 }], counselReviewed: true },
        ],
        reviewedByCounselAt: null,
        unreviewedCount: 0,
        sentence: 'S',
      },
    }).valuation;
    expect(odd.values).toEqual({ agent_cma: false, client_cma: false, automated_notes: false, avm_flag_scope: 'all_client_outputs', statements: [{ region: 'CA', text: 'Ok.', minPointSize: 12 }] });
    expect(odd.marks).toEqual({ agent_cma: false, client_cma: true, automated_notes: false, avm_flag_scope: true, statements: true });
    expect(odd.unreviewedCount).toBe(2); // never trusted over the marks
    const body = valuationBody(odd.values, odd.marks);
    expect(Object.keys(body)).toEqual([...VALUATION_KEYS]);
  });
});
