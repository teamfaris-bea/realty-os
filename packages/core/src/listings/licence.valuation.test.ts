// The licence pack's valuation section (D9; R-CMA-6 and R-CMA-7, the licence parts; E371 core part) and the sold
// display fields (R-MLS-2). VERIFY WITH COUNSEL / MLS: every value here is a fixture.
import { describe, expect, it } from 'vitest';
import { applyDisplayRules } from './display.js';
import { STRICTEST_LICENSE_PACK, STRICTEST_VALUATION_LICENCE, packReviewed, parseLicensePack, valuationStatement, valuationUse } from './licence.js';
import { REVIEWED_PACK, mls } from './testing/fixtures.js';
import { EMPTY_VALUATION_FACTS } from './types.js';

const STATEMENT = { text: 'This is an estimate, not an appraisal (test statement).', min_point_size: 12 };
const section = (o: Record<string, unknown> = {}) => ({ agent_cma: true, client_cma: true, automated_notes: true, avm_flag_scope: 'all_client_outputs', statements: { SC: STATEMENT }, reviewed_by_counsel_at: '2026-11-01T00:00:00Z', ...o });

describe('licence pack: valuation section (strictest defaults)', () => {
  it('R-CMA-6 E371: a pack without the section parses to the strictest section and keeps its display review state', () => {
    const stored = { reviewed_by_counsel_at: '2026-10-15T09:00:00Z', attribution_text: 'A', disclaimer_text: 'D' };
    const p = parseLicensePack(stored);
    expect(p.valuation).toEqual(STRICTEST_VALUATION_LICENCE);
    expect(STRICTEST_VALUATION_LICENCE).toEqual({ agentCma: false, clientCma: false, automatedNotes: false, aiIsaComps: false, avmFlagScope: 'all_client_outputs', statements: {}, reviewedByCounselAt: null });
    expect([p.reviewedByCounselAt, packReviewed(p)]).toEqual(['2026-10-15T09:00:00Z', true]);
    // adding a reviewed section never changes the display stamp, and vice versa
    expect(parseLicensePack({ ...stored, valuation: section() }).reviewedByCounselAt).toBe('2026-10-15T09:00:00Z');
    expect(parseLicensePack({ valuation: section() }).reviewedByCounselAt).toBeNull();
    expect(STRICTEST_LICENSE_PACK.valuation).toEqual(STRICTEST_VALUATION_LICENCE);
  });

  it('R-CMA-6 E371: strictest per key; one bad key never loosens another', () => {
    expect(parseLicensePack({ valuation: section() }).valuation).toEqual({ agentCma: true, clientCma: true, automatedNotes: true, aiIsaComps: false, avmFlagScope: 'all_client_outputs', statements: { SC: { text: STATEMENT.text, minPointSize: 12 } }, reviewedByCounselAt: '2026-11-01T00:00:00Z' });
    const bad = parseLicensePack({ valuation: section({ agent_cma: 'yes', avm_flag_scope: 'none', reviewed_by_counsel_at: 'last week' }) }).valuation;
    expect(bad).toMatchObject({ agentCma: false, clientCma: true, automatedNotes: true, avmFlagScope: 'all_client_outputs', reviewedByCounselAt: null });
    expect(parseLicensePack({ valuation: section({ avm_flag_scope: 'internet_display_only' }) }).valuation.avmFlagScope).toBe('internet_display_only');
    for (const junk of ['x', 1, [], null]) expect(parseLicensePack({ valuation: junk }).valuation).toEqual(STRICTEST_VALUATION_LICENCE);
  });

  it('R-CMA-7 E371: a statement for an unknown region, an empty or over-long text, or a size outside 6–36 is ignored, never loosening another', () => {
    const p = parseLicensePack({
      valuation: section({
        statements: { SC: STATEMENT, ZZ: STATEMENT, 'South Carolina': STATEMENT, NC: { text: '  ', min_point_size: 12 }, GA: { text: 'x'.repeat(4001), min_point_size: 12 }, FL: { text: 'ok', min_point_size: 5 }, TX: { text: 'ok', min_point_size: 37 }, AL: { text: 'ok', min_point_size: '12' }, TN: 'text', __proto__: STATEMENT, constructor: STATEMENT },
      }),
    });
    expect(Object.keys(p.valuation.statements)).toEqual(['SC']);
    expect(p.valuation.clientCma).toBe(true);
    expect(parseLicensePack({ valuation: section({ statements: 'all' }) }).valuation.statements).toEqual({});
  });
});

describe('valuationUse (R-CMA-6, R-CMA-7: the licence parts)', () => {
  const pack = (o: Record<string, unknown> = {}) => parseLicensePack({ valuation: section(o) });
  it('R-CMA-6: agent_cma needs only its value (the Owner/Admin\'s statement): no review, no statement', () => {
    expect(valuationUse(pack({ reviewed_by_counsel_at: null, statements: {} }), 'agent_cma', null)).toEqual({ ok: true });
    expect(valuationUse(pack({ agent_cma: false }), 'agent_cma', 'SC')).toEqual({ ok: false, reason: 'PACK_DOES_NOT_ALLOW' });
    expect(valuationUse(STRICTEST_LICENSE_PACK, 'agent_cma', 'SC')).toEqual({ ok: false, reason: 'PACK_DOES_NOT_ALLOW' });
  });

  it('R-CMA-7: client uses also need the section reviewed and a statement for the subject\'s state', () => {
    for (const use of ['client_cma', 'automated_notes'] as const) {
      expect(valuationUse(pack(), use, 'SC')).toEqual({ ok: true });
      expect(valuationUse(pack(), use, 'South Carolina')).toEqual({ ok: true });
      expect(valuationUse(pack({ reviewed_by_counsel_at: null }), use, 'SC')).toEqual({ ok: false, reason: 'VALUATION_NOT_REVIEWED' });
      expect(valuationUse(pack(), use, 'NC')).toEqual({ ok: false, reason: 'NO_VALUATION_STATEMENT' });
      expect(valuationUse(pack(), use, null)).toEqual({ ok: false, reason: 'NO_VALUATION_STATEMENT' });
      expect(valuationUse(pack(), use, 'Ontario')).toEqual({ ok: false, reason: 'NO_VALUATION_STATEMENT' });
    }
    expect(valuationUse(pack({ client_cma: false }), 'client_cma', 'SC')).toEqual({ ok: false, reason: 'PACK_DOES_NOT_ALLOW' });
    expect(valuationUse(pack({ automated_notes: false }), 'automated_notes', 'SC')).toEqual({ ok: false, reason: 'PACK_DOES_NOT_ALLOW' });
    expect(valuationStatement(pack(), 'sc')).toEqual({ text: STATEMENT.text, minPointSize: 12 });
  });
});

describe('sold display fields (R-MLS-2)', () => {
  const sold = mls({ status: 'sold', valuation: { ...EMPTY_VALUATION_FACTS, closePriceCents: 44_000_000, closeDate: '2026-09-30', yearBuilt: 1998, lotSqft: 8712, subdivisionName: 'Harbor Pointe' } });
  it('R-MLS-2: the agent sees every sold field; a client sees them only when the pack lists them and sold', () => {
    expect(applyDisplayRules(sold, STRICTEST_LICENSE_PACK, 'agent')).toMatchObject({ closePriceCents: 44_000_000, closeDate: '2026-09-30', yearBuilt: 1998, lotSqft: 8712, subdivisionName: 'Harbor Pointe' });
    expect(applyDisplayRules(sold, REVIEWED_PACK, 'client')).toMatchObject({ closePriceCents: 44_000_000, closeDate: '2026-09-30', yearBuilt: 1998, lotSqft: 8712, subdivisionName: 'Harbor Pointe', omittedFields: [] });
    // a stored pack from before D9 lists none of the sold fields: none is shown
    const before = { ...REVIEWED_PACK, audiences: { ...REVIEWED_PACK.audiences, client: { fields: REVIEWED_PACK.audiences.client.fields.filter((f) => !['closePrice', 'closeDate', 'yearBuilt', 'lotSize', 'subdivision'].includes(f)), statuses: REVIEWED_PACK.audiences.client.statuses } } };
    const d = applyDisplayRules(sold, before, 'client')!;
    for (const k of ['closePriceCents', 'closeDate', 'yearBuilt', 'lotSqft', 'subdivisionName']) expect(d).not.toHaveProperty(k);
    expect(d.omittedFields).toEqual(['closePrice', 'closeDate', 'yearBuilt', 'lotSize', 'subdivision']);
    // sold not among the client statuses: nothing at all
    expect(applyDisplayRules(sold, { ...REVIEWED_PACK, audiences: { ...REVIEWED_PACK.audiences, client: { fields: REVIEWED_PACK.audiences.client.fields, statuses: ['active'] } } }, 'client')).toBeNull();
    // unknown names in a stored pack are ignored
    expect(parseLicensePack({ audiences: { client: { fields: ['closePrice', 'closingCosts'], statuses: ['sold'] } } }).audiences.client.fields).toEqual(['closePrice']);
  });
});

describe('valuationUse ai_isa_comps (ISA-3, R-ISA-18)', () => {
  const pack = (o: Record<string, unknown> = {}) => parseLicensePack({ valuation: section(o) });
  it('E534 R-ISA-18: automated_notes true with ai_isa_comps absent gives PACK_DOES_NOT_ALLOW; the use reads only its own key', () => {
    expect(valuationUse(pack(), 'ai_isa_comps', 'SC')).toEqual({ ok: false, reason: 'PACK_DOES_NOT_ALLOW' });
    expect(pack().valuation.aiIsaComps).toBe(false);
    expect(valuationUse(pack({ ai_isa_comps: true, automated_notes: false, client_cma: false }), 'ai_isa_comps', 'SC')).toEqual({ ok: true });
    expect(valuationUse(pack({ ai_isa_comps: true, reviewed_by_counsel_at: null }), 'ai_isa_comps', 'SC')).toEqual({ ok: false, reason: 'VALUATION_NOT_REVIEWED' });
    expect(valuationUse(pack({ ai_isa_comps: 'yes' }), 'ai_isa_comps', 'SC')).toEqual({ ok: false, reason: 'PACK_DOES_NOT_ALLOW' });
    expect(valuationUse(pack({ ai_isa_comps: true }), 'automated_notes', 'SC')).toEqual({ ok: true });
    expect(valuationUse(pack({ ai_isa_comps: true, automated_notes: false }), 'automated_notes', 'SC')).toEqual({ ok: false, reason: 'PACK_DOES_NOT_ALLOW' });
    expect(() => valuationUse(pack(), 'unknown' as never, 'SC')).toThrow(/unknown valuation use/);
  });
});
