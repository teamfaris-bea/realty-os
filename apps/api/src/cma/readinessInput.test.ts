// Batch 13: V2-B's readinessInputOf meets the MLS size fix (task 55, R-MLS-7). Every readiness input built from a run or
// a stored CMA computes notLivingArea from the subject's and the comps' size sources with core's rule (a field of
// SIZE_FIELDS_NEVER_USED, in any letter case), so no client output, note or seller range rests on total building area.
// Pure: the input is built, not judged (clientReadiness reads the database; share.test.ts E652 runs it).
import { describe, expect, it } from 'vitest';
import { readinessInputOf, storedNotLivingArea } from './service.js';

const conns = { e: {} as never, used: [] };
const resolved = (sizeSource: string | null) =>
  ({ state: 'SC', addressKey: null, address: { line1: '1 Sample Avenue' }, mlsRecordId: null, mirrorListingId: null, connectionId: null, listingId: null, sizeSource }) as never;
const result = (sources: (string | null)[]) =>
  ({ comps: sources.map((s, i) => ({ ref: { identity: `sale-${i}`, connectionId: null }, sale: { sizeSource: s } })), listings: {}, connectionIds: [] }) as never;
const input = (subject: string | null, comps: (string | null)[]) =>
  readinessInputOf(resolved(subject), result(comps), conns, 0 as never, { nearMatchDismissed: [], hasValue: true, use: 'automated_notes' });

describe('R-MLS-7: readinessInputOf computes notLivingArea (batch 13, V2-B after the MLS size fix)', () => {
  it('R-MLS-7 E652: finished living area (or no size) passes; total, unfinished or below-grade area on the subject or any comp blocks, in any letter case', () => {
    expect(input('LivingArea', ['LivingArea', null, 'entered']).notLivingArea).toBe(false);
    expect(input(null, []).notLivingArea).toBe(false);
    expect(input('BuildingAreaTotal', ['LivingArea']).notLivingArea).toBe(true);
    expect(input('LivingArea', ['LivingArea', 'buildingareatotal']).notLivingArea).toBe(true);
    for (const f of ['AboveGradeUnfinishedArea', 'BelowGradeFinishedArea', 'BelowGradeUnfinishedArea']) expect([f, input('LivingArea', [f]).notLivingArea]).toEqual([f, true]);
    // the view's warning and readiness use the same rule
    expect(storedNotLivingArea({ resolved: resolved('BuildingAreaTotal') }, result([]))).toBe(true);
  });
});
