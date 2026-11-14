// GET /likely over real Postgres as app_user (module 55's read of module 50's cards; R-STAFF-3, R-STAFF-7, E677).
// Models are synthetic and released by the superuser as the platform would (testing.ts); cards come from the real pass.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { call, contactOf, type WorkspaceWorld, workspaceWorld } from '../workspace/testing.js';
import { LikelyResponse, NO_MODEL_SENTENCE, type LikelyView } from './routes.js';
import { FIRST_PARTY_MODEL, approvedModel, pass, savedListings, setModelStatus, testRegistry } from './testing.js';

let h: ApiHarness;
let w: WorkspaceWorld;
let w2: WorkspaceWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await workspaceWorld(h, { agents: 2 });
  w2 = await workspaceWorld(h, { agents: 1 });
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const likely = async (c: Parameters<typeof call>[0]) => {
  const r = await call<LikelyView>(c, 'GET', '/likely');
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(LikelyResponse.safeParse(r.body).success).toBe(true);
  return r.body;
};

describe('GET /likely (module 55; R-STAFF-7)', () => {
  it('E677 R-STAFF-7: with no approved model the state is no_model with its sentence, never an empty "nobody" list', async () => {
    const v = await likely(w.agents[0]!);
    expect(v).toEqual({ state: 'no_model', sentence: NO_MODEL_SENTENCE, models: [], items: [], more: false });
  });

  it('R-STAFF-7 R-STAFF-3: the caller sees only their own open cards, with the card\'s own reasons, the band in words and the back-test once per model; no points anywhere; DNC hidden; withdrawal hides everything while the rows remain (R-PRED-5, R-PRED-6)', async () => {
    const def = await approvedModel(h, FIRST_PARTY_MODEL);
    const reg = testRegistry(def);
    const [a, b] = [w.agents[0]!, w.agents[1]!];
    const mine = await contactOf(a, { firstName: 'Bryn' });
    const mine2 = await contactOf(a, { firstName: 'Aldo' });
    const theirs = await contactOf(b, { firstName: 'Cato' });
    const otherTenant = await contactOf(w2.agents[0]!, { firstName: 'Dara' });
    for (const c of [mine, mine2, theirs]) await savedListings(h, w.tenantId, c.id, 3);
    await savedListings(h, w2.tenantId, otherTenant.id, 3);
    await pass(h, w.tenantId, { registry: reg });
    await pass(h, w2.tenantId, { registry: reg });

    const v = await likely(a);
    expect(v.state).toBe('ready');
    expect(v.models).toEqual([{ version: def.version, backtest: { flagged: 120, transacted: 31, windowDays: 90 }, sentence: 'Of 120 people flagged in the back-test, 31 transacted within 90 days.' }]);
    const ids = v.items.map((i) => i.contactId);
    expect(ids).toEqual(expect.arrayContaining([mine.id, mine2.id]));
    expect(ids).not.toContain(theirs.id);
    expect(ids).not.toContain(otherTenant.id);
    const row = v.items.find((i) => i.contactId === mine.id)!;
    expect(row.modelVersion).toBe(def.version);
    // R-STAFF-3: the band in this page's own words, with no "score" in them (the feed card keeps module 50's line)
    expect(row.bandWords).toBe({ likely_90d: 'May move in the next 90 days', watch: 'Worth keeping an eye on' }[row.band]);
    expect(row.reasons).toContain('Saved 3 listings recently');
    // the band line and the back-test line are not repeated on the row
    expect(row.reasons.some((r) => /back-test|Scorecard band/.test(r))).toBe(false);
    expect(JSON.stringify(v)).not.toMatch(/points|probabilit|confidence|likelihood|percent|score|rank|grade|%/i);
    // the same band orders by name, never by hidden points
    const sameBand = v.items.filter((i) => i.band === row.band).map((i) => i.contactName.toLowerCase());
    expect(sameBand).toEqual([...sameBand].sort());
    // another tenant's agent sees their own only
    expect((await likely(w2.agents[0]!)).items.map((i) => i.contactId)).toEqual([otherTenant.id]);

    // R-PRED-6: do-not-contact leaves the list at once
    const dnc = await call(a, 'POST', `/contacts/${mine2.id}/do-not-contact`, { reason: 'asked_on_call' });
    expect(dnc.status, JSON.stringify(dnc.body)).toBe(200);
    expect((await likely(a)).items.map((i) => i.contactId)).not.toContain(mine2.id);

    // R-PRED-5: withdrawn ⇒ no_model, while the stored rows remain
    await setModelStatus(h, def.version, 'withdrawn');
    const after = await likely(a);
    expect(after.state).toBe('no_model');
    expect(after.items).toEqual([]);
    const kept = await h.su.query(`SELECT count(*)::int AS n FROM priority_feed_items WHERE tenant_id = $1 AND item_type = 'likely_to_move' AND state = 'open'`, [w.tenantId]);
    expect(kept.rows[0].n).toBeGreaterThan(0);
  });

  it('R-STAFF-7: the route is a SELECT only (predict/architecture.test.ts scans predict/routes.ts on its own) and writes no row: the feed cards, the predictions, the audit log, the jobs and the consent events are the same, row versions included (b14 review F3: jobs and consent events)', async () => {
    // a ready list, so the read reaches the feed and prediction rows (after the withdrawal above it would stop at no_model)
    const def = await approvedModel(h, FIRST_PARTY_MODEL);
    const a = w.agents[0]!;
    const c = await contactOf(a, { firstName: 'Ezra' });
    await savedListings(h, w.tenantId, c.id, 3);
    await pass(h, w.tenantId, { registry: testRegistry(def) });
    // xmin changes on any UPDATE of a row, even one that writes the same values
    const snapshot = async () =>
      (
        await h.su.query<{ t: string; rows: unknown }>(
          `SELECT 'priority_feed_items' AS t, coalesce(jsonb_agg(jsonb_build_object('xmin', f.xmin::text, 'row', to_jsonb(f)) ORDER BY f.id), '[]') AS rows FROM priority_feed_items f WHERE f.tenant_id = $1
           UNION ALL SELECT 'contact_predictions', coalesce(jsonb_agg(jsonb_build_object('xmin', p.xmin::text, 'row', to_jsonb(p)) ORDER BY p.contact_id, p.model_version), '[]') FROM contact_predictions p WHERE p.tenant_id = $1
           UNION ALL SELECT 'audit_log', to_jsonb(count(*)) FROM audit_log WHERE tenant_id = $1
           UNION ALL SELECT 'jobs', coalesce(jsonb_agg(jsonb_build_object('xmin', j.xmin::text, 'id', j.id) ORDER BY j.id), '[]') FROM jobs j WHERE j.tenant_id = $1
           UNION ALL SELECT 'consent_events', to_jsonb(count(*)) FROM consent_events WHERE tenant_id = $1`,
          [w.tenantId],
        )
      ).rows;
    const before = await snapshot();
    expect(JSON.stringify(before)).toContain(c.id);
    const v = await likely(a);
    expect(v.state).toBe('ready');
    expect(v.items.map((i) => i.contactId)).toContain(c.id);
    expect(await snapshot()).toEqual(before);
  });
});
