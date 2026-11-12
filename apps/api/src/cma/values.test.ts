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
import { IN_HOUSE_REF, InHouseAvm, longDate } from './avm.js';

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
async function noteWorld(pack: Record<string, unknown> = scPack()): Promise<NurtureWorld> {
  const w = await nurtureWorld(h);
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

  it('E369 E636 R-CMA-6: a feed 3 days stale under a 24 h limit (as-of within 35 days, both packs) ⇒ skipped ESTIMATE_NOT_DISPLAYABLE, nothing queued, and the fact shows no number', async () => {
    const w = await noteWorld();
    const c = await covered(w);
    await feedLastSyncedAt(mw(w), new Date(Date.now() - 3 * 86_400_000));
    await bothCleared(() => noteFor(w, c));
    expect((await valuationsOf(h, c.addressId))[0]).toMatchObject({ status: 'ok', display_allowed: false });
    expect(await skipOf(c)).toBe('ESTIMATE_NOT_DISPLAYABLE');
    expect(await homeMail(c)).toEqual([]);
    for (const by of [w.agents[0]!, ...(w.others ?? [])]) {
      const r = await call<Runs>(by, 'GET', `/contacts/${c.id}/trigger-runs`);
      if (r.status !== 200) continue;
      expect(r.body.runs[0]!.fact!.text).toMatch(/Estimate not shown to clients\.$/);
      expect(JSON.stringify(r.body)).not.toMatch(/\$\d/);
    }
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
