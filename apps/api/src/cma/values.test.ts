// Lane V2-B (module 71's AVM part; R-CMA-10, R-CMA-7, R-CMA-5): the seams (one value run, one gate), the in-house
// provider, the note's queue-time and draft checks and the sweep. Real Postgres (app_user, RLS); MLS rows are RESO
// fixtures stored through V1-A's sync; fakes only, nothing real is sent and no external API is called.
import { prepareCma } from '@realty/core/valuation';
import { type Tx, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { mlsConnection } from '../mls/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { clientReadiness, readinessConnections } from './gates.js';
import { inputsSha256Of, valueForSubjectInTx } from './pipeline.js';
import { readinessInputOf, run } from './service.js';
import { engineSubject } from './subject.js';
import { type CmaWorld, address, cmaPack, cmaWorld, contact, daysAgo, localSales, mlsSale } from './testing.js';

let h: ApiHarness;

beforeAll(async () => {
  h = await createApiHarness();
}, 180_000);
afterAll(async () => {
  await h?.close();
});

/** A read-only system transaction of the world's tenant (what InHouseAvm opens). */
function readOnly<T>(w: Pick<CmaWorld, 'tenantId'>, fn: (tx: Tx, now: Parameters<Parameters<typeof withTenantTx>[1]>[1]) => Promise<T>): Promise<T> {
  return withTenantTx(
    systemActor(w.tenantId, 'provider'),
    async (tx, now) => {
      await sql`SET TRANSACTION READ ONLY`.execute(tx);
      return fn(tx, now);
    },
    { db: h.database },
  );
}

const setPack = (conn: string, pack: Record<string, unknown>) => h.su.query('UPDATE integration_connections SET license_pack = $2::jsonb WHERE id = $1', [conn, JSON.stringify(pack)]);

/** A past client's home whose earlier sale is in the MLS (its facts), and `n` local sales. */
async function home(w: CmaWorld, line1: string, n = 8, sale: Parameters<typeof mlsSale>[1] = {}): Promise<{ contactId: string; addressId: string }> {
  if (n > 0) await localSales(w, n);
  const contactId = await contact(w.agents[0]!);
  const addressId = await address(h, w.tenantId, contactId, { kind: 'home', line1 });
  await mlsSale(w, { line1, closeDate: daysAgo(4 * 365), sqft: 1500, beds: 3, ...sale });
  return { contactId, addressId };
}

async function notesReadiness(w: CmaWorld, s: { contactId: string; addressId: string }, o: { selfListingIds?: string[]; dismissed?: string[]; use?: 'client_cma' | 'automated_notes' } = {}) {
  return readOnly(w, async (tx, now) => {
    const v = await valueForSubjectInTx(tx, now, { kind: 'contact_address', contactAddressId: s.addressId }, { contactId: s.contactId, use: 'automated_notes' });
    if (!v.ok) throw new Error(`run: ${v.code}`);
    const r = await clientReadiness(tx, readinessInputOf(v.resolved, v.result, await readinessConnections(tx, now), now, { nearMatchDismissed: o.dismissed ?? [], hasValue: v.result.available, use: o.use ?? 'automated_notes', selfListingIds: o.selfListingIds ?? [] }));
    return r.share.blockers.map((b) => b.code);
  });
}

describe('lane V2-B deliverable 1: one value run, one gate (no behaviour change for V1)', () => {
  it('R-CMA-10 R-CMA-5: valueForSubjectInTx completes in a READ ONLY transaction, writes nothing, and the same inputs give the same inputsSha256 and value in any order', async () => {
    const w = await cmaWorld(h);
    const s = await home(w, '901 Sample Avenue');
    const before = (await h.su.query<{ n: number }>('SELECT count(*)::int AS n FROM cma_reports WHERE tenant_id = $1', [w.tenantId])).rows[0]!.n;
    const a = await readOnly(w, (tx, now) => valueForSubjectInTx(tx, now, { kind: 'contact_address', contactAddressId: s.addressId }, { contactId: s.contactId, use: 'automated_notes' }));
    const b = await readOnly(w, (tx, now) => valueForSubjectInTx(tx, now, { kind: 'contact_address', contactAddressId: s.addressId }, { contactId: s.contactId, use: 'automated_notes' }));
    if (!a.ok || !b.ok) throw new Error('fixture');
    expect(a.result.available).toBe(true);
    expect(a.inputsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(b.inputsSha256).toBe(a.inputsSha256);
    expect((await h.su.query<{ n: number }>('SELECT count(*)::int AS n FROM cma_reports WHERE tenant_id = $1', [w.tenantId])).rows[0]!.n).toBe(before);
    // the candidates in reverse order: the same hash, and V1-B's engine gives the same value
    await readOnly(w, async (tx) => {
      const r = await run(tx, a.conns, a.resolved, a.valuationDate, [], []);
      const subject = engineSubject(a.resolved);
      const reversed = [...r.candidates].reverse();
      expect(inputsSha256Of({ subject, candidates: reversed, tierReads: r.tierReads, valuationDate: a.valuationDate, methodVersion: r.result.methodVersion })).toBe(a.inputsSha256);
      const x = prepareCma({ subject, candidates: r.candidates, tierReads: r.tierReads, valuationDate: a.valuationDate, include: [], exclude: [] });
      const y = prepareCma({ subject, candidates: reversed, tierReads: r.tierReads, valuationDate: a.valuationDate, include: [], exclude: [] });
      expect(y.available && x.available && y.valueCents === x.valueCents && y.lowCents === x.lowCents && y.highCents === x.highCents).toBe(true);
    });
  });

  it('R-CMA-7 R-CMA-10: under automated_notes, a pack recording client_cma but not automated_notes is CLIENT_USE_NOT_ALLOWED; under V1 the same pack is not', async () => {
    const w = await cmaWorld(h);
    const s = await home(w, '902 Sample Avenue');
    await setPack(w.mls, cmaPack({ valuation: { client_cma: true, automated_notes: false } }));
    // no connection records the use: the run itself is refused in words
    const v = await readOnly(w, (tx, now) => valueForSubjectInTx(tx, now, { kind: 'contact_address', contactAddressId: s.addressId }, { contactId: s.contactId, use: 'automated_notes' }));
    expect(v).toMatchObject({ ok: false, code: 'CMA_VALUATION_NOT_ALLOWED', sentence: expect.stringMatching(/does not record that automated home-value notes may use MLS sold data/) });
    // a run made while the use was recorded, read after it was withdrawn
    await setPack(w.mls, cmaPack());
    const codes = await readOnly(w, async (tx, now) => {
      const r = await valueForSubjectInTx(tx, now, { kind: 'contact_address', contactAddressId: s.addressId }, { contactId: s.contactId, use: 'automated_notes' });
      if (!r.ok) throw new Error('fixture');
      return r;
    });
    await setPack(w.mls, cmaPack({ valuation: { client_cma: true, automated_notes: false } }));
    const read = (use: 'client_cma' | 'automated_notes') =>
      readOnly(w, async (tx, now) => (await clientReadiness(tx, readinessInputOf(codes.resolved, codes.result, await readinessConnections(tx, now), now, { nearMatchDismissed: [], hasValue: true, use }))).share.blockers);
    const notes = await read('automated_notes');
    expect(notes.map((b) => b.code)).toEqual(['PLATFORM_NOT_CLEARED', 'CLIENT_USE_NOT_ALLOWED']);
    expect(notes.find((b) => b.code === 'CLIENT_USE_NOT_ALLOWED')!.sentence).toMatch(/automated home-value notes and seller value ranges/);
    expect(notes.find((b) => b.code === 'PLATFORM_NOT_CLEARED')!.sentence).toMatch(/Home-value notes and seller value ranges/);
    expect((await read('client_cma')).map((b) => b.code)).toEqual(['PLATFORM_NOT_CLEARED']);
  });

  it('E627 R-CMA-10: avm_flag_scope internet_display_only with the home live in the MLS saying N withholds notes (M2), not a V1 client CMA', async () => {
    const w = await cmaWorld(h, { pack: cmaPack({ valuation: { avm_flag_scope: 'internet_display_only' } }) });
    const s = await home(w, '903 Sample Avenue');
    await mlsSale(w, { line1: '903 Sample Avenue', status: 'active', closePriceCents: null, closeDate: null, avmDisplayAllowed: false });
    expect(await notesReadiness(w, s)).toContain('SELLER_WITHHELD');
    expect(await notesReadiness(w, s, { use: 'client_cma' })).not.toContain('SELLER_WITHHELD');
  });

  it('E370 E633 R-CMA-7: under automated_notes a dismissed near match still blocks; a listing of the subject itself (selfListingIds) is never one, under either use', async () => {
    const w = await cmaWorld(h);
    const s = await home(w, '904 Sample Avenue');
    const near = await mlsSale(w, { line1: '904 Sample Street', status: 'active', closePriceCents: null, closeDate: null });
    expect(await notesReadiness(w, s, { dismissed: [near] })).toContain('POSSIBLE_LIVE_LISTING');
    expect(await notesReadiness(w, s, { dismissed: [near], use: 'client_cma' })).not.toContain('POSSIBLE_LIVE_LISTING');
    expect(await notesReadiness(w, s, { selfListingIds: [near] })).not.toContain('POSSIBLE_LIVE_LISTING');
    expect(await notesReadiness(w, s, { selfListingIds: [near], use: 'client_cma' })).not.toContain('POSSIBLE_LIVE_LISTING');
  });

  it('R-CMA-6 R-CMA-10: a connection whose pack records agent_cma but not automated_notes is never read by the run', async () => {
    const w = await cmaWorld(h);
    const b = { h, tenantId: w.tenantId, mls: await mlsConnection(h, w.tenantId, w.owner.userId!, { pack: cmaPack({ valuation: { automated_notes: false } }), lastSyncedAt: new Date() }) };
    await localSales(b, 8);
    const s = await home(w, '905 Sample Avenue', 8);
    const v = await readOnly(w, (tx, now) => valueForSubjectInTx(tx, now, { kind: 'contact_address', contactAddressId: s.addressId }, { contactId: s.contactId, use: 'automated_notes' }));
    if (!v.ok) throw new Error('fixture');
    expect(v.result.connectionIds).toEqual([w.mls]);
    expect(v.result.comps.every((c) => c.ref.connectionId === w.mls)).toBe(true);
    // a seller range also needs client_cma (M1): with it withdrawn on A, nothing is left
    await setPack(w.mls, cmaPack({ valuation: { client_cma: false } }));
    const r = await readOnly(w, (tx, now) => valueForSubjectInTx(tx, now, { kind: 'contact_address', contactAddressId: s.addressId }, { contactId: s.contactId, use: 'automated_notes', sellerRange: true }));
    expect(r).toMatchObject({ ok: false, code: 'CMA_VALUATION_NOT_ALLOWED' });
  });
});
