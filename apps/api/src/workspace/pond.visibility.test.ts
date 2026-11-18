// A historical pond occurrence must not return when a contact becomes visible again in another pond.
import type { UserActor } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness, type TestClient } from '../auth/testHarness.js';
import { depsFromPlatform } from '../comms/runtime.js';
import { materializeFeed, readFeed, refreshFeed } from './feed.js';
import { acceptedLead, call, command, feedOf, workspaceWorld } from './testing.js';

let h: ApiHarness;
beforeAll(async () => { h = await createApiHarness(); });
afterAll(async () => { await h?.close(); });
const actorOf = (c: TestClient) => ({ kind: 'user', userId: c.userId!, tenantId: c.tenantId!, role: c.role!, sessionId: 'pond-visibility' }) as UserActor;
const visible = (c: TestClient, id: string) => withTenantTx(actorOf(c), async (tx) =>
  (await sql`SELECT id FROM contacts WHERE id = ${id}`.execute(tx)).rows.length > 0, { db: h.database });

it.each(['open', 'snoozed'] as const)('R-OWN-16 R-PERM-6 R-TEN-5: a historical %s pond card closes when visibility returns through a different, unclaimable pond', async (state) => {
  const w = await workspaceWorld(h, { agents: 2, teamLead: true, others: ['agent'] });
  const viewer = w.teamLead!;
  const outside = w.others[0]!;
  const elsewhere = await workspaceWorld(h, { agents: 1, teamLead: false });
  const p = await call<{ pond: { id: string } }>(w.owner, 'POST', '/ponds', { name: 'Different team pond', openToAll: false });
  expect(p.status).toBe(201);
  const pond = p.body.pond.id;
  // The team lead can see their member's pond contacts, but is not personally eligible to claim them.
  expect((await call(w.owner, 'PUT', `/ponds/${pond}/members`, { userIds: [outside.userId, w.agents[0]!.userId] })).status).toBe(200);
  const lead = await acceptedLead(h, w, { fullName: 'Historical Pondsworth' });
  expect((await command(lead.owner, lead.contactId, 'release', { reason: 'not_a_fit' })).status).toBe(200);
  const old = (await feedOf(viewer)).all.find((c) => c.itemType === 'pond_new' && c.contact?.id === lead.contactId)!;
  expect(old).toBeDefined();
  expect(old.contact!.name).toBe('Historical P.');
  if (state === 'snoozed') {
    expect((await call(viewer, 'POST', `/feed/${old.id}/snooze`, { until: new Date(Date.now() + 3_600_000).toISOString() })).status).toBe(200);
  }
  expect((await command(w.owner, lead.contactId, 'reassign', { toUserId: outside.userId, reason: 'MANUAL_ASSIGN' })).status).toBe(200);
  expect(await visible(viewer, lead.contactId)).toBe(false);
  expect((await feedOf(viewer)).all.some((c) => c.id === old.id)).toBe(false);
  // RLS hid the historical row from the attempted cleanup while its contact was outside the team.
  expect((await h.su.query('SELECT state FROM priority_feed_items WHERE id = $1', [old.id])).rows).toEqual([{ state }]);
  expect((await command(outside, lead.contactId, 'release', { reason: 'not_a_fit', toPondId: pond })).status).toBe(200);
  expect(await visible(viewer, lead.contactId)).toBe(true);
  expect(await visible(elsewhere.agents[0]!, lead.contactId)).toBe(false);
  const result = await withTenantTx(actorOf(viewer), async (tx, now) => {
    expect((await sql`SELECT * FROM app.my_pond_leads(NULL, ${[lead.contactId]}::uuid[])`.execute(tx)).rows).toEqual([]);
    const incremental = await materializeFeed(tx, actorOf(viewer), depsFromPlatform(h.app.platform), now);
    const scoped = await readFeed(tx, actorOf(viewer), now);
    await sql`SAVEPOINT full_comparison`.execute(tx);
    await refreshFeed(tx, actorOf(viewer), depsFromPlatform(h.app.platform), now);
    const full = await readFeed(tx, actorOf(viewer), now);
    await sql`ROLLBACK TO SAVEPOINT full_comparison`.execute(tx);
    return { incremental, scoped, full };
  }, { db: h.database });
  expect(result.scoped).toEqual(result.full);
  expect([...result.scoped.pinned, ...result.scoped.scored].some((c) => c.contact?.id === lead.contactId)).toBe(false);
  expect(result.scoped.total).toBe(result.scoped.pinned.length + result.scoped.scored.length);
  expect((await h.su.query('SELECT state, resolved_by FROM priority_feed_items WHERE id = $1', [old.id])).rows)
    .toEqual([{ state: 'done', resolved_by: 'condition' }]);
  expect(result.incremental.mode).toBe('groups');
  expect((await feedOf(elsewhere.agents[0]!)).all.some((c) => c.contact?.id === lead.contactId)).toBe(false);
});

it('R-OWN-16: idle incremental revalidation costs one query independent of card count', async () => {
  const w = await workspaceWorld(h, { agents: 1, teamLead: false });
  const viewer = w.agents[0]!;
  const measure = () => withTenantTx(actorOf(viewer), async (tx, now) => {
    const queries: string[] = [];
    const counted = tx.withPlugin({
      transformQuery(args) { queries.push(JSON.stringify(args.node)); return args.node; },
      async transformResult(args) { return args.result; },
    });
    const result = await materializeFeed(counted, actorOf(viewer), depsFromPlatform(h.app.platform), now);
    return { result, queries };
  }, { db: h.database });
  await feedOf(viewer);
  let expectedCards = 0;
  for (const n of [0, 1, 8]) {
    expectedCards += n;
    for (let i = 0; i < n; i++) {
      const lead = await acceptedLead(h, w, { fullName: 'Synthetic Pondsworth' });
      expect((await command(lead.owner, lead.contactId, 'release', { reason: 'not_a_fit' })).status).toBe(200);
    }
    await feedOf(viewer);
    expect((await h.su.query<{ n: number }>(`SELECT count(*)::int AS n FROM priority_feed_items WHERE tenant_id = $1 AND user_id = $2 AND item_type = 'pond_new' AND state = 'open'`, [w.tenantId, viewer.userId])).rows[0]!.n).toBe(expectedCards);
    const measured = await measure();
    expect(measured.result).toEqual({ mode: 'none', groups: 0 });
    // Baseline lock, dirty, due, waking snoozes: four. Revalidation adds one.
    expect(measured.queries).toHaveLength(5);
    expect(measured.queries.filter((q) => q.includes('WITH stored AS MATERIALIZED'))).toHaveLength(1);
  }
});
