// B9: a direct enrollment (POST /contacts/:id/enrollments) of a person who cannot be reached (R-PAR-16, R-PAR-12, D1).
//
// A stage entry never starts a plan for a person no channel of that plan can reach (stageAutomation/decide.ts
// cannot_be_reached; bulk enroll skips them too). The direct route used to accept them: the sends stayed blocked
// at send time, but the plan showed as live although it could never send. It now applies the same rule through the
// same function (stageAutomation reachableForVersion: core canContact on the gate input dispatch builds, opt-outs
// only, the removed phones' STOPs included) and refuses with the stage-automation skip reason. A merged-away record is
// refused too (F2, the skip reason person_removed), and no other path enrolls one. Real Postgres, the real server, fake
// providers only.
import { randomUUID } from 'node:crypto';
import { contentSha256 } from '@realty/core/assistant';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type CommsWorld, call, commsWorld, freshReauth, inboundSms, randomEmail, randomPhone } from '../comms/testing.js';
import { command, leadsWorld } from '../leads/testing.js';
import { decideStageEntry } from '../stageAutomation/decide.js';
import { changeStage, decisionsOf, enrollmentsOf, newContact, setStage } from '../stageAutomation/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { enrollOnDealClosed } from './enrollments.js';
import { depsOf, runJobs, smsStep, stepNow } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
let agent: TestClient;
let agent2: TestClient;
let admin: TestClient;
const plan = {} as Record<'text' | 'email' | 'both', { id: string; name: string; stage: string }>;

const textStep = (key: string) => smsStep({ key, category: 'nurture_step', intent: 'check_in', purpose: 'marketing', template: 'Hi {{first_name}}, checking in on your plans this year.', slots: ['first_name'] });
const emailStep = (key: string) => ({ stepKey: key, channel: 'email', delay: { anchor: 'enrollment', offsetSeconds: 0 }, purpose: 'marketing', category: 'nurture_step', intent: 'check_in', subject: 'Checking in', template: 'Hi {{first_name}},\n\nJust checking in on your plans this year.', personalization: 'none', slots: ['first_name'], maxLength: 2000, stopIf: [] });

/** A team plan the Owner approves, started by a stage entry into `stage` too (one rule, two paths). */
async function teamPlan(name: string, steps: Record<string, unknown>[], stage: string): Promise<{ id: string; name: string; stage: string }> {
  const c = await call<{ playbook: { id: string; versions: { id: string; contentSha256: string }[] } }>(w.owner, 'POST', '/playbooks', { kind: 'nurture', scope: 'team', name, steps });
  if (c.status !== 201) throw new Error(`create playbook: ${c.status} ${JSON.stringify(c.body)}`);
  const v = c.body.playbook.versions[0]!;
  const a = await call(w.owner, 'POST', `/playbook-versions/${v.id}/approve`, { attestation: 'I reviewed these messages and approve them.', contentSha256: v.contentSha256 });
  if (a.status !== 200) throw new Error(`approve: ${a.status} ${JSON.stringify(a.body)}`);
  const s = await setStage(w.owner, c.body.playbook.id, stage);
  if (s.status !== 200) throw new Error(`stage: ${s.status} ${JSON.stringify(s.body)}`);
  return { id: c.body.playbook.id, name, stage };
}

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 2, rule: false, others: ['admin'] });
  agent = w.agents[0]!;
  agent2 = w.agents[1]!;
  admin = w.others[0]!;
  plan.text = await teamPlan('Text check-in', [textStep('text_check_in')], 'active');
  plan.email = await teamPlan('Email check-in', [emailStep('email_check_in')], 'nurture');
  plan.both = await teamPlan('Text and email check-in', [textStep('text_check_in'), emailStep('email_check_in')], 'connected');
}, 240_000);
afterAll(async () => {
  await h?.close();
});

const SITUATIONS = ['fresh', 'stop', 'removedStop', 'revoked', 'dnc', 'emailRevoked', 'emailOnly'] as const;
type Situation = (typeof SITUATIONS)[number];

const pointIdOf = async (contactId: string, address: string) => (await h.su.query<{ id: string }>('SELECT id FROM contact_points WHERE contact_id = $1 AND address = $2', [contactId, address])).rows[0]!.id;

/** A person of the agent's in one opt-out situation, arranged through the real paths (inbound STOP, the point and consent routes, the one-tap do-not-contact). */
async function person(s: Situation): Promise<string> {
  const phone = randomPhone();
  const email = randomEmail();
  switch (s) {
    case 'fresh':
      return newContact(agent, { phones: [phone], emails: [email] });
    case 'stop': {
      // texted STOP; the email is still open
      const id = await newContact(agent, { phones: [phone], emails: [email] });
      expect((await inboundSms(h, phone, w.mainNumber, 'STOP')).statusCode).toBeLessThan(300);
      return id;
    }
    case 'removedStop': {
      // R-PAR-12: the old phone texted STOP and the agent removed it; the new phone has no STOP of its own; no email
      const old = randomPhone();
      const id = await newContact(agent, { phones: [old, phone], emails: [] });
      expect((await inboundSms(h, old, w.mainNumber, 'STOP')).statusCode).toBeLessThan(300);
      expect((await call(agent, 'POST', `/contacts/${id}/points/${await pointIdOf(id, old)}/remove`, { reason: 'old' })).status).toBe(200);
      return id;
    }
    case 'revoked': {
      // the agent recorded "do not text me" on the only phone; no email
      const id = await newContact(agent, { phones: [phone], emails: [] });
      expect((await call(agent, 'POST', `/contacts/${id}/consent`, { kind: 'revoke', pointId: await pointIdOf(id, phone), channel: 'sms', purpose: 'all', evidence: { note: 'asked us not to text' } })).status).toBe(200);
      return id;
    }
    case 'dnc': {
      const id = await newContact(agent, { phones: [phone], emails: [email] });
      expect((await call(agent, 'POST', `/contacts/${id}/do-not-contact`, { reason: 'asked_on_call' })).status).toBe(200);
      return id;
    }
    case 'emailRevoked': {
      // the email opted out; the phone is still open
      const id = await newContact(agent, { phones: [phone], emails: [email] });
      expect((await call(agent, 'POST', `/contacts/${id}/consent`, { kind: 'revoke', pointId: await pointIdOf(id, email), channel: 'email', purpose: 'all', evidence: { note: 'unsubscribed' } })).status).toBe(200);
      return id;
    }
    case 'emailOnly':
      return newContact(agent, { phones: [], emails: [email] });
  }
}

/** Who each plan can reach (decide.ts: some channel the plan messages on has an address no opt-out blocks). */
const REACHABLE: Record<Situation, Record<'text' | 'email' | 'both', boolean>> = {
  fresh: { text: true, email: true, both: true },
  stop: { text: false, email: true, both: true },
  removedStop: { text: false, email: false, both: false },
  revoked: { text: false, email: false, both: false },
  dnc: { text: false, email: false, both: false },
  emailRevoked: { text: true, email: false, both: true },
  emailOnly: { text: false, email: true, both: true },
};

type Enrolled = { enrollment: { id: string; state: string } };
const enroll = (contactId: string, playbookId: string, extra: Record<string, unknown> = {}) => call<Enrolled & { error: { code: string; details?: Record<string, unknown> } }>(agent, 'POST', `/contacts/${contactId}/enrollments`, { playbookId, ...extra });
const liveOf = async (contactId: string) => (await enrollmentsOf(h, contactId)).filter((e) => e.state === 'active' || e.state === 'paused');

describe('B9 R-PAR-16 D1: a direct enrollment of a person who cannot be reached', () => {
  it('B9 D1 R-PAR-12: a person opted out on every channel the plan uses is refused with the stage-automation reason (409 CANNOT_BE_REACHED, cannot_be_reached): a STOP, a STOP on a phone the agent then removed, an agent-recorded revoke, the person-level do-not-contact, an email opt-out for an email plan; no enrollment row, nothing queued, never a 500', async () => {
    const cases: [Situation, 'text' | 'email' | 'both'][] = [['stop', 'text'], ['removedStop', 'text'], ['removedStop', 'both'], ['revoked', 'text'], ['dnc', 'text'], ['dnc', 'email'], ['dnc', 'both'], ['emailRevoked', 'email']];
    const sent = h.providers.telephony.sms.length;
    for (const [s, p] of cases) {
      const id = await person(s);
      const r = await enroll(id, plan[p].id);
      expect({ s, p, status: r.status, error: r.body.error }).toEqual({ s, p, status: 409, error: expect.objectContaining({ code: 'CANNOT_BE_REACHED', details: { reason: 'cannot_be_reached', playbookId: plan[p].id } }) });
      expect({ s, p, enrollments: await enrollmentsOf(h, id) }).toEqual({ s, p, enrollments: [] });
      expect((await h.su.query("SELECT count(*)::int AS n FROM messages WHERE contact_id = $1 AND direction = 'outbound'", [id])).rows[0]).toEqual({ n: 0 });
    }
    expect(h.providers.telephony.sms.length).toBe(sent);
  });

  it('B9: a person reachable on at least one channel the plan uses is accepted (201): nobody opted out; the text opted out but the plan also emails; the email opted out but the plan also texts; an email-only person for an email plan', async () => {
    const cases: [Situation, 'text' | 'email' | 'both'][] = [['fresh', 'text'], ['fresh', 'both'], ['stop', 'email'], ['stop', 'both'], ['emailRevoked', 'text'], ['emailRevoked', 'both'], ['emailOnly', 'email']];
    for (const [s, p] of cases) {
      const id = await person(s);
      const r = await enroll(id, plan[p].id);
      expect({ s, p, status: r.status }, JSON.stringify(r.body)).toEqual({ s, p, status: 201 });
      expect((await liveOf(id)).map((e) => e.playbook_id)).toEqual([plan[p].id]);
    }
  });

  it('B9 R-PAR-16: the direct route decides exactly as a stage entry does, for every situation and plan (the same function: reachableForVersion)', async () => {
    const got: Record<string, unknown> = {};
    const want: Record<string, unknown> = {};
    for (const p of ['text', 'email', 'both'] as const) {
      for (const s of SITUATIONS) {
        const id = await person(s);
        const direct = await enroll(id, plan[p].id);
        if (direct.status === 201) expect((await call(agent, 'POST', `/enrollments/${direct.body.enrollment.id}/stop`)).status).toBe(200);
        const entry = await changeStage(agent, id, plan[p].stage);
        expect(entry.status, JSON.stringify(entry.body)).toBe(200);
        got[`${s} ${p}`] = { direct: direct.status === 201 ? 'enrolled' : direct.code, stageEntry: entry.body.automation };
        want[`${s} ${p}`] = REACHABLE[s][p]
          ? { direct: 'enrolled', stageEntry: { started: plan[p].name } }
          : { direct: 'CANNOT_BE_REACHED', stageEntry: { skipped: 'cannot_be_reached', plan: plan[p].name } };
      }
    }
    expect(got).toEqual(want);
  });

  it('B9: the refusal changes nothing: a person in a plan who then texted STOP is refused a text plan even with confirmReplace, and the plan they are in is left as it was', async () => {
    const phone = randomPhone();
    const id = await newContact(agent, { phones: [phone], emails: [] });
    const first = await enroll(id, plan.both.id);
    expect(first.status).toBe(201);
    expect((await inboundSms(h, phone, w.mainNumber, 'STOP')).statusCode).toBeLessThan(300);
    const before = await enrollmentsOf(h, id);
    expect(before.map((e) => e.state)).toEqual(['paused']); // the STOP paused it (R-AST-9)
    const r = await enroll(id, plan.text.id, { confirmReplace: true });
    expect([r.status, r.code]).toEqual([409, 'CANNOT_BE_REACHED']);
    expect(await enrollmentsOf(h, id)).toEqual(before);
  });

  it('B9 decide.ts: a plan with no text or email step sends nothing and so reaches everyone, as in a stage entry (reachableOn([]) is true): even a person who asked not to be contacted is accepted, by both paths', async () => {
    // the step schema has no task-only step: an approved version without a text or email step stands in for one
    // (a fixture: validatePlaybook refuses an empty plan, so no application path writes it)
    const playbookId = randomUUID();
    const versionId = randomUUID();
    const steps: unknown[] = [];
    const sha = contentSha256(steps as never, {} as never);
    await h.su.query("INSERT INTO playbooks (tenant_id, id, kind, scope, name) VALUES ($1, $2, 'nurture', 'team', 'Nothing to send')", [w.tenantId, playbookId]);
    await h.su.query("INSERT INTO playbook_versions (tenant_id, id, playbook_id, version_no, steps, tone, content_sha256, status, created_by_user_id) VALUES ($1, $2, $3, 1, '[]', '{}', $4, 'draft', $5)", [w.tenantId, versionId, playbookId, sha, w.owner.userId]);
    const c = await h.su.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query("INSERT INTO playbook_approvals (tenant_id, id, playbook_version_id, decision, decided_by_user_id, decided_by_role, content_sha256, attestation, decided_at) VALUES ($1, $2, $3, 'approve', $4, 'owner', $5, 'I approve this plan', now())", [w.tenantId, randomUUID(), versionId, w.owner.userId, sha]);
      await c.query("UPDATE playbook_versions SET status = 'approved' WHERE id = $1", [versionId]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    expect((await setStage(w.owner, playbookId, 'lost')).status).toBe(200);
    const direct = await person('dnc');
    expect((await enroll(direct, playbookId)).status).toBe(201);
    const entry = await person('dnc');
    expect((await changeStage(agent, entry, 'lost')).body.automation).toEqual({ started: 'Nothing to send' });
    expect((await decisionsOf(h, entry)).map((d) => d.outcome)).toEqual(['started']);
  });

  it('R-PERM-5: another tenant’s contact is 404 (with this tenant’s plan and with its own), and nothing is written', async () => {
    const other = await leadsWorld(h, { agents: 1, rule: false });
    const theirs = await call<{ contact: { id: string } }>(other.agents[0]!, 'POST', '/contacts', { commandId: randomUUID(), firstName: 'Other', lastName: 'Tenant', phones: [randomPhone()], emails: [] });
    expect(theirs.status).toBe(201);
    const r = await enroll(theirs.body.contact.id, plan.text.id);
    expect([r.status, r.code]).toEqual([404, 'NOT_FOUND']);
    const mine = await person('fresh');
    const back = await call(other.agents[0]!, 'POST', `/contacts/${mine}/enrollments`, { playbookId: plan.text.id });
    expect([back.status, back.code]).toEqual([404, 'NOT_FOUND']);
    expect([await enrollmentsOf(h, theirs.body.contact.id), await enrollmentsOf(h, mine)]).toEqual([[], []]);
  });
});

// F2 (B9 review): a merged-away record is never enrolled. A stage entry skips it (decide.ts person_removed: deleted or
// merged away), the merge stops the loser's own enrollment (R-OWN-24: one live enrollment per person), and the people
// writes refuse it (people/common.ts liveDetailFacts). The direct route used to enroll it (201): a second live plan for
// one person, stranded on the loser and texting the loser's phone, and the loser's own opt-out state was all its
// reachability check saw (F1).
describe('F2 R-OWN-24 R-PAR-16: a merged-away record is never enrolled, by any path', () => {
  /** The agent's S and L (L with a collaborator, agent2, added before the merge); S in the text plan; the Owner merges L into S. */
  async function mergedPair(o: { enrollLoser?: boolean } = {}): Promise<{ s: string; l: string; sEnrollment: string; lEnrollment: string | null }> {
    const s = await newContact(agent, { phones: [randomPhone()], emails: [randomEmail()] });
    const l = await newContact(agent, { phones: [randomPhone()], emails: [randomEmail()], firstName: 'Jean' });
    expect((await call(agent, 'POST', `/contacts/${l}/collaborators`, { userId: agent2.userId, role: 'co_agent' })).status).toBe(200);
    const e = await enroll(s, plan.text.id);
    expect(e.status, JSON.stringify(e.body)).toBe(201);
    const le = o.enrollLoser ? await enroll(l, plan.text.id) : null;
    if (le) expect(le.status, JSON.stringify(le.body)).toBe(201);
    await freshReauth(h, w.owner);
    const m = await command(w.owner, s, 'merge', { loserId: l });
    expect(m.status, JSON.stringify(m.body)).toBe(200);
    // after the merge: the former owner no longer sees L; the Owner, an Admin and L's collaborator still do
    expect((await call(agent, 'GET', `/contacts/${l}`)).status).toBe(404);
    for (const [who, c] of [['owner', w.owner], ['admin', admin], ['collaborator', agent2]] as const) expect((await call(c, 'GET', `/contacts/${l}`)).status, who).toBe(200);
    return { s, l, sEnrollment: e.body.enrollment.id, lEnrollment: le ? le.body.enrollment.id : null };
  }
  const messagesTo = async (contactId: string) => Number((await h.su.query<{ n: string }>("SELECT count(*) AS n FROM messages WHERE contact_id = $1 AND direction = 'outbound'", [contactId])).rows[0]!.n);

  it('F2 decide.ts person_removed: the Owner, an Admin and a collaborator of the loser are refused (409 CONTACT_MERGED, reason person_removed), as a stage entry skips it; the former owner gets 404; no enrollment row, nothing queued, the survivor’s own plan untouched', async () => {
    const { s, l, sEnrollment } = await mergedPair();
    const sBefore = await enrollmentsOf(h, s);
    const got: Record<string, unknown> = {};
    for (const [who, c] of [['owner', w.owner], ['admin', admin], ['collaborator', agent2]] as const) {
      const r = await call<{ error: { code: string; details?: Record<string, unknown> } }>(c, 'POST', `/contacts/${l}/enrollments`, { playbookId: plan.text.id });
      got[who] = [r.status, r.body.error?.code, r.body.error?.details?.reason];
      // the survivor is named only to whoever sees it (R-PERM-5): the collaborator of the loser does not
      expect(r.body.error?.details?.mergedInto ?? null, who).toBe(who === 'collaborator' ? null : s);
    }
    expect(got).toEqual({ owner: [409, 'CONTACT_MERGED', 'person_removed'], admin: [409, 'CONTACT_MERGED', 'person_removed'], collaborator: [409, 'CONTACT_MERGED', 'person_removed'] });
    const former = await enroll(l, plan.text.id);
    expect([former.status, former.code]).toEqual([404, 'NOT_FOUND']);
    // decide.ts says the same of this person: person_removed
    expect(decideStageEntry({ actorKind: 'user', toStage: 'active', contact: { exists: true, deleted: false, merged: true, stage: 'active', ownerUserId: null }, changerSeesDetail: true, candidates: [{ id: plan.text.id, name: plan.text.name, scope: 'team', ownerUserId: null, approvedVersionId: randomUUID() }], liveEnrollment: false, reachable: true })).toMatchObject({ kind: 'skip', reason: 'person_removed' });
    // nothing was written: the loser has only the enrollment the merge stopped (none here), the survivor keeps its own
    expect(await enrollmentsOf(h, l)).toEqual([]);
    expect(await enrollmentsOf(h, s)).toEqual(sBefore);
    expect(sBefore.map((e) => [e.id, e.state])).toEqual([[sEnrollment, 'active']]);
    expect(await messagesTo(l)).toBe(0);
  });

  it('F2: the step runner stops an enrollment whose person was merged away (stop_reason merged, as the merge itself stops one) and sends nothing to the loser', async () => {
    const { l, lEnrollment } = await mergedPair({ enrollLoser: true });
    const id = lEnrollment!;
    // R-OWN-24: the merge stopped the loser's own enrollment
    expect((await h.su.query('SELECT state, stop_reason FROM playbook_enrollments WHERE id = $1', [id])).rows[0]).toEqual({ state: 'stopped', stop_reason: 'merged' });
    // a live enrollment on the loser after the merge anyway (a race the merge's stop cannot see, or one written before
    // this fix): a superuser fixture, since no application path writes it now
    await h.su.query("UPDATE playbook_enrollments SET state = 'active', stop_reason = NULL, ended_at = NULL WHERE id = $1", [id]);
    const phones = (await h.su.query<{ address: string }>("SELECT address FROM contact_points WHERE contact_id = $1 AND kind = 'phone'", [l])).rows.map((p) => p.address);
    const toLoser = () => h.providers.telephony.sms.filter((m) => phones.includes(m.to)).length;
    const sms = toLoser();
    await stepNow(h, w.tenantId, id);
    await runJobs(h, w.tenantId, ['playbook.step', 'comms.dispatch']);
    expect((await h.su.query('SELECT state, stop_reason FROM playbook_enrollments WHERE id = $1', [id])).rows[0]).toEqual({ state: 'stopped', stop_reason: 'merged' });
    expect(await messagesTo(l)).toBe(0);
    expect(toLoser()).toBe(sms);
  });

  it('F2 A4: a deal of the merged-away record closing never enrolls that record in the post-closing plan (the system path skips it as a stage entry would)', async () => {
    const pc = await call<{ playbook: { id: string; versions: { id: string; contentSha256: string }[] } }>(w.owner, 'POST', '/playbooks', { templateKey: 'post_closing', scope: 'team' });
    expect(pc.status, JSON.stringify(pc.body)).toBe(201);
    const v = pc.body.playbook.versions[0]!;
    expect((await call(w.owner, 'POST', `/playbook-versions/${v.id}/approve`, { attestation: 'I approve the team after-closing notes.', contentSha256: v.contentSha256 })).status).toBe(200);
    const { l } = await mergedPair();
    // a merge moves no deal: the loser's deal closes after the merge
    const dealId = randomUUID();
    await h.su.query(`INSERT INTO deals (tenant_id, id, name, side, stage, stage_entered_at, primary_contact_id, owner_user_id, closed_at) VALUES ($1,$2,'Close','buy','closed',now(),$3,$4,now())`, [w.tenantId, dealId, l, agent.userId]);
    expect(await enrollOnDealClosed(systemActor(w.tenantId, 'assistant'), dealId, depsOf(h))).toEqual([]);
    expect(await enrollmentsOf(h, l)).toEqual([]);
    // control: the same plan does enroll a live person whose deal closes
    const live = await newContact(agent);
    const deal2 = randomUUID();
    await h.su.query(`INSERT INTO deals (tenant_id, id, name, side, stage, stage_entered_at, primary_contact_id, owner_user_id, closed_at) VALUES ($1,$2,'Close','buy','closed',now(),$3,$4,now())`, [w.tenantId, deal2, live, agent.userId]);
    expect(await enrollOnDealClosed(systemActor(w.tenantId, 'assistant'), deal2, depsOf(h))).toHaveLength(1);
  });
});
