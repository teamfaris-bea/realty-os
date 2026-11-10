// Handbacks: pause on reply, enrichment, one-tap reply (R-AST-3, R-AST-9, R-AST-18; E35).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { type ApprovedPlaybook, type AssistantWorld, actionsOf, appointment, approvedPlaybook, assistantWorld, call, decisionsFor, enrollmentRow, inboundSms, messageRow, ownedContact, runJobs, setAiEnabled, smsStep } from './testing.js';

let h: ApiHarness;
let w: AssistantWorld;
let pb: ApprovedPlaybook;

beforeAll(async () => {
  h = await createApiHarness();
  w = await assistantWorld(h, { agents: 1 });
  pb = await approvedPlaybook(w.owner, {
    kind: 'booking_confirmation',
    scope: 'team',
    name: 'Confirm',
    steps: [smsStep({ key: 'confirm', category: 'booking_confirmation', intent: 'appointment_confirmation', purpose: 'informational', template: 'Hi {{first_name}}, you are set for {{appointment_time}}.', slots: ['first_name', 'appointment_time'] })],
  });
});
afterAll(async () => {
  await h?.close();
});

type Card = { id: string; kind: string; explanation: string; primaryAction: string; draft: { body: string } | null; claims: { kind: string; text: string; needsReview: boolean; evidence: { verified: boolean }[] }[] };

/** A contact in a live playbook whose first step went out, who then replies with `text`. */
async function handbackFor(text: string): Promise<{ contactId: string; handbackId: string; enrollmentId: string }> {
  const agent = w.agents[0]!;
  const c = await ownedContact(agent);
  const appt = await appointment(h, w, c.id, agent.userId!);
  const e = await call<{ enrollment: { id: string } }>(agent, 'POST', `/contacts/${c.id}/enrollments`, { playbookId: pb.playbookId, anchor: { kind: 'appointment', id: appt } });
  await runJobs(h, w.tenantId, ['playbook.step', 'comms.dispatch']);
  expect((await inboundSms(h, c.phone, w.mainNumber, text)).statusCode).toBe(200);
  const hb = (await actionsOf(h, c.id)).filter((a) => a.kind === 'handback');
  expect(hb).toHaveLength(1);
  return { contactId: c.id, handbackId: hb[0]!.id, enrollmentId: e.body.enrollment.id };
}

describe('handbacks (R-AST-9)', () => {
  it('R-AST-9: the reply pauses the playbook and hands back with deterministic evidence; enrichment adds a suggestion and a reply; ONE tap sends the reply as the agent', async () => {
    const { contactId, handbackId, enrollmentId } = await handbackFor('Thanks! Could we move it to 5 pm?');
    expect((await enrollmentRow(h, enrollmentId)).state).toBe('paused');
    await runJobs(h, w.tenantId, ['assistant.enrich_handback']);
    const card = (await call<{ action: Card }>(w.agents[0]!, 'GET', `/assistant/actions/${handbackId}`)).body.action;
    expect(card.kind).toBe('handback');
    expect(card.primaryAction).toBe('send');
    expect(card.draft?.body).toBeTruthy();
    // comms' deterministic claims (what they said, what was sent), plus the model's (one verified, one not)
    expect(card.claims.find((x) => x.kind === 'client_statement' && x.text.includes('move it to 5 pm'))!.needsReview).toBe(false);
    expect(card.claims.some((x) => x.needsReview)).toBe(true);
    for (const x of card.claims.filter((y) => !y.needsReview)) expect(x.evidence.some((e) => e.verified)).toBe(true);

    const r = await call<{ result: string; messageId: string; status: string }>(w.agents[0]!, 'POST', `/assistant/actions/${handbackId}/approve`, { commandId: randomUUID() });
    expect(r.status).toBe(200);
    expect(r.body.result).toBe('sent');
    expect(r.body.status).toBe('approved');
    expect((await messageRow(h, r.body.messageId)).status).toBe('sent');
    expect(await decisionsFor(h, { messageId: r.body.messageId })).toHaveLength(0);
    expect((await h.su.query<{ u: string | null; c: string }>('SELECT a.decided_by_user_id AS u, a.action_category AS c FROM messages m JOIN assistant_actions a ON a.tenant_id = m.tenant_id AND a.id = m.assistant_action_id WHERE m.id = $1', [r.body.messageId])).rows[0]).toMatchObject({ u: w.agents[0]!.userId });
    const reply = (await actionsOf(h, contactId)).find((a) => a.kind === 'message_draft')!;
    expect(reply).toMatchObject({ autonomy: 'requires_approval', status: 'executed', owner_user_id: w.agents[0]!.userId });
    // the playbook stays paused until the agent resumes it (human-only)
    expect((await enrollmentRow(h, enrollmentId)).state).toBe('paused');
  });

  it('R-AST-3 E35: a client asking about price gets a reply draft labelled money, never sent without the agent\'s tap', async () => {
    const { contactId, handbackId } = await handbackFor('Would the sellers take 450k if we close fast?');
    const sms = h.providers.telephony.sms.length;
    await runJobs(h, w.tenantId, ['assistant.enrich_handback', 'comms.dispatch']);
    expect(h.providers.telephony.sms.length).toBe(sms);
    const hb = (await actionsOf(h, contactId)).find((a) => a.id === handbackId)!;
    expect(hb.payload.draftCategory).toBe('money');
    expect(hb.explanation).toMatch(/money/);
    const r = await call<{ messageId: string }>(w.agents[0]!, 'POST', `/assistant/actions/${handbackId}/approve`, { commandId: randomUUID() });
    expect(r.status).toBe(200);
    const reply = (await actionsOf(h, contactId)).find((a) => a.kind === 'message_draft')!;
    expect(reply).toMatchObject({ action_category: 'money', autonomy: 'requires_approval' });
    expect((await h.su.query<{ u: string | null; c: string }>('SELECT a.decided_by_user_id AS u, a.action_category AS c FROM messages m JOIN assistant_actions a ON a.tenant_id = m.tenant_id AND a.id = m.assistant_action_id WHERE m.id = $1', [r.body.messageId])).rows[0]).toEqual({ u: w.agents[0]!.userId, c: 'money' });
  });

  it('R-AST-18: with AI off the handback is still useful (no enrichment, no provider call) and can be marked handled with one tap', async () => {
    const { handbackId } = await handbackFor('ok see you then');
    await setAiEnabled(h, w.tenantId, false);
    try {
      const before = h.providers.ai.calls.length;
      await runJobs(h, w.tenantId, ['assistant.enrich_handback']);
      expect(h.providers.ai.calls.length).toBe(before);
      const card = (await call<{ action: Card }>(w.agents[0]!, 'GET', `/assistant/actions/${handbackId}`)).body.action;
      expect(card.draft).toBeNull();
      expect(card.primaryAction).toBe('acknowledge');
      const r = await call<{ result: string; status: string }>(w.agents[0]!, 'POST', `/assistant/actions/${handbackId}/approve`, { commandId: randomUUID() });
      expect(r.body).toMatchObject({ result: 'acknowledged', status: 'approved' });
    } finally {
      await setAiEnabled(h, w.tenantId, true);
    }
  });
});
