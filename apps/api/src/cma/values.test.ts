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
import { type CmaWorld, TEST_STATEMENT, address, cmaPack, cmaWorld, contact, daysAgo, feedLastSyncedAt, localSales, mlsSale, teamListing } from './testing.js';
import { actionsOf, call, depsOf, messagesOf, pointId, runJobs } from '../assistant/testing.js';
import { depsFromPlatform } from '../comms/runtime.js';
import { TEST_ATTRIBUTION, TEST_DISCLAIMER } from '../mls/testing.js';
import { avmRefresh } from '../nurture/avm.js';
import { executeTriggerRunInTx } from '../nurture/execute.js';
import { type NurtureWorld, type PastClient, approveTemplate, firingsDue, nurtureWorld, pastClient, reconcileAndRun, triggerRuns, valuationsOf, withAvmCleared } from '../nurture/testing.js';
import type { AvmProvider } from '../providers/integrations/types.js';
import { IN_HOUSE_REF, InHouseAvm, LINES_REQUIRED_SENTENCE, cancelIneligibleHomeValueNotesInTx, longDate } from './avm.js';
import { complianceSweepInTx } from '../mls/sweep.js';
import { FakeAvmP2 } from '../providers/integrations/fakes.js';
import { randomUUID } from 'node:crypto';
import type { Database } from '@realty/db';
import type { KyselyPlugin } from 'kysely';

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

// ---- the note (deliverable 3) ------------------------------------------------------------------------------------

const SC = { city: 'Springfield', region: 'SC', postalCode: '29401' } as const;
const scPack = (valuation: Record<string, unknown> = {}, o: Parameters<typeof cmaPack>[0] = {}) => cmaPack({ ...o, valuation: { statements: { SC: { text: TEST_STATEMENT, min_point_size: 10 } }, ...valuation } });
const mw = (w: NurtureWorld) => ({ h, tenantId: w.tenantId, mls: w.mls });

async function withCmaCleared<T>(fn: () => Promise<T>): Promise<T> {
  await h.su.query("UPDATE jurisdiction_packs SET reviewed_by_counsel_at = now() WHERE key = 'platform:cma' AND status = 'published'");
  try {
    return await fn();
  } finally {
    await h.su.query("UPDATE jurisdiction_packs SET reviewed_by_counsel_at = NULL WHERE key = 'platform:cma'");
  }
}
const bothCleared = <T>(fn: () => Promise<T>) => withCmaCleared(() => withAvmCleared(h, fn));
const rangeLimit = (w: NurtureWorld, bps: number) => h.su.query('UPDATE tenant_settings SET avm_max_range_bps = $2 WHERE tenant_id = $1', [w.tenantId, bps]);

/** A nurture world whose MLS pack records every valuation use with a statement for SC, After-closing alerts approved. */
async function noteWorld(pack: Record<string, unknown> = scPack(), o: Parameters<typeof nurtureWorld>[1] = {}): Promise<NurtureWorld> {
  const w = await nurtureWorld(h, o);
  await setPack(w.mls, pack);
  await approveTemplate(w.agents[0]!, 'after_closing_alerts');
  await rangeLimit(w, 10_000); // the engine's range on the fixture: the tenant limit is data (owner question 7)
  return w;
}

/** A past client of agents[0] whose home's earlier sale is in the MLS, next to `n` local sales. */
async function covered(w: NurtureWorld, n = 8): Promise<PastClient> {
  const c = await pastClient(h, w, w.agents[0]!);
  if (n > 0) await localSales(mw(w), n, SC);
  await mlsSale(mw(w), { line1: c.line1, ...SC, closeDate: daysAgo(1500), sqft: 1500, beds: 3 });
  return c;
}

const estimate = (w: NurtureWorld, avm: AvmProvider = new InHouseAvm()) => avmRefresh({ db: h.database, ids: depsFromPlatform(h.app.platform).ids, avm }, w.tenantId);
const homeMail = async (c: PastClient) => (await messagesOf(h, c.id)).filter((m) => m.action_category === 'nurture_step');
const skipOf = async (c: PastClient) => ((await triggerRuns(h, c.id))[0]?.trigger_ref as { skip?: { reason: string } } | undefined)?.skip?.reason;
type Runs = { runs: { trigger: string; status: string; fact: { text: string } | null }[] };

/** The estimate, then the firing is due and executeTriggerRun builds it (and dispatch sends it). */
async function noteFor(w: NurtureWorld, c: PastClient, between: () => Promise<unknown> = async () => {}): Promise<void> {
  await estimate(w);
  await between();
  await firingsDue(h, c.id);
  await reconcileAndRun(h, w.tenantId);
}

describe('lane V2-B deliverable 3: the in-house note and its queue-time re-check (R-CMA-7, R-CMA-10, R-NURT-4)', () => {
  it('R-CMA-10 R-AVM-1 acceptance: both packs cleared ⇒ one monthly note with the estimate sentence, the state statement, attribution, disclaimer and "MLS data as of" the estimate\'s date, queued by executeTriggerRun and sent by dispatch; provider_ref is the in-house ref', async () => {
    const w = await noteWorld();
    const c = await covered(w);
    await bothCleared(() => noteFor(w, c));
    const [v] = await valuationsOf(h, c.addressId);
    expect(v).toMatchObject({ status: 'ok', provider: 'recent MLS sales', display_allowed: true });
    expect((await h.su.query<{ r: string }>('SELECT provider_ref AS r FROM home_valuations WHERE id = $1', [v!.id])).rows[0]!.r).toMatch(IN_HOUSE_REF);
    const sent = await homeMail(c);
    expect(sent.map((m) => m.status)).toEqual(['sent']);
    const body = sent[0]!.body;
    expect(body).toMatch(new RegExp(`Estimated value: \\$[\\d,]+ \\(range \\$[\\d,]+–\\$[\\d,]+\\), from recent MLS sales as of ${longDate(v!.as_of!).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\. This is an estimate, not an appraisal\\.`));
    for (const line of [TEST_STATEMENT, TEST_ATTRIBUTION, TEST_DISCLAIMER, `MLS data as of ${longDate(v!.as_of!)}.`]) expect(body).toContain(line);
    expect(body.indexOf('This is an estimate, not an appraisal.')).toBeLessThan(body.indexOf(TEST_STATEMENT));
    expect(h.providers.email.sent.filter((m) => m.to === c.email)).toHaveLength(1);
    // a second pass the same month requests nothing
    expect(await bothCleared(() => estimate(w))).toMatchObject({ requested: 0 });
  });

  it('R-CMA-10 R-AVM-2: a range over the tenant limit with both packs is a draft carrying every line, the as-of line naming the estimate\'s date', async () => {
    const w = await noteWorld();
    await rangeLimit(w, 100);
    const c = await covered(w);
    await bothCleared(() => noteFor(w, c));
    const [run] = await triggerRuns(h, c.id);
    expect(run!.status).toBe('converted_to_draft');
    const d = (await actionsOf(h, c.id)).find((a) => a.id === run!.assistant_action_id)!;
    expect(d.payload['draftReasons']).toEqual(['AVM_RANGE_TOO_WIDE']);
    const [v] = await valuationsOf(h, c.addressId);
    for (const line of ['This is an estimate, not an appraisal.', TEST_STATEMENT, TEST_ATTRIBUTION, TEST_DISCLAIMER, `MLS data as of ${longDate(v!.as_of!)}.`]) expect(String(d.payload['body'])).toContain(line);
    expect(await homeMail(c)).toEqual([]);
  });

  it('E369 E636 R-CMA-6: a feed 3 days stale under a 24 h limit (as-of within 35 days, both packs) ⇒ skipped ESTIMATE_NOT_DISPLAYABLE, nothing queued, and the fact read by the agent and an ISA (its own past client) says "Estimate not shown to clients." with no number; a TC on the deal sees no firing at all', async () => {
    const w = await noteWorld(scPack(), { others: ['isa', 'tc'] });
    const [isa, tc] = w.others;
    const roles = await Promise.all([w.agents[0]!, isa!, tc!].map(async (by) => (await h.su.query<{ role: string }>('SELECT role FROM memberships WHERE tenant_id = $1 AND user_id = $2', [w.tenantId, by.userId])).rows[0]?.role));
    expect(roles).toEqual(['agent', 'isa', 'tc']);
    // contact.view_detail: an ISA reads its own contacts, a TC the contacts of its deals (core authz MATRIX)
    const c = await covered(w);
    await approveTemplate(isa!, 'after_closing_alerts');
    const mine = await pastClient(h, w, isa!);
    await mlsSale(mw(w), { line1: mine.line1, ...SC, closeDate: daysAgo(1500), sqft: 1500, beds: 3 });
    await h.su.query("INSERT INTO deal_members (tenant_id, deal_id, user_id, role) VALUES ($1, $2, $3, 'tc')", [w.tenantId, c.dealId, tc!.userId]);
    await feedLastSyncedAt(mw(w), new Date(Date.now() - 3 * 86_400_000));
    await bothCleared(async () => {
      await estimate(w);
      for (const x of [c, mine]) await firingsDue(h, x.id);
      await reconcileAndRun(h, w.tenantId);
    });
    for (const x of [c, mine]) {
      expect((await valuationsOf(h, x.addressId))[0]).toMatchObject({ status: 'ok', display_allowed: false });
      expect(await skipOf(x)).toBe('ESTIMATE_NOT_DISPLAYABLE');
      expect(await homeMail(x)).toEqual([]);
    }
    // b13 audit V2B-9: every read must succeed (a refused read is a failure, never skipped)
    for (const [who, by, x] of [['agent', w.agents[0]!, c], ['isa', isa!, mine]] as const) {
      const r = await call<Runs>(by, 'GET', `/contacts/${x.id}/trigger-runs`);
      expect([who, r.status]).toEqual([who, 200]);
      const run = r.body.runs.find((y) => y.trigger === 'home_value');
      expect([who, run?.fact?.text]).toEqual([who, expect.stringMatching(/Estimate not shown to clients\.$/)]);
      expect([who, JSON.stringify(r.body)]).toEqual([who, expect.not.stringMatching(/\$\s?\d/)]);
    }
    // a TC on the deal reads 200 and no firing at all: module 26's read joins each run's playbook, and the agent's
    // personal After-closing alerts playbook is not visible to a TC (0001 playbooks_select: scope 'team', the owner or
    // a tenant-wide reader), so the TC sees neither the snippet nor any number
    const t = await call<Runs>(tc!, 'GET', `/contacts/${c.id}/trigger-runs`);
    expect([t.status, t.body]).toEqual([200, { runs: [] }]);
  });

  it('E370 E374 E625 R-CMA-10: a live near match, the home relisted saying N, the home live in the MLS saying Y, or a live team listing not yet in the MLS ⇒ not displayable, a visible skip', async () => {
    const w = await noteWorld();
    const near = await covered(w);
    await mlsSale(mw(w), { line1: near.line1.replace('Birch Ln', 'Birch Lane'), ...SC, status: 'active', closePriceCents: null, closeDate: null });
    const relistN = await covered(w, 0);
    await mlsSale(mw(w), { line1: relistN.line1, ...SC, status: 'active', closePriceCents: null, closeDate: null, avmDisplayAllowed: false });
    const liveY = await covered(w, 0);
    await mlsSale(mw(w), { line1: liveY.line1, ...SC, status: 'active', closePriceCents: null, closeDate: null, avmDisplayAllowed: true });
    const team = await covered(w, 0);
    await teamListing(w.agents[0]!, { addressLine1: team.line1, ...SC, status: 'active' });
    await bothCleared(async () => {
      await estimate(w);
      for (const c of [near, relistN, liveY, team]) await firingsDue(h, c.id);
      await reconcileAndRun(h, w.tenantId);
    });
    for (const c of [near, relistN, liveY, team]) {
      expect((await valuationsOf(h, c.addressId))[0]?.display_allowed).toBe(false);
      expect(await skipOf(c)).toBe('ESTIMATE_NOT_DISPLAYABLE');
      expect(await homeMail(c)).toEqual([]);
    }
  });

  it('E622 R-NURT-4: the valuation review, platform:cma or platform:avm withdrawn between the estimate and trigger.step ⇒ a visible skip, no draft, no message', async () => {
    const w = await noteWorld();
    const cs = [await covered(w), await covered(w, 0), await covered(w, 0)];
    await bothCleared(() => estimate(w));
    for (const c of cs) expect((await valuationsOf(h, c.addressId))[0]?.display_allowed).toBe(true);
    for (const c of cs) await firingsDue(h, c.id);
    // 1: the valuation section loses its counsel review; packs cleared
    await setPack(w.mls, scPack({ reviewed_by_counsel_at: null }));
    await bothCleared(() => runOne(w, cs[0]!));
    await setPack(w.mls, scPack());
    // 2: platform:cma not cleared (platform:avm is)
    await withAvmCleared(h, () => runOne(w, cs[1]!));
    // 3: platform:avm not cleared (platform:cma is)
    await withCmaCleared(() => runOne(w, cs[2]!));
    for (const c of cs) {
      expect(await skipOf(c)).toBe('ESTIMATE_NOT_DISPLAYABLE');
      expect((await actionsOf(h, c.id)).filter((a) => a.kind === 'message_draft')).toEqual([]);
      expect(await homeMail(c)).toEqual([]);
    }
  });

  it('E628 R-CMA-7: a statement holding a line break, or an attribution holding a bidi control ⇒ not displayable, never altered', async () => {
    for (const pack of [scPack({ statements: { SC: { text: 'Test statement\nwith a line break.', min_point_size: 10 } } }), { ...scPack(), attribution_text: `Test attribution ‮with a bidi control.` }]) {
      const w = await noteWorld(pack);
      const c = await covered(w);
      await bothCleared(() => noteFor(w, c));
      expect((await valuationsOf(h, c.addressId))[0]?.display_allowed).toBe(false);
      expect(await skipOf(c)).toBe('ESTIMATE_NOT_DISPLAYABLE');
      expect(await homeMail(c)).toEqual([]);
    }
  });

  it('E637 R-CMA-7: two connections read by the run, one stale ⇒ not displayable', async () => {
    const w = await noteWorld();
    const second = { h, tenantId: w.tenantId, mls: await mlsConnection(h, w.tenantId, w.owner.userId!, { pack: scPack(), lastSyncedAt: new Date() }) };
    await localSales(second, 4, SC);
    const c = await covered(w, 4);
    await feedLastSyncedAt(second, new Date(Date.now() - 3 * 86_400_000));
    await bothCleared(() => noteFor(w, c));
    expect((await valuationsOf(h, c.addressId))[0]?.display_allowed).toBe(false);
    expect(await skipOf(c)).toBe('ESTIMATE_NOT_DISPLAYABLE');
  });

  it('E634 R-CMA-10: an in-house-named row whose provider_ref was cleared (superuser fixture), or one naming another tenant\'s connection, is not displayable at queue time', async () => {
    const w = await noteWorld();
    const other = await noteWorld();
    const cleared = await covered(w);
    const foreign = await covered(w, 0);
    await bothCleared(() => estimate(w));
    await h.su.query('UPDATE home_valuations SET provider_ref = NULL WHERE contact_address_id = $1', [cleared.addressId]);
    await h.su.query("UPDATE home_valuations SET provider_ref = regexp_replace(provider_ref, ':[0-9a-f-]{36}:', ':' || $2 || ':') WHERE contact_address_id = $1", [foreign.addressId, other.mls]);
    for (const c of [cleared, foreign]) await firingsDue(h, c.id);
    await bothCleared(() => reconcileAndRun(h, w.tenantId));
    for (const c of [cleared, foreign]) {
      expect(await skipOf(c)).toBe('ESTIMATE_NOT_DISPLAYABLE');
      expect(await homeMail(c)).toEqual([]);
    }
  });

  it('R-GATE-14 D1: a client who opts out after the note was queued gets nothing: a blocked gate decision, and the fake email provider receives nothing', async () => {
    const w = await noteWorld();
    const c = await covered(w);
    await bothCleared(async () => {
      await estimate(w);
      await firingsDue(h, c.id);
      const [run] = await triggerRuns(h, c.id);
      await withTenantTx(systemActor(w.tenantId, 'assistant'), (tx, now) => executeTriggerRunInTx(tx, depsOf(h), w.tenantId, run!.id, now), { db: h.database });
      expect((await homeMail(c)).map((m) => m.status)).toEqual(['queued']);
      expect((await call(w.agents[0]!, 'POST', `/contacts/${c.id}/consent`, { kind: 'revoke', pointId: await pointId(h, c.id, 'email'), channel: 'email', purpose: 'all', evidence: {} })).status).toBe(200);
      await runJobs(h, w.tenantId, ['comms.dispatch']);
    });
    const [m] = await homeMail(c);
    expect(m!.status).toBe('blocked');
    expect((await h.su.query('SELECT outcome FROM gate_decisions WHERE message_id = $1', [m!.id])).rows).toEqual([expect.objectContaining({ outcome: 'deny' })]);
    expect(h.providers.email.sent.filter((x) => x.to === c.email)).toEqual([]);
  });

  it('E620 R-INT-6: GET /nurture/triggers says which pack or connection is missing when the in-house source is configured', async () => {
    const w = await noteWorld();
    const bag = h.providers.integrations as { avm: AvmProvider };
    const fake = bag.avm;
    bag.avm = new InHouseAvm();
    try {
      const note = async () => (await call<{ triggers: { trigger: string; availability: string; note: string | null }[] }>(w.agents[0]!, 'GET', '/nurture/triggers')).body.triggers.find((t) => t.trigger === 'home_value')!;
      expect(await note()).toEqual({ trigger: 'home_value', availability: 'not_available_yet', label: expect.any(String), note: 'Home-value notes from recent MLS sales wait for counsel review of both platform:cma and platform:avm. Nothing is requested or sent until it is recorded.' });
      expect((await withAvmCleared(h, note)).note).toBe('Home-value notes from recent MLS sales wait for counsel review of platform:cma. Nothing is requested or sent until it is recorded.');
      expect((await withCmaCleared(note)).note).toBe('Home-value notes from recent MLS sales wait for counsel review of platform:avm. Nothing is requested or sent until it is recorded.');
      await setPack(w.mls, scPack({ automated_notes: false }));
      expect((await bothCleared(note)).note).toMatch(/^Your MLS licence pack does not record that automated home-value notes may use MLS sold data/);
      await h.su.query("UPDATE integration_connections SET status = 'disconnected', disconnected_at = now() WHERE id = $1", [w.mls]);
      expect((await bothCleared(note)).note).toBe('Home values need a live MLS connection.');
    } finally {
      bag.avm = fake;
    }
  });
});

/** executeTriggerRun for one client's due run, as trigger.step runs it. */
async function runOne(w: NurtureWorld, c: PastClient): Promise<void> {
  const [run] = await triggerRuns(h, c.id);
  await withTenantTx(systemActor(w.tenantId, 'assistant'), (tx, now) => executeTriggerRunInTx(tx, depsOf(h), w.tenantId, run!.id, now), { db: h.database });
}

// ---- after the queue (deliverable 4) -----------------------------------------------------------------------------

/** The database handle with every statement's text recorded (a query spy: proves which reads a pass makes). */
function spied(): { db: Database; statements: string[] } {
  const statements: string[] = [];
  const plugin: KyselyPlugin = {
    transformQuery: (a) => {
      statements.push(JSON.stringify(a.node));
      return a.node;
    },
    transformResult: async (a) => a.result,
  };
  return { db: { ...h.database, kysely: h.database.kysely.withPlugin(plugin) } as Database, statements };
}

const sweep = (w: NurtureWorld, db: Database = h.database) => withTenantTx(systemActor(w.tenantId, 'worker'), (tx, now) => complianceSweepInTx(tx, systemActor(w.tenantId, 'worker'), now), { db });
const runStatus = async (c: PastClient) => (await triggerRuns(h, c.id)).map((r) => [r.status, (r.trigger_ref as { skip?: { reason: string } }).skip?.reason ?? null]);
const approve = (w: NurtureWorld, id: string, body: Record<string, unknown> = {}) => call<{ error?: { code: string; details?: Record<string, unknown> } }>(w.agents[0]!, 'POST', `/assistant/actions/${id}/approve`, { commandId: randomUUID(), ...body });
const actionStatus = async (id: string) => (await h.su.query<{ status: string }>('SELECT status FROM assistant_actions WHERE id = $1', [id])).rows[0]!.status;

/** The note queued by executeTriggerRun (dispatch not yet run). */
async function queuedNote(w: NurtureWorld, c: PastClient): Promise<string> {
  await estimate(w);
  await firingsDue(h, c.id);
  await runOne(w, c);
  const [m] = await homeMail(c);
  expect(m!.status).toBe('queued');
  return m!.id;
}

/** A RANGE_TOO_WIDE draft of an in-house estimate (both packs cleared while it is built). */
async function rangeDraft(w: NurtureWorld, c: PastClient): Promise<{ id: string; body: string }> {
  await rangeLimit(w, 100);
  await bothCleared(() => noteFor(w, c));
  const [run] = await triggerRuns(h, c.id);
  expect(run!.status).toBe('converted_to_draft');
  const a = (await actionsOf(h, c.id)).find((x) => x.id === run!.assistant_action_id)!;
  return { id: a.id, body: String(a.payload['body']) };
}

describe('lane V2-B deliverable 4: after the queue (the sweep, draft approval)', () => {
  it('E623 R-CMA-7: one sweep pass cancels a queued in-house note once its feed goes stale and skips its runs; a second pass changes nothing; dispatched and FakeAvmP2 notes are untouched; no near-match read', async () => {
    const w = await noteWorld();
    const sent = await covered(w);
    const queued = await covered(w, 0);
    // `sent` is built and dispatched; then `queued` is built and left queued
    await bothCleared(async () => {
      await estimate(w);
      await firingsDue(h, sent.id);
      await reconcileAndRun(h, w.tenantId);
    });
    const qid = await bothCleared(async () => {
      await firingsDue(h, queued.id);
      await runOne(w, queued);
      return (await homeMail(queued))[0]!.id;
    });
    // a FakeAvmP2 note, queued (its client added after the in-house pass)
    const fakeOne = await pastClient(h, w, w.agents[0]!);
    await withAvmCleared(h, async () => {
      await estimate(w, new FakeAvmP2());
      await firingsDue(h, fakeOne.id);
      await runOne(w, fakeOne);
    });
    expect((await homeMail(fakeOne)).map((m) => m.status)).toEqual(['queued']);
    expect((await homeMail(sent)).map((m) => m.status)).toEqual(['sent']);
    await feedLastSyncedAt(mw(w), new Date(Date.now() - 3 * 86_400_000));
    const spy = spied();
    const r = await bothCleared(() => sweep(w, spy.db));
    expect(r.canceledHomeValueNotes).toBe(1);
    expect(spy.statements.some((q) => q.includes("('coming_soon','active','pending')"))).toBe(false);
    const [m] = await homeMail(queued);
    expect([m!.id, m!.status, m!.status_reason]).toEqual([qid, 'canceled', 'HOME_VALUE_NOT_DISPLAYABLE']);
    expect(await runStatus(queued)).toEqual([['skipped_ineligible', 'ESTIMATE_NOT_DISPLAYABLE']]);
    const action = (await actionsOf(h, queued.id)).find((a) => a.kind === 'autonomous_message')!;
    expect(action.status).toBe('blocked');
    // idempotent; the dispatched one and the FakeAvmP2 one untouched
    expect((await bothCleared(() => sweep(w))).canceledHomeValueNotes).toBe(0);
    expect((await homeMail(sent)).map((x) => x.status)).toEqual(['sent']);
    expect((await homeMail(fakeOne)).map((x) => x.status)).toEqual(['queued']);
  });

  it('E623 R-CMA-7: platform:cma withdrawn after the note was queued (feed fresh) ⇒ the sweep cancels it too', async () => {
    const w = await noteWorld();
    const c = await covered(w);
    const id = await bothCleared(() => queuedNote(w, c));
    const r = await withAvmCleared(h, () => sweep(w));
    expect(r.canceledHomeValueNotes).toBe(1);
    expect((await homeMail(c)).map((m) => [m.id, m.status])).toEqual([[id, 'canceled']]);
    // and the direct pass is a no-op now
    expect(await withTenantTx(systemActor(w.tenantId, 'worker'), (tx, now) => cancelIneligibleHomeValueNotesInTx(tx, now), { db: h.database })).toEqual([]);
  });

  it('E624 R-CMA-7 R-AST-6: approving a RANGE_TOO_WIDE draft after its feed went stale ⇒ DRAFT_STALE (HOME_VALUE_NOT_DISPLAYABLE) with a sentence; it stays proposed and nothing is queued; a re-review re-tap does not clear it', async () => {
    const w = await noteWorld();
    const c = await covered(w);
    const d = await rangeDraft(w, c);
    await feedLastSyncedAt(mw(w), new Date(Date.now() - 3 * 86_400_000));
    const r = await bothCleared(() => approve(w, d.id));
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'DRAFT_STALE', details: { reason: 'HOME_VALUE_NOT_DISPLAYABLE', code: 'FEED_STALE', sentence: expect.any(String) } });
    expect(await actionStatus(d.id)).toBe('proposed');
    expect(await homeMail(c)).toEqual([]);
    const again = await bothCleared(() => approve(w, d.id, { reviewedInboundSeq: 0 }));
    expect(again.body.error?.code).toBe('DRAFT_STALE');
    expect(await homeMail(c)).toEqual([]);
  });

  it('E624 R-CMA-7: a gate that fails after the tap committed and before the message was queued reverts the approval: proposed, nothing queued', async () => {
    const w = await noteWorld();
    const c = await covered(w);
    const d = await rangeDraft(w, c);
    // state after the approval committed and before the queue transaction (fixture: the decision row as the tap writes it)
    await h.su.query("UPDATE assistant_actions SET status = 'approved', decided_by_user_id = $2, decided_at = now() WHERE id = $1", [d.id, w.agents[0]!.userId]);
    const r = await withAvmCleared(h, () => approve(w, d.id)); // platform:cma no longer cleared
    expect(r.body.error).toMatchObject({ code: 'DRAFT_STALE', details: { reason: 'HOME_VALUE_NOT_DISPLAYABLE', code: 'PLATFORM_NOT_CLEARED' } });
    expect(await actionStatus(d.id)).toBe('proposed');
    expect(await homeMail(c)).toEqual([]);
  });

  it('E621 R-AVM-1: an edit that drops the statement or changes the value ⇒ VALIDATION_FAILED (HOME_VALUE_LINES_REQUIRED); proposed, nothing queued; the unedited draft approves and is queued', async () => {
    const w = await noteWorld();
    const c = await covered(w);
    const d = await rangeDraft(w, c);
    for (const body of [d.body.replace(TEST_STATEMENT, ''), d.body.replace(/Estimated value: \$[\d,]+/, 'Estimated value: $1,000,000')]) {
      const r = await bothCleared(() => approve(w, d.id, { editedPayload: { body } }));
      expect(r.status).toBe(422);
      expect(r.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'HOME_VALUE_LINES_REQUIRED', sentence: LINES_REQUIRED_SENTENCE } });
      expect(await actionStatus(d.id)).toBe('proposed');
      expect(await homeMail(c)).toEqual([]);
    }
    const ok = await bothCleared(() => approve(w, d.id, { editedPayload: { body: `A short note first.\n${d.body}` } }));
    expect(ok.status).toBe(200);
    expect((await homeMail(c)).length).toBe(1);
  });
});
