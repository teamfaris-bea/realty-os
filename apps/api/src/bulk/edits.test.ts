// Parity module 63: the edit kinds of bulk (tag, untag, stage, assign, enroll), run as the creator
// (R-PAR-33, R-PAR-34, R-PAR-35, R-PAR-14 per item, E183, E187).
import { randomUUID } from 'node:crypto';
import { contentSha256 } from '@realty/core/assistant';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type CommsWorld, call, commsWorld, ownedContact } from '../comms/testing.js';
import { command, intake, suFixture } from '../leads/testing.js';
import { runBulkAction } from './run.js';
import { actionRow, confirm, draft, itemsOf } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 3, teamLead: true, others: ['tc', 'admin'] });
});
afterAll(async () => {
  await h?.close();
});

const run = (id: string) => runBulkAction(id, w.deps, w.tenantId);

/** A tag in the catalog, created through RLS as `by` (module 60's API is lane L2; the row and policy are P0's). */
async function tag(by: TestClient, o: { protectedProxy?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  await withTenantTx(by.actor(), (tx) => sql`
    INSERT INTO tags (tenant_id, id, name, created_by_kind, created_by_user_id, protected_proxy)
    VALUES (app.tenant_id(), ${id}, ${`Tag ${id.slice(0, 6)}`}, 'user', app.user_id(), ${o.protectedProxy === true})`.execute(tx), { db: h.database });
  return id;
}
const tagsOf = async (contactId: string) => (await h.su.query('SELECT tag_id, added_by_kind, added_by_user_id FROM contact_tags WHERE contact_id = $1', [contactId])).rows;

describe('R-PAR-35 tag, untag and stage, as the creator', () => {
  it('R-PAR-35 bulk tag writes provenance "bulk" by the creator; already-tagged people are counted, not re-tagged; untag removes', async () => {
    const agent = w.agents[0]!;
    const t = await tag(agent);
    const cs = [await ownedContact(agent), await ownedContact(agent)];
    const d = await draft(agent, { kind: 'tag', selection: { contactIds: cs.map((c) => c.id) }, tagId: t });
    expect(d.body.action).toMatchObject({ selected: 2, targetCount: 2, preflight: {} });
    await confirm(agent, d.body.action.id);
    expect(await run(d.body.action.id)).toEqual({ kind: 'finished', status: 'completed' });
    for (const c of cs) expect(await tagsOf(c.id)).toEqual([{ tag_id: t, added_by_kind: 'bulk', added_by_user_id: agent.userId }]);
    const again = await draft(agent, { kind: 'tag', selection: { contactIds: cs.map((c) => c.id) }, tagId: t });
    expect(again.body.action.preflight).toEqual({ ALREADY_TAGGED: 2 });
    const un = await draft(agent, { kind: 'untag', selection: { contactIds: [cs[0]!.id] }, tagId: t });
    await confirm(agent, un.body.action.id);
    await run(un.body.action.id);
    expect(await tagsOf(cs[0]!.id)).toEqual([]);
    expect((await h.su.query("SELECT title FROM notifications WHERE kind = 'bulk_finished' AND subject_id = $1", [d.body.action.id])).rows[0].title).toBe('Tagged 2 of 2');
  });

  it('R-PAR-8 a protected tag is never applied or removed in bulk (TAG_PROTECTED)', async () => {
    const t = await tag(w.owner, { protectedProxy: true });
    const c = await ownedContact(w.agents[0]!);
    expect((await draft(w.owner, { kind: 'tag', selection: { contactIds: [c.id] }, tagId: t })).body).toMatchObject({ error: { code: 'TAG_PROTECTED' } });
    expect((await draft(w.owner, { kind: 'untag', selection: { contactIds: [c.id] }, tagId: t })).body).toMatchObject({ error: { code: 'TAG_PROTECTED' } });
  });

  it('R-PAR-14 R-PAR-35 bulk stage by an agent skips an untouched routed lead (STAGE_NEEDS_CONTACT) and moves the rest; a TL may move it', async () => {
    const routed = await intake(h, w);
    const st = (await h.su.query('SELECT offered_to_user_id, offer_id FROM contacts WHERE id = $1', [routed.contactId])).rows[0];
    const agent = w.agents.find((a) => a.userId === st.offered_to_user_id)!;
    expect((await command(agent, routed.contactId, 'accept', { offerId: st.offer_id })).status).toBe(200); // owned, first-touch SLA running
    const mine = await ownedContact(agent);
    const d = await draft(agent, { kind: 'stage', selection: { contactIds: [mine.id, routed.contactId] }, stage: 'nurture' });
    expect(d.body.action).toMatchObject({ targetCount: 1, preflight: { STAGE_NEEDS_CONTACT: 1 } });
    await confirm(agent, d.body.action.id);
    await run(d.body.action.id);
    expect((await h.su.query('SELECT stage FROM contacts WHERE id = $1', [mine.id])).rows[0].stage).toBe('nurture');
    expect((await h.su.query('SELECT stage FROM contacts WHERE id = $1', [routed.contactId])).rows[0].stage).toBe('new');
    // R-PAR-15: the definer trigger wrote the history, attributed to the creator
    const ev = await h.su.query('SELECT to_stage, actor_user_id FROM contact_stage_events WHERE contact_id = $1 ORDER BY occurred_at DESC LIMIT 1', [mine.id]);
    expect(ev.rows[0]).toEqual({ to_stage: 'nurture', actor_user_id: agent.userId });
    // the Team Lead of the agent's team may move the untouched lead
    const d2 = await draft(w.teamLead!, { kind: 'stage', selection: { contactIds: [routed.contactId] }, stage: 'nurture' });
    expect(d2.body.action.targetCount).toBe(1);
    await confirm(w.teamLead!, d2.body.action.id);
    await run(d2.body.action.id);
    expect((await h.su.query('SELECT stage FROM contacts WHERE id = $1', [routed.contactId])).rows[0].stage).toBe('nurture');
    expect((await draft(agent, { kind: 'stage', selection: { contactIds: [mine.id] }, stage: 'bogus' })).body).toMatchObject({ error: { code: 'BULK_PARAMS_INVALID' } });
  });
});

describe('R-PAR-35 assign through the ownership engine', () => {
  it('R-PAR-35 an agent cannot assign; a TL assigns only to their team; one command per person with a derived id; one summary per agent', async () => {
    const [a0, a1] = [w.agents[0]!, w.agents[1]!];
    const cs = [await ownedContact(a0), await ownedContact(a0), await ownedContact(a0)];
    expect((await draft(a0, { kind: 'assign', selection: { contactIds: cs.map((c) => c.id) }, toUserId: a1.userId })).status).toBe(404);
    const d = await draft(w.teamLead!, { kind: 'assign', selection: { contactIds: cs.map((c) => c.id) }, toUserId: a1.userId });
    expect(d.body.action).toMatchObject({ targetCount: 3 });
    await confirm(w.teamLead!, d.body.action.id);
    expect(await run(d.body.action.id)).toEqual({ kind: 'finished', status: 'completed' });
    for (const c of cs) expect((await h.su.query('SELECT owner_user_id FROM contacts WHERE id = $1', [c.id])).rows[0].owner_user_id).toBe(a1.userId);
    // no SLA from a bulk assign; one summary notice each, no per-lead notices
    for (const c of cs) expect((await h.su.query('SELECT first_touch_due_at FROM contacts WHERE id = $1', [c.id])).rows[0].first_touch_due_at).toBeNull();
    const per = await h.su.query("SELECT count(*)::int AS n FROM notifications WHERE kind IN ('reassigned_to_you','reassigned_away') AND subject_type = 'contact' AND subject_id = ANY ($1::uuid[])", [cs.map((c) => c.id)]);
    expect(per.rows[0].n).toBe(0);
    const sums = (await h.su.query("SELECT user_id, kind, title FROM notifications WHERE subject_id = $1 AND kind <> 'bulk_finished' ORDER BY kind", [d.body.action.id])).rows;
    expect(sums).toEqual([
      { user_id: a0.userId, kind: 'reassigned_away', title: '3 of your leads were reassigned' },
      { user_id: a1.userId, kind: 'reassigned_to_you', title: '3 leads were assigned to you' },
    ]);
    // the ledger holds exactly one assign per person, under the derived command id
    const ev = await h.su.query("SELECT count(*)::int AS n FROM lead_ownership_events WHERE contact_id = ANY ($1::uuid[]) AND type IN ('assigned','reassigned')", [cs.map((c) => c.id)]);
    expect(ev.rows[0].n).toBe(3);
  });

  it('R-PAR-35 whoever runs a bulk assign gets no summary of it, only the results: not when they take the people themself, not for their own people that move (the confirm sheet says so); every other owner gets one', async () => {
    const [a0, a1] = [w.agents[0]!, w.agents[1]!];
    const tl = w.teamLead!;
    const notices = async (actionId: string) => (await h.su.query('SELECT user_id, kind, title FROM notifications WHERE subject_id = $1 ORDER BY kind, user_id', [actionId])).rows;
    // a Team Lead takes two of a0's people themself: a0 hears once, the Team Lead only gets the results
    const two = [await ownedContact(a0), await ownedContact(a0)];
    const self = await draft(tl, { kind: 'assign', selection: { contactIds: two.map((c) => c.id) }, toUserId: tl.userId });
    expect(self.body.action).toMatchObject({ targetCount: 2 });
    await confirm(tl, self.body.action.id);
    expect(await run(self.body.action.id)).toEqual({ kind: 'finished', status: 'completed' });
    for (const c of two) expect((await h.su.query('SELECT owner_user_id FROM contacts WHERE id = $1', [c.id])).rows[0].owner_user_id).toBe(tl.userId);
    expect(await notices(self.body.action.id)).toEqual([
      { user_id: tl.userId, kind: 'bulk_finished', title: 'Assigned 2 of 2' },
      { user_id: a0.userId, kind: 'reassigned_away', title: '2 of your leads were reassigned' },
    ]);
    // the Owner moves one of their own people and one of a0's to a1: a1 and a0 hear once each, the Owner only gets the results
    const ownerLead = await ownedContact(w.owner);
    const a0Lead = await ownedContact(a0);
    const mixed = await draft(w.owner, { kind: 'assign', selection: { contactIds: [ownerLead.id, a0Lead.id] }, toUserId: a1.userId });
    expect(mixed.body.action).toMatchObject({ targetCount: 2 });
    await confirm(w.owner, mixed.body.action.id);
    expect(await run(mixed.body.action.id)).toEqual({ kind: 'finished', status: 'completed' });
    expect(await notices(mixed.body.action.id)).toEqual([
      { user_id: w.owner.userId, kind: 'bulk_finished', title: 'Assigned 2 of 2' },
      { user_id: a0.userId, kind: 'reassigned_away', title: '1 of your leads was reassigned' },
      { user_id: a1.userId, kind: 'reassigned_to_you', title: '2 leads were assigned to you' },
    ]);
  });

  it('R-PAR-35 E187 the engine decides per item: an ineligible target (a TC) is refused, a lead outside the TL\'s team is skipped', async () => {
    const tc = w.others[0]!;
    const c = await ownedContact(w.agents[0]!);
    expect((await draft(w.owner, { kind: 'assign', selection: { contactIds: [c.id] }, toUserId: tc.userId })).body.action.preflight).toEqual({ NOT_PERMITTED: 1 });
    // an Owner's lead is outside the TL's team
    const ownerLead = await ownedContact(w.owner);
    const d = await draft(w.teamLead!, { kind: 'assign', selection: { contactIds: [ownerLead.id] }, toUserId: w.agents[1]!.userId });
    expect(d.body.action.targetCount + Object.values(d.body.action.preflight).reduce((x, y) => x + y, 0)).toBe(1);
    expect(d.body.action.targetCount).toBe(0);
  });
});

describe('R-PAR-35 enroll', () => {
  async function approvedPlaybook(scope: 'team' | 'agent', ownerUserId: string | null): Promise<string> {
    const playbookId = randomUUID();
    const versionId = randomUUID();
    const steps = [{ stepKey: 's1', delayMinutes: 60, channel: 'email', intent: 'nurture_check_in', subject: 'Hi', body: 'Checking in' }];
    const sha = contentSha256(steps as never, {} as never);
    await h.su.query("INSERT INTO playbooks (tenant_id, id, kind, scope, owner_user_id, name) VALUES ($1,$2,'nurture',$3,$4,'Bulk nurture')", [w.tenantId, playbookId, scope, ownerUserId]);
    await h.su.query("INSERT INTO playbook_versions (tenant_id, id, playbook_id, version_no, steps, tone, content_sha256, status, created_by_user_id) VALUES ($1,$2,$3,1,$4,'{}',$5,'draft',$6)", [w.tenantId, versionId, playbookId, JSON.stringify(steps), sha, w.owner.userId]);
    await suFixture(h, [
      { text: "INSERT INTO playbook_approvals (tenant_id, id, playbook_version_id, decision, decided_by_user_id, decided_by_role, content_sha256, attestation, decided_at) VALUES ($1,$2,$3,'approve',$4,'owner',$5,'I approve these messages',now())", values: [w.tenantId, randomUUID(), versionId, w.owner.userId, sha] },
      { text: "UPDATE playbook_versions SET status = 'approved' WHERE id = $1", values: [versionId] },
    ]);
    return playbookId;
  }

  it('R-PAR-35 enroll uses the approved version, never a second live enrollment, enrolled_by bulk with the creator', async () => {
    const agent = w.agents[0]!;
    const pb = await approvedPlaybook('team', null);
    const cs = [await ownedContact(agent), await ownedContact(agent)];
    const d = await draft(agent, { kind: 'enroll', selection: { contactIds: cs.map((c) => c.id) }, playbookId: pb });
    expect(d.body.action.targetCount).toBe(2);
    await confirm(agent, d.body.action.id);
    await run(d.body.action.id);
    const e = await h.su.query("SELECT enrolled_by, enrolled_by_user_id, state FROM playbook_enrollments WHERE contact_id = ANY ($1::uuid[])", [cs.map((c) => c.id)]);
    expect(e.rows).toEqual([{ enrolled_by: 'bulk', enrolled_by_user_id: agent.userId, state: 'active' }, { enrolled_by: 'bulk', enrolled_by_user_id: agent.userId, state: 'active' }]);
    const again = await draft(agent, { kind: 'enroll', selection: { contactIds: cs.map((c) => c.id) }, playbookId: pb });
    expect(again.body.action.preflight).toEqual({ ALREADY_ENROLLED: 2 });
    // an unapproved playbook is refused as a whole
    const raw = randomUUID();
    await h.su.query("INSERT INTO playbooks (tenant_id, id, kind, scope, name) VALUES ($1,$2,'nurture','team','Draft only')", [w.tenantId, raw]);
    expect((await draft(agent, { kind: 'enroll', selection: { contactIds: [cs[0]!.id] }, playbookId: raw })).body).toMatchObject({ error: { code: 'PLAYBOOK_NOT_APPROVED' } });
  });
});

describe('R-PAR-34 the run re-decides every item as the creator', () => {
  it('R-PAR-34 E183 a person reassigned away after confirm is skipped NOT_VISIBLE; the new owner\'s people are not touched', async () => {
    const [a0, a1] = [w.agents[0]!, w.agents[1]!];
    const t = await tag(a0);
    const keep = await ownedContact(a0);
    const moved = await ownedContact(a0);
    const d = await draft(a0, { kind: 'tag', selection: { contactIds: [keep.id, moved.id] }, tagId: t });
    await confirm(a0, d.body.action.id);
    await call(w.owner, 'POST', `/leads/${moved.id}/reassign`, { commandId: randomUUID(), toUserId: a1.userId, reason: 'MANUAL' });
    expect((await h.su.query('SELECT owner_user_id FROM contacts WHERE id = $1', [moved.id])).rows[0].owner_user_id).toBe(a1.userId);
    await run(d.body.action.id);
    const items = await itemsOf(h, d.body.action.id);
    expect(items.find((i) => i.contact_id === moved.id)).toMatchObject({ status: 'skipped', reason_code: 'NOT_VISIBLE' });
    expect(items.find((i) => i.contact_id === keep.id)).toMatchObject({ status: 'done' });
    expect(await tagsOf(moved.id)).toEqual([]);
  });

  it('R-PAR-34 a suspended creator stops the run (failed CREATOR_INACTIVE); nothing more is done', async () => {
    const a2 = w.agents[2]!;
    const t = await tag(a2);
    const c = await ownedContact(a2);
    const d = await draft(a2, { kind: 'tag', selection: { contactIds: [c.id] }, tagId: t });
    await confirm(a2, d.body.action.id);
    await suFixture(h, [{ text: "UPDATE memberships SET status = 'suspended' WHERE user_id = $1", values: [a2.userId] }]);
    expect(await run(d.body.action.id)).toEqual({ kind: 'finished', status: 'failed' });
    expect(await actionRow(h, d.body.action.id)).toMatchObject({ status: 'failed', failure_code: 'CREATOR_INACTIVE' });
    expect(await itemsOf(h, d.body.action.id)).toMatchObject([{ status: 'skipped', reason_code: 'CREATOR_INACTIVE' }]);
    expect(await tagsOf(c.id)).toEqual([]);
    await suFixture(h, [{ text: "UPDATE memberships SET status = 'active' WHERE user_id = $1", values: [a2.userId] }]);
  });

  it('R-PAR-33 only the creator, in the same role, confirms; a TC runs nothing', async () => {
    const agent = w.agents[0]!;
    const t = await tag(agent);
    const c = await ownedContact(agent);
    const d = await draft(agent, { kind: 'tag', selection: { contactIds: [c.id] }, tagId: t });
    expect((await confirm(w.owner, d.body.action.id)).status).toBe(404);
    expect((await confirm(w.agents[1]!, d.body.action.id)).status).toBe(404);
    await suFixture(h, [{ text: "UPDATE memberships SET role = 'isa' WHERE user_id = $1", values: [agent.userId] }]);
    const isaAgent = await h.login(agent.email!);
    expect((await confirm(isaAgent, d.body.action.id)).body).toMatchObject({ error: { code: 'BULK_CONFIRM_ROLE_CHANGED' } });
    await suFixture(h, [{ text: "UPDATE memberships SET role = 'agent' WHERE user_id = $1", values: [agent.userId] }]);
    expect((await draft(w.others[0]!, { kind: 'tag', selection: { contactIds: [c.id] }, tagId: t })).status).toBe(404);
  });
});
