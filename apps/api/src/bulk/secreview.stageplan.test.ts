// Batch 5 review F1 (R-PAR-8, R-PAR-16, PARITY_PLAN module 67; migration 0041): a bulk Change stage combined with a
// plan that starts on that stage enrolled a protected-tag audience into the plan, around the AUDIENCE_PROTECTED_PROXY
// refusal bulk enroll gets (no override). Now the bulk runner names its action on every stage change it writes
// (contact_stage_events.bulk_action_id, checked by the history definer), the draft records the tags its audience was
// built from for a stage action too, and the stage automation skips such an event (protected_audience) when that
// audience is protected when it decides. The stage change itself still happens (a bulk stage of a protected list is
// one-to-one work, allowed), and a bulk stage of an unprotected audience still starts the plan (owner decision
// 2026-11-11). Through the real routes as app_user, the real bulk runner and the real stage-automation reconcile.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type CommsWorld, call, commsWorld, ownedContact } from '../comms/testing.js';
import { makeTag, tagContact } from '../lists/testing.js';
import { decisionsOf, enrollmentsOf, playbook, reconcileAsJob, scanPending, setStage } from '../stageAutomation/testing.js';
import { runBulkAction } from './run.js';
import { confirm, draft, itemsOf } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
let agent: TestClient;
let planId = '';

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 1 });
  agent = w.agents[0]!;
  // the agent's own plan (agent scope: can() lets an agent set it on their own plan), started on entering Active
  planId = (await playbook(agent, { scope: 'agent', name: 'Buyer plan' })).id;
  expect((await setStage(agent, planId, 'active')).status).toBe(200);
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const chip = (t: string) => ({ v: 1, all: [{ kind: 'tag', op: 'any', tagIds: [t] }] });
const stageOf = async (id: string) => (await h.su.query<{ stage: string }>('SELECT stage FROM contacts WHERE id = $1', [id])).rows[0]!.stage;

/** Two of the agent's people carrying `tagId`, back in stage `new`, and a saved list of the tag. */
async function audience(tagId: string): Promise<{ ids: string[]; listId: string }> {
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const c = await ownedContact(agent);
    expect((await tagContact(agent, c.id, [tagId])).status).toBe(200);
    ids.push(c.id);
  }
  const list = await call<{ list: { id: string } }>(agent, 'POST', '/smart-lists', { scope: 'personal', name: `L ${randomUUID().slice(0, 6)}`, definition: chip(tagId) });
  expect(list.status).toBe(201);
  return { ids, listId: list.body.list.id };
}

/** Draft, confirm and run a bulk stage change to Active; every item done. */
async function bulkStage(body: Record<string, unknown>, ids: readonly string[]): Promise<string> {
  const d = await draft(agent, { kind: 'stage', stage: 'active', ...body });
  expect(d.status, JSON.stringify(d.body)).toBe(201);
  expect(d.body.action.targetCount).toBe(ids.length);
  expect((await confirm(agent, d.body.action.id)).status).toBe(200);
  await runBulkAction(d.body.action.id, w.deps, w.tenantId);
  expect((await itemsOf(h, d.body.action.id)).map((i) => i.status)).toEqual(ids.map(() => 'done'));
  for (const id of ids) expect(await stageOf(id)).toBe('active');
  return d.body.action.id;
}

/** The worker's backup scan, then the reconcile of each event it finds (stage_automation.scan + .reconcile). */
async function scanAndReconcile(): Promise<void> {
  for (const e of await scanPending(h, w.tenantId)) await reconcileAsJob(h, w.tenantId, e);
}

describe('F1 R-PAR-8 R-PAR-16: a bulk stage change never starts a plan for a protected-tag audience', () => {
  it('R-PAR-8 R-PAR-16: a lexicon-protected tag ("VA buyer"): bulk Start plan of that audience is refused, and a bulk Change stage of it (saved list, tag chip, or people picked from the list) moves the stage but starts no plan: skipped protected_audience, nothing enrolled (before: every person was enrolled into the marketing plan)', async () => {
    const cases: { ids: string[]; shape: Record<string, unknown> }[] = [];
    for (const kind of ['list', 'chip', 'picked'] as const) {
      const tag = await makeTag(agent, `VA buyer ${randomUUID().slice(0, 4)}`);
      expect(tag.protected).toBe(true);
      const a = await audience(tag.id);
      // the control: the same audience as a bulk enrollment is refused outright (R-PAR-8, no override)
      if (kind === 'list') expect((await draft(agent, { kind: 'enroll', selection: { listId: a.listId }, playbookId: planId })).body).toMatchObject({ error: { code: 'AUDIENCE_PROTECTED_PROXY' } });
      const shape = kind === 'list' ? { selection: { listId: a.listId } } : kind === 'chip' ? { selection: { definition: chip(tag.id) } } : { selection: { contactIds: a.ids }, audienceSource: { listId: a.listId } };
      cases.push({ ids: a.ids, shape });
    }
    for (const c of cases) await bulkStage(c.shape, c.ids);
    await scanAndReconcile();
    for (const id of cases.flatMap((c) => c.ids)) {
      expect(await enrollmentsOf(h, id), id).toEqual([]);
      expect((await decisionsOf(h, id)).map((d) => [d.outcome, d.reason, d.playbook_id]), id).toEqual([['skipped', 'protected_audience', planId]]);
    }
  });

  it('R-PAR-16: the same bulk stage of an unprotected audience still starts the plan for each person (owner decision 2026-11-11: bulk stage changes start plans through the scan)', async () => {
    const tag = await makeTag(agent, `Spring ${randomUUID().slice(0, 4)}`);
    expect(tag.protected).toBe(false);
    const a = await audience(tag.id);
    await bulkStage({ selection: { listId: a.listId } }, a.ids);
    await scanAndReconcile();
    for (const id of a.ids) expect((await enrollmentsOf(h, id)).map((e) => [e.playbook_id, e.enrolled_by, e.state]), id).toEqual([[planId, 'stage_change', 'active']]);
  });

  it('R-PAR-8 E189: a tag the Owner protects after the bulk stage ran, before the scan decided, still starts no plan (the protection is read when the plan would start)', async () => {
    const tag = await makeTag(agent, `Autumn ${randomUUID().slice(0, 4)}`);
    expect(tag.protected).toBe(false);
    const a = await audience(tag.id);
    await bulkStage({ selection: { definition: chip(tag.id) } }, a.ids);
    expect((await call(w.owner, 'POST', `/tags/${tag.id}/protect`, { protected: true })).status).toBe(200);
    await scanAndReconcile();
    for (const id of a.ids) {
      expect(await enrollmentsOf(h, id), id).toEqual([]);
      expect((await decisionsOf(h, id)).map((d) => d.reason), id).toEqual(['protected_audience']);
    }
  });
});
