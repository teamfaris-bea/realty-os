// ownership.followup through api/leads (BUILD_PLAN module 11 tests): a Team Lead's reassignment
// cannot write another agent's assistant actions or enrollments, so the cross-user effects (re-home
// open handbacks, invalidate drafts bound to the old period, pause agent enrollments) run in the
// follow-up job as the system actor (R-AST-7, R-OWN-21, ARCHITECTURE §5 step 7).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { type LeadsWorld, call, command, contactState, intake, jobs, leadsWorker, leadsWorld, randomPhone, setPeriodDeadlines, suFixture } from './testing.js';

let h: ApiHarness;
let w: LeadsWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await leadsWorld(h, { agents: 2, teamLead: true });
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe('ownership.followup as the system actor', () => {
  it('R-AST-7 R-OWN-21 E16: a TL reassigning A → B leaves A\'s rows alone in the command; the follow-up re-homes the open handback to B, invalidates A\'s draft bound to the old period and pauses the agent-scoped enrollment', async () => {
    const [a, b] = w.agents as [typeof w.agents[0], typeof w.agents[0]];
    const created = await call<{ contact: { id: string } }>(a, 'POST', '/contacts', { commandId: randomUUID(), displayName: 'Hollis Grant', phones: [randomPhone()] });
    const contactId = created.body.contact.id;
    const st = await contactState(h, contactId);
    const ids = { playbook: randomUUID(), version: randomUUID(), enrollment: randomUUID(), handback: randomUUID(), draft: randomUUID(), samePeriodDraft: randomUUID() };
    // rows with no application path yet (api/assistant, module 13)
    await suFixture(h, [
      { text: "INSERT INTO playbooks (tenant_id, id, kind, scope, owner_user_id, name) VALUES ($1, $2, 'nurture', 'agent', $3, 'Nurture')", values: [w.tenantId, ids.playbook, a.userId] },
      {
        text: "INSERT INTO playbook_versions (tenant_id, id, playbook_id, version_no, steps, content_sha256, status, created_by_user_id) VALUES ($1, $2, $3, 1, '[]', repeat('a', 64), 'approved', $4)",
        values: [w.tenantId, ids.version, ids.playbook, a.userId],
      },
      {
        text: "INSERT INTO playbook_enrollments (tenant_id, id, playbook_id, playbook_version_id, contact_id, enrolled_by, enrolled_by_user_id, state) VALUES ($1, $2, $3, $4, $5, 'user', $6, 'active')",
        values: [w.tenantId, ids.enrollment, ids.playbook, ids.version, contactId, a.userId],
      },
      {
        text: "INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, status, owner_user_id, explanation, payload) VALUES ($1, $2, $3, 'handback', 'internal', 'internal', 'proposed', $4, 'Client replied with a question', '{}')",
        values: [w.tenantId, ids.handback, contactId, a.userId],
      },
      {
        text: "INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, status, owner_user_id, explanation, payload, bound_ownership_seq) VALUES ($1, $2, $3, 'message_draft', 'novel_message', 'requires_approval', 'proposed', $4, 'Suggested follow-up', '{}', $5)",
        values: [w.tenantId, ids.draft, contactId, a.userId, st.ownership_period_seq],
      },
    ]);
    const r = await command(w.teamLead!, contactId, 'reassign', { toUserId: b.userId, note: 'A is out this week' });
    expect(r.status).toBe(200);
    const rows = async () =>
      (await h.su.query<{ id: string; status: string; owner_user_id: string }>('SELECT id, status, owner_user_id FROM assistant_actions WHERE contact_id = $1 ORDER BY id', [contactId])).rows;
    const enrollment = async () => (await h.su.query('SELECT state, pause_reason FROM playbook_enrollments WHERE id = $1', [ids.enrollment])).rows[0];
    // the command itself (Team Lead's RLS) changed none of A's rows; one follow-up job carries them
    expect((await rows()).map((x) => [x.status, x.owner_user_id])).toEqual([
      ['proposed', a.userId],
      ['proposed', a.userId],
    ]);
    expect(await enrollment()).toEqual({ state: 'active', pause_reason: null });
    const f = (await jobs(h, w.tenantId, 'ownership.followup')).filter((j) => j.payload.contactId === contactId && j.status === 'pending');
    expect(f).toHaveLength(1);
    expect(JSON.stringify(f[0]!.payload)).not.toMatch(/Hollis|Grant|out this week/); // ids and codes only (R-TEN-7)
    await leadsWorker(h).drain();
    const after = new Map((await rows()).map((x) => [x.id, x]));
    expect(after.get(ids.handback)).toMatchObject({ status: 'proposed', owner_user_id: b.userId });
    expect(after.get(ids.draft)).toMatchObject({ status: 'invalidated' });
    expect(await enrollment()).toEqual({ state: 'paused', pause_reason: 'owner_change' });
    // the follow-up's command is idempotent: a second run changes nothing
    await suFixture(h, [{ text: "INSERT INTO jobs (tenant_id, queue, kind, payload, run_at) VALUES ($1, 'realtime', 'ownership.followup', $2::jsonb, now())", values: [w.tenantId, JSON.stringify(f[0]!.payload)] }]);
    await leadsWorker(h).drain();
    expect(new Map((await rows()).map((x) => [x.id, x]))).toEqual(after);
  });

  it('R-AST-7: in-period events (a first-touch breach) do not invalidate a draft bound to the current period', async () => {
    // a lead that B owns through an accept (an SLA period), with a draft bound to that period
    const r = await intake(h, w);
    const st = await contactState(h, r.contactId);
    const owner = w.agents.find((x) => x.userId === st.offered_to_user_id)!;
    await command(owner, r.contactId, 'accept', { offerId: st.offer_id });
    const owned = await contactState(h, r.contactId);
    const draft = randomUUID();
    await suFixture(h, [
      {
        text: "INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, status, owner_user_id, explanation, payload, bound_ownership_seq) VALUES ($1, $2, $3, 'message_draft', 'novel_message', 'requires_approval', 'proposed', $4, 'Suggested follow-up', '{}', $5)",
        values: [w.tenantId, draft, r.contactId, owner.userId, owned.ownership_period_seq],
      },
    ]);
    await setPeriodDeadlines(h, r.contactId, -1000, 10 * 60_000);
    await leadsWorker(h).drain();
    expect(Number((await contactState(h, r.contactId)).ownership_seq)).toBeGreaterThan(Number(owned.ownership_seq));
    expect((await h.su.query('SELECT status FROM assistant_actions WHERE id = $1', [draft])).rows[0]).toEqual({ status: 'proposed' });
  });
});
