// The playbook step runner and autonomous sends (R-AST-3, R-AST-8, R-AST-9, R-AST-11, R-GATE-3,
// R-GATE-4, R-GATE-10, R-GATE-12; E22, E26, E35). Real Postgres, the real server, fake providers.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { dispatchOutbound } from '../comms/index.js';
import { systemActor } from '../worker/systemActor.js';
import { enrollOnDealClosed, executePlaybookStep } from './enrollments.js';
import {
  type ApprovedPlaybook,
  type AssistantWorld,
  actionsOf,
  appointment,
  approvedPlaybook,
  assistantWorld,
  auditRows,
  call,
  decisionsFor,
  depsOf,
  enrollmentRow,
  inboundSms,
  messageRow,
  messagesOf,
  ownedContact,
  runJobs,
  smsStep,
  stepNow,
} from './testing.js';

let h: ApiHarness;
let w: AssistantWorld;
let confirm: ApprovedPlaybook;
let brokerage: string;

beforeAll(async () => {
  h = await createApiHarness();
  w = await assistantWorld(h, { agents: 2 });
  brokerage = (await h.su.query<{ b: string }>('SELECT brokerage_legal_name AS b FROM tenant_settings WHERE tenant_id = $1', [w.tenantId])).rows[0]!.b;
  confirm = await approvedPlaybook(w.owner, {
    kind: 'booking_confirmation',
    scope: 'team',
    name: 'Confirm',
    steps: [
      smsStep({ key: 'confirm', category: 'booking_confirmation', intent: 'appointment_confirmation', purpose: 'informational', template: 'Hi {{first_name}}, you are set for {{appointment_time}} at {{appointment_place}}. Reply here to change it.', slots: ['first_name', 'appointment_time', 'appointment_place'] }),
    ],
  });
});
afterAll(async () => {
  await h?.close();
});

async function enroll(agentIdx: number, contactId: string, body: Record<string, unknown>) {
  return call<{ enrollment: { id: string; state: string } }>(w.agents[agentIdx]!, 'POST', `/contacts/${contactId}/enrollments`, body);
}

describe('autonomous playbook sends (R-GATE-4, R-GATE-3, R-AST-11)', () => {
  it('R-GATE-10 R-GATE-4 R-AST-11 R-GATE-12: an approved step runs on its own: rendered with the identity sign-off, brokerage and STOP line, gated at send time, sent; the enrollment then completes', async () => {
    const c = await ownedContact(w.agents[0]!, { firstName: 'Jane' });
    const appt = await appointment(h, w, c.id, w.agents[0]!.userId!, { location: 'the Elm St office' });
    const e = await enroll(0, c.id, { playbookId: confirm.playbookId, anchor: { kind: 'appointment', id: appt } });
    expect(e.status).toBe(201);
    expect((await auditRows(h, w.tenantId, 'enrollment.changed')).some((a) => a.entity_id === e.body.enrollment.id)).toBe(true);
    await runJobs(h, w.tenantId, ['playbook.step', 'comms.dispatch']);
    const [m] = await messagesOf(h, c.id);
    expect(m).toMatchObject({ status: 'sent', initiator: 'assistant', action_category: 'booking_confirmation' });
    expect(m!.body).toMatch(/^Hi Jane, you are set for .+ at the Elm St office\. Reply here to change it\./);
    expect(m!.body).toContain('assistant'); // "— the … assistant": never a human claim (R-AST-11)
    expect(m!.body).toContain(brokerage); // first message in the thread carries the brokerage name
    expect(m!.body).toContain('Reply STOP to opt out');
    expect(await decisionsFor(h, { messageId: m!.id })).toHaveLength(0); // allowed: nothing logged
    const a = (await actionsOf(h, c.id)).find((x) => x.kind === 'autonomous_message')!;
    expect(a).toMatchObject({ autonomy: 'within_playbook', status: 'executed' });
    await stepNow(h, w.tenantId, e.body.enrollment.id);
    await runJobs(h, w.tenantId, ['playbook.step'], 1, ['default']);
    expect((await enrollmentRow(h, e.body.enrollment.id)).state).toBe('completed');
  });

  it('R-GATE-10 R-CONSENT-10: the assistant never texts a number the person asked not to be texted (agent-recorded do-not-contact): blocked at send time, logged, nothing reaches the provider, the step is skipped visibly', async () => {
    const c = await ownedContact(w.agents[0]!, { consent: false });
    const pid = (await h.su.query<{ id: string }>("SELECT id FROM contact_points WHERE contact_id = $1 AND kind = 'phone'", [c.id])).rows[0]!.id;
    expect((await call(w.agents[0]!, 'POST', `/contacts/${c.id}/consent`, { kind: 'revoke', pointId: pid, channel: 'sms', purpose: 'all', evidence: { note: 'asked us not to text' } })).status).toBe(200);
    const appt = await appointment(h, w, c.id, w.agents[0]!.userId!);
    const e = await enroll(0, c.id, { playbookId: confirm.playbookId, anchor: { kind: 'appointment', id: appt } });
    const before = h.providers.telephony.sms.length;
    await runJobs(h, w.tenantId, ['playbook.step', 'comms.dispatch']);
    const [m] = await messagesOf(h, c.id);
    expect(m!.status).toBe('blocked');
    expect((await decisionsFor(h, { messageId: m!.id }))[0]!.reason_codes).toContain('CONSENT_REVOKED');
    expect(h.providers.telephony.sms.length).toBe(before);
    expect((await h.su.query('SELECT status FROM playbook_step_runs WHERE enrollment_id = $1', [e.body.enrollment.id])).rows).toEqual([{ status: 'skipped_ineligible' }]);
  });

  it('R-AST-3 E35: a step whose rendered text touches money becomes a draft for the agent (never autonomous); one tap sends it as the agent', async () => {
    const c = await ownedContact(w.agents[0]!);
    const appt = await appointment(h, w, c.id, w.agents[0]!.userId!, { location: 'our office to go over your offer' });
    const e = await enroll(0, c.id, { playbookId: confirm.playbookId, anchor: { kind: 'appointment', id: appt } });
    await runJobs(h, w.tenantId, ['playbook.step', 'comms.dispatch']);
    expect(await messagesOf(h, c.id)).toEqual([]);
    const d = (await actionsOf(h, c.id)).find((x) => x.kind === 'message_draft')!;
    expect(d).toMatchObject({ action_category: 'money', autonomy: 'requires_approval', status: 'proposed', owner_user_id: w.agents[0]!.userId });
    expect(d.explanation).toMatch(/money/i);
    expect((await h.su.query('SELECT status, assistant_action_id FROM playbook_step_runs WHERE enrollment_id = $1', [e.body.enrollment.id])).rows).toEqual([{ status: 'converted_to_draft', assistant_action_id: d.id }]);
    const inbox = await call<{ items: { id: string; primaryAction: string; explanation: string }[] }>(w.agents[0]!, 'GET', '/assistant/inbox');
    expect(inbox.body.items.find((i) => i.id === d.id)).toMatchObject({ primaryAction: 'send' });
    const ap = await call<{ result: string; messageId: string }>(w.agents[0]!, 'POST', `/assistant/actions/${d.id}/approve`, { commandId: randomUUID() });
    expect(ap.status).toBe(200);
    expect(ap.body.result).toBe('sent');
    expect(await decisionsFor(h, { messageId: ap.body.messageId })).toHaveLength(0);
    expect((await h.su.query<{ u: string | null; c: string }>('SELECT a.decided_by_user_id AS u, a.action_category AS c FROM messages m JOIN assistant_actions a ON a.tenant_id = m.tenant_id AND a.id = m.assistant_action_id WHERE m.id = $1', [ap.body.messageId])).rows[0]).toEqual({ u: w.agents[0]!.userId, c: 'money' });
  });
});

describe('one live enrollment (R-AST-8)', () => {
  it('R-AST-8: a second playbook needs an explicit replace; the same one is ALREADY_ENROLLED; an agent playbook runs only for its agent\'s contacts', async () => {
    const other = await approvedPlaybook(w.owner, { kind: 'reminder', scope: 'team', name: 'Reminder', steps: [smsStep({ key: 'remind', category: 'reminder', intent: 'appointment_reminder', purpose: 'informational', template: 'Hi {{first_name}}, a quick reminder from us.', slots: ['first_name'], anchor: 'enrollment', offsetSeconds: 3600 })] });
    const c = await ownedContact(w.agents[0]!);
    const first = await enroll(0, c.id, { playbookId: other.playbookId });
    expect(first.status).toBe(201);
    expect((await enroll(0, c.id, { playbookId: other.playbookId })).code).toBe('ALREADY_ENROLLED');
    const r = await enroll(0, c.id, { playbookId: confirm.playbookId });
    expect(r.code).toBe('ENROLLMENT_REPLACE_NEEDS_CONFIRMATION');
    const ok = await enroll(0, c.id, { playbookId: confirm.playbookId, confirmReplace: true });
    expect(ok.status).toBe(201);
    expect(await enrollmentRow(h, first.body.enrollment.id)).toMatchObject({ state: 'stopped', stop_reason: 'replaced' });
    // the DB keeps one live enrollment per contact no matter what
    await expect(h.su.query("INSERT INTO playbook_enrollments (tenant_id, id, playbook_id, playbook_version_id, contact_id, enrolled_by, state) VALUES ($1,$2,$3,$4,$5,'new_lead','active')", [w.tenantId, randomUUID(), other.playbookId, other.versionId, c.id])).rejects.toThrow(/enrollment_one_live/);
    // an agent's own playbook may not be used on another agent's contact
    const mine = await approvedPlaybook(w.agents[1]!, { templateKey: 'nurture' });
    expect((await enroll(1, (await ownedContact(w.agents[1]!)).id, { playbookId: mine.playbookId })).status).toBe(201);
    const notMine = await ownedContact(w.agents[0]!);
    expect((await call(w.owner, 'POST', `/contacts/${notMine.id}/enrollments`, { playbookId: mine.playbookId })).code).toBe('PLAYBOOK_OWNER_MISMATCH');
  });

  it('R-AST-9: resume is a human action (DB guard) and audited; pause cancels the queued step', async () => {
    const c = await ownedContact(w.agents[0]!);
    const appt = await appointment(h, w, c.id, w.agents[0]!.userId!);
    const e = (await enroll(0, c.id, { playbookId: confirm.playbookId, anchor: { kind: 'appointment', id: appt } })).body.enrollment.id;
    await runJobs(h, w.tenantId, ['playbook.step'], 1, ['default']);
    const [m] = await messagesOf(h, c.id);
    expect(m!.status).toBe('queued');
    const p = await call<{ enrollment: { state: string } }>(w.agents[0]!, 'POST', `/enrollments/${e}/pause`);
    expect(p.body.enrollment.state).toBe('paused');
    expect((await messageRow(h, m!.id)).status).toBe('canceled');
    // the system can never resume (DB guard RESUME_REQUIRES_HUMAN)
    await expect(
      import('@realty/db').then(({ withTenantTx }) =>
        withTenantTx(systemActor(w.tenantId, 'assistant'), (tx) => import('kysely').then(({ sql }) => sql`UPDATE playbook_enrollments SET state = 'active', pause_reason = NULL, paused_at = NULL WHERE id = ${e}`.execute(tx)), { db: h.database }),
      ),
    ).rejects.toThrow(/RESUME_REQUIRES_HUMAN/);
    const r = await call<{ enrollment: { state: string } }>(w.agents[0]!, 'POST', `/enrollments/${e}/resume`);
    expect(r.body.enrollment.state).toBe('active');
    expect((await auditRows(h, w.tenantId, 'automation.resumed')).some((a) => a.entity_id === e && a.actor_user_id === w.agents[0]!.userId)).toBe(true);
    // another agent cannot touch it (404)
    expect((await call(w.agents[1]!, 'POST', `/enrollments/${e}/stop`)).status).toBe(404);
  });
});

describe('client replies and races (R-AST-9; E22, E26)', () => {
  it('R-AST-9 E26: a reply while a step is queued cancels it, pauses the enrollment and creates exactly one handback; the next step pass does nothing', async () => {
    const c = await ownedContact(w.agents[0]!);
    const appt = await appointment(h, w, c.id, w.agents[0]!.userId!);
    const e = (await enroll(0, c.id, { playbookId: confirm.playbookId, anchor: { kind: 'appointment', id: appt } })).body.enrollment.id;
    await runJobs(h, w.tenantId, ['playbook.step'], 1, ['default']);
    const [m] = await messagesOf(h, c.id);
    expect(m!.status).toBe('queued');
    expect((await inboundSms(h, c.phone, w.mainNumber, 'Actually can we do Friday instead?')).statusCode).toBe(200);
    expect((await messageRow(h, m!.id)).status).toBe('canceled');
    expect(await enrollmentRow(h, e)).toMatchObject({ state: 'paused', pause_reason: 'client_reply' });
    const handbacks = (await actionsOf(h, c.id)).filter((a) => a.kind === 'handback');
    expect(handbacks).toHaveLength(1);
    // counted for this contact only: other tests' queued messages may go out in the same dispatch run
    const toC = () => h.providers.telephony.sms.filter((x) => x.to === c.phone).length;
    const before = toC();
    const out = await executePlaybookStep(systemActor(w.tenantId, 'assistant'), e, depsOf(h));
    expect(out).toEqual({ kind: 'noop', reason: 'NOT_ACTIVE' });
    await runJobs(h, w.tenantId, ['comms.dispatch']);
    expect(toC()).toBe(before);
  });

  it('E22 R-AST-9: STOP arriving while the step message is being dispatched: either the message is stopped, or it went first and the handback says so', async () => {
    const outcomes = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const c = await ownedContact(w.agents[0]!);
      const appt = await appointment(h, w, c.id, w.agents[0]!.userId!);
      await enroll(0, c.id, { playbookId: confirm.playbookId, anchor: { kind: 'appointment', id: appt } });
      await runJobs(h, w.tenantId, ['playbook.step'], 1, ['default']);
      const [m] = await messagesOf(h, c.id);
      const before = h.providers.telephony.sms.filter((x) => x.to === c.phone).length;
      await Promise.all([dispatchOutbound(m!.id, depsOf(h), { tenantId: w.tenantId }), inboundSms(h, c.phone, w.mainNumber, 'STOP')]);
      const status = (await messageRow(h, m!.id)).status;
      const reached = h.providers.telephony.sms.filter((x) => x.to === c.phone && x.body === m!.body).length - before;
      if (status === 'sent' || status === 'delivered') {
        expect(reached).toBe(1);
        // dispatch committed first: the reply came after; the opt-out holds from now on
        outcomes.add('sent_first');
      } else {
        expect(['blocked', 'canceled']).toContain(status);
        expect(reached).toBe(0);
        outcomes.add('stopped');
      }
      // never a second text after the STOP (the confirmation, if any, is the provider's / comms' own)
      expect((await h.su.query("SELECT count(*)::int AS n FROM messages WHERE contact_id = $1 AND direction = 'outbound' AND initiator = 'assistant' AND status IN ('sent','delivered','dispatching')", [c.id])).rows[0].n).toBeLessThanOrEqual(1);
    }
    expect(outcomes.size).toBeGreaterThanOrEqual(1);
  });

  it('R-GATE-4 concurrency: two step jobs for the same enrollment at the same moment queue exactly one message (contact lock)', async () => {
    const c = await ownedContact(w.agents[0]!);
    const appt = await appointment(h, w, c.id, w.agents[0]!.userId!);
    const e = (await enroll(0, c.id, { playbookId: confirm.playbookId, anchor: { kind: 'appointment', id: appt } })).body.enrollment.id;
    const actor = systemActor(w.tenantId, 'assistant');
    const rs = await Promise.all([executePlaybookStep(actor, e, depsOf(h)), executePlaybookStep(actor, e, depsOf(h)), executePlaybookStep(actor, e, depsOf(h))]);
    expect(rs.filter((r) => r.kind === 'queued')).toHaveLength(1);
    expect(await messagesOf(h, c.id)).toHaveLength(1);
    expect((await h.su.query('SELECT count(*)::int AS n FROM playbook_step_runs WHERE enrollment_id = $1', [e])).rows[0].n).toBe(1);
  });
});

describe('post-closing (A4)', () => {
  it('A4: the post-closing playbook auto-enrolls at deal closed only when it is approved, once per deal', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const dealId = randomUUID();
    await h.su.query(
      `INSERT INTO deals (tenant_id, id, name, side, stage, stage_entered_at, primary_contact_id, owner_user_id, closed_at) VALUES ($1,$2,'Close','buy','closed',now(),$3,$4,now())`,
      [w.tenantId, dealId, c.id, agent.userId],
    );
    const draft = await call<{ playbook: { id: string; versions: { id: string; contentSha256: string }[] } }>(agent, 'POST', '/playbooks', { templateKey: 'post_closing' });
    expect(await enrollOnDealClosed(systemActor(w.tenantId, 'assistant'), dealId, depsOf(h))).toEqual([]);
    const v = draft.body.playbook.versions[0]!;
    expect((await call(agent, 'POST', `/playbook-versions/${v.id}/approve`, { attestation: 'I approve my after-closing notes.', contentSha256: v.contentSha256 })).status).toBe(200);
    const enrolled = await enrollOnDealClosed(systemActor(w.tenantId, 'assistant'), dealId, depsOf(h));
    expect(enrolled).toHaveLength(1);
    expect(await enrollOnDealClosed(systemActor(w.tenantId, 'assistant'), dealId, depsOf(h))).toEqual([]);
    const row = (await h.su.query('SELECT enrolled_by, anchor_kind, anchor_id, state FROM playbook_enrollments WHERE id = $1', [enrolled[0]])).rows[0];
    expect(row).toEqual({ enrolled_by: 'deal_closed', anchor_kind: 'deal', anchor_id: dealId, state: 'active' });
    // the first step waits 14 days after closing; the home-value step is skipped until an AVM exists
    const out = await executePlaybookStep(systemActor(w.tenantId, 'assistant'), enrolled[0]!, depsOf(h));
    expect(out.kind).toBe('waiting');
  });
});
