// B9: a direct enrollment (POST /contacts/:id/enrollments) of a person who cannot be reached (R-PAR-16, R-PAR-12, D1).
//
// A stage entry never starts a plan for a person no channel of that plan can reach (stageAutomation/decide.ts
// cannot_be_reached; bulk enroll skips them too). The direct route used to accept them: the sends stayed blocked
// at send time, but the plan showed as live although it could never send. It now applies the same rule through the
// same function (stageAutomation reachableForVersion: core canContact on the gate input dispatch builds, opt-outs
// only, the removed phones' STOPs included) and refuses with the stage-automation skip reason. Real Postgres, the
// real server, fake providers only.
import { randomUUID } from 'node:crypto';
import { contentSha256 } from '@realty/core/assistant';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type CommsWorld, call, commsWorld, inboundSms, randomEmail, randomPhone } from '../comms/testing.js';
import { leadsWorld } from '../leads/testing.js';
import { changeStage, decisionsOf, enrollmentsOf, newContact, setStage } from '../stageAutomation/testing.js';
import { smsStep } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
let agent: TestClient;
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
  w = await commsWorld(h, { agents: 1, rule: false });
  agent = w.agents[0]!;
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
