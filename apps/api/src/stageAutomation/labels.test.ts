// A stage label is display only (R-STG-1, E771). Renaming the stages (a team's own labels, or the new default
// labels) changes no trigger, no enrollment and no permission: plans, the stage rule and the routes read the eight
// keys and nothing else. Through the real server as app_user; the superuser pool only reads back. Fakes only.
import { DEFAULT_STAGE_LABELS, STAGES } from '@realty/core/parity/people';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type CommsWorld, call, commsWorld } from '../comms/testing.js';
import { command, contactState, intake } from '../leads/testing.js';
import { changeStage, decisionsOf, enrollmentsOf, newContact, playbook, setStage } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
let agent: TestClient;
let agent2: TestClient;
let tl: TestClient;
const pb = {} as Record<'longTerm' | 'buyer', { id: string; versionId: string }>;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 2, teamLead: true });
  [agent, agent2] = w.agents as [TestClient, TestClient];
  tl = w.teamLead!;
  pb.longTerm = await playbook(w.owner, { scope: 'team', name: 'Long-term plan' });
  pb.buyer = await playbook(w.owner, { scope: 'team', name: 'Buyer plan' });
  expect((await setStage(w.owner, pb.longTerm.id, 'nurture')).status).toBe(200);
  expect((await setStage(w.owner, pb.buyer.id, 'active')).status).toBe(200);
}, 300_000);
afterAll(async () => {
  await h?.close();
});

type Details = { details: { stage: { stage: string; label: string; locked: string[] }; stageGuide: { key: string; label: string }[] } };
const details = (by: TestClient, id: string) => call<Details>(by, 'GET', `/contacts/${id}/details`);
const preview = (by: TestClient, id: string, to: string) => call<{ allowed: boolean; starts: { plan: string } | null }>(by, 'GET', `/contacts/${id}/stage/preview?to=${to}`);
const counts = async () => (await h.su.query<{ e: number; d: number; j: number; s: number }>(
  `SELECT (SELECT count(*)::int FROM playbook_enrollments WHERE tenant_id = $1) AS e, (SELECT count(*)::int FROM stage_automation_decisions WHERE tenant_id = $1) AS d,
          (SELECT count(*)::int FROM jobs WHERE tenant_id = $1) AS j, (SELECT count(*)::int FROM contact_stage_events WHERE tenant_id = $1) AS s`, [w.tenantId])).rows[0]!;

/** A routed lead its agent accepted and has not reached yet: the stage rule locks the later stages for them (R-PAR-14). */
async function routedUntouched(): Promise<{ id: string; owner: TestClient }> {
  const r = await intake(h, w);
  const st = await contactState(h, r.contactId);
  const owner = w.agents.find((a) => a.userId === st.offered_to_user_id)!;
  expect((await command(owner, r.contactId, 'accept', { offerId: st.offer_id, expectedSeq: Number(st.ownership_seq) })).status).toBe(200);
  return { id: r.contactId, owner };
}

/** What the same stage KEYS do for the same people: plans started, what is locked, who is let through. */
async function behaviour() {
  const toNurture = await newContact(agent);
  const toActive = await newContact(agent);
  const lead = await routedUntouched();
  const out = {
    previewNurture: (await preview(agent, toNurture, 'nurture')).body.starts?.plan ?? null,
    nurture: (await changeStage(agent, toNurture, 'nurture')).body.automation,
    active: (await changeStage(agent, toActive, 'active')).body.automation,
    connected: (await changeStage(agent, toActive, 'connected')).body.automation,
    decisions: [...(await decisionsOf(h, toNurture)), ...(await decisionsOf(h, toActive))].map((d) => [d.outcome, d.playbook_id]),
    enrolled: [...(await enrollmentsOf(h, toNurture)), ...(await enrollmentsOf(h, toActive))].map((e) => [e.playbook_id, e.enrolled_by, e.state]),
    storedStage: (await h.su.query<{ stage: string }>('SELECT stage FROM contacts WHERE id = $1', [toNurture])).rows[0]!.stage,
    eventKeys: (await h.su.query<{ t: string }>('SELECT to_stage AS t FROM contact_stage_events WHERE contact_id = $1 ORDER BY occurred_at', [toActive])).rows.map((x) => x.t),
    // the stage rule: the same keys locked for the agent, none for the Team Lead
    lockedForAgent: (await details(lead.owner, lead.id)).body.details.stage.locked,
    lockedForLead: (await details(tl, lead.id)).body.details.stage.locked,
    agentBlocked: (await changeStage(lead.owner, lead.id, 'nurture')).code,
    previewLocked: (await preview(lead.owner, lead.id, 'nurture')).body.allowed,
    // who may change the stage of the agent's person, and who may rename stages or point a plan at one
    strangerStage: (await changeStage(agent2, toNurture, 'active')).status,
    leadStage: (await preview(tl, toNurture, 'active')).status,
    agentRenames: (await call(agent, 'PUT', '/stage-labels', { labels: { nurture: 'Mine' } })).status,
    agentSetsTeamPlan: (await setStage(agent, pb.buyer.id, 'closed')).status,
    planStage: (await call<{ playbook: { autoEnrollStage: string } }>(w.owner, 'GET', `/playbooks/${pb.longTerm.id}/auto-enroll-stage`)).body.playbook.autoEnrollStage,
  };
  return out;
}

describe('a stage label is display only (R-STG-1)', () => {
  it('R-STG-1 E771 renaming the stages (even to each other\'s names) changes no trigger, no enrollment and no permission: the same key starts the same plan before and after', async () => {
    const before = await behaviour();
    expect(before).toMatchObject({
      previewNurture: 'Long-term plan', nurture: { started: 'Long-term plan' }, active: { started: 'Buyer plan' }, connected: null,
      storedStage: 'nurture', eventKeys: ['active', 'connected'],
      lockedForAgent: ['connected', 'nurture', 'active', 'under_contract', 'closed', 'lost'], lockedForLead: [], agentBlocked: 'STAGE_NEEDS_CONTACT', previewLocked: false,
      strangerStage: 404, leadStage: 200, agentRenames: 404, agentSetsTeamPlan: 404, planStage: 'nurture',
    });

    // the Owner renames the stages, deliberately crossing the names: "nurture" is now called what "active" is called by default
    const at = await counts();
    const labels = { nurture: DEFAULT_STAGE_LABELS.active, active: DEFAULT_STAGE_LABELS.lost, lost: DEFAULT_STAGE_LABELS.new, connected: 'Spoke once' };
    expect((await call(w.owner, 'PUT', '/stage-labels', { labels })).status).toBe(200);
    // renaming is itself no trigger: nobody was enrolled, decided, moved or queued by it
    expect(await counts()).toEqual(at);

    const after = await behaviour();
    expect(after).toEqual(before);

    // what did change is what people read: the label, and only the label
    const c = await newContact(agent);
    const d = (await details(agent, c)).body.details;
    expect(d.stageGuide.map((s) => s.key)).toEqual([...STAGES]);
    expect(d.stageGuide.find((s) => s.key === 'nurture')!.label).toBe('Active client');
    const moved = await call<{ stage: { stage: string; label: string } }>(agent, 'POST', `/contacts/${c}/stage`, { stage: 'nurture' });
    expect(moved.body.stage).toMatchObject({ stage: 'nurture', label: 'Active client' });
    expect((await call<{ automation: unknown }>(agent, 'POST', `/contacts/${c}/stage`, { stage: 'new' })).status).toBe(200);
    // a label is never accepted where a key is expected, by a route or by a plan's setting
    for (const label of ['Active client', 'Long-term follow-up', 'Spoke once']) {
      expect((await call(agent, 'POST', `/contacts/${c}/stage`, { stage: label })).status, label).toBe(422);
      expect((await call(agent, 'GET', `/contacts/${c}/stage/preview?to=${encodeURIComponent(label)}`)).status, label).toBe(422);
      expect((await setStage(w.owner, pb.buyer.id, label)).status, label).toBe(422);
    }
    expect((await call(w.owner, 'PUT', '/stage-labels', { labels: {} })).status).toBe(200);
  });

  it('R-STG-1 the new default labels are words only: with no team labels the keys stored, decided and enrolled on are the same eight', async () => {
    const c = await newContact(agent);
    const d = (await details(agent, c)).body.details;
    expect(d.stage).toMatchObject({ stage: 'new', label: 'New lead' });
    expect(d.stageGuide.map((s) => [s.key, s.label])).toEqual(STAGES.map((k) => [k, DEFAULT_STAGE_LABELS[k]]));
    expect((await changeStage(agent, c, 'nurture')).body.automation).toEqual({ started: 'Long-term plan' });
    const row = (await h.su.query<{ stage: string }>('SELECT stage FROM contacts WHERE id = $1', [c])).rows[0]!;
    const dec = (await h.su.query<{ to_stage: string }>('SELECT to_stage FROM stage_automation_decisions WHERE contact_id = $1', [c])).rows[0]!;
    expect([row.stage, dec.to_stage]).toEqual(['nurture', 'nurture']);
    // no default label is itself a key, so no word shown to a person can be mistaken for one by the API
    for (const k of STAGES) expect((STAGES as readonly string[]).includes(DEFAULT_STAGE_LABELS[k])).toBe(false);
  });
});
