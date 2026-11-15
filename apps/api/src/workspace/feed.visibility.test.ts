// Stored feed rows must retain the caller's current contacts RLS, including historical rows.
import { randomUUID } from 'node:crypto';
import type { UserActor } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness, type TestClient } from '../auth/testHarness.js';
import { command, contactOf, workspaceWorld } from './testing.js';

let h: ApiHarness;
beforeAll(async () => { h = await createApiHarness(); });
afterAll(async () => { await h?.close(); });
const actorOf = (c: TestClient) => ({ kind: 'user', userId: c.userId!, tenantId: c.tenantId!, role: c.role!, sessionId: 'feed-visibility' }) as UserActor;

it.each(['open', 'snoozed'] as const)('R-PERM-4 R-TEN-5: %s stored cards retain owner, contact, team and tenant visibility independently', async (state) => {
  const w = await workspaceWorld(h, { agents: 2, teamLead: true, others: ['admin'] });
  const foreign = await workspaceWorld(h, { agents: 1 });
  const [a, b] = w.agents as [TestClient, TestClient];
  const own = await contactOf(a);
  const other = await contactOf(b);
  const foreignContact = await contactOf(foreign.agents[0]!);
  const all: string[] = [];
  const seed = async (viewer: TestClient, contact: string | null) => {
    const id = randomUUID(); all.push(id);
    await h.su.query(`INSERT INTO priority_feed_items
      (tenant_id,id,user_id,item_type,band,contact_id,subject_type,subject_id,reasons,dedupe_key,state,snoozed_until)
      VALUES ($1,$2::uuid,$3,'first_touch_due','scored',$4,'contact',$2::uuid,'["VISIBILITY_FIXTURE"]',$2::uuid::text,$5,
        CASE WHEN $5='snoozed' THEN now()+interval '1 hour' ELSE NULL END)`,
    [viewer.tenantId,id,viewer.userId,contact,state]);
    return id;
  };
  const mine = await seed(a, own.id);
  const hidden = await seed(a, other.id);
  const noContact = await seed(a, null);
  const theirs = await seed(b, other.id);
  const team = await seed(w.teamLead!, other.id);
  const elsewhere = await seed(foreign.agents[0]!, foreignContact.id);
  const read = (viewer: TestClient) => withTenantTx(actorOf(viewer), async (tx) =>
    (await sql<{ id: string }>`SELECT id FROM priority_feed_items WHERE id = ANY (${all}::uuid[]) ORDER BY id`.execute(tx)).rows.map((r) => r.id), { db: h.database });
  expect(await read(a)).toEqual([mine, noContact].sort());
  expect(await read(b)).toEqual([theirs]);
  expect(await read(w.teamLead!)).toEqual([team]);
  for (const wide of [w.owner, w.others[0]!]) expect(await read(wide)).toEqual([mine, hidden, noContact, theirs, team].sort());
  expect(await read(foreign.agents[0]!)).toEqual([elsewhere]);
  // Soft deletion hides even the caller's own historical row without deleting that stored row.
  expect((await command(w.owner, own.id, 'delete')).status).toBe(200);
  expect(await read(a)).toEqual([noContact]);
  expect((await h.su.query('SELECT state FROM priority_feed_items WHERE tenant_id=$1 AND id=$2', [w.tenantId, mine])).rows).toEqual([{ state }]);
});
