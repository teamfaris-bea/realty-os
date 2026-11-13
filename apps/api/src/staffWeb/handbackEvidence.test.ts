// E662 (module 55 verify 1): handbacks whose claims cite a stored field carry the locator `{kind:'field', field}`
// (voice/handback.ts: the voice outcome and the appointment time; comms/inbound.ts: a missed call's status during an
// enrollment, an auto-reply header). The evidence formatter read only `locator.name`, so the recipient's inbox and
// task reads answered 500. These are the recipient's own reads, on real Postgres with the fake providers; all four
// cases of E662 are built (batch 14 audit T2 added the auto-reply and a task that cites a field claim).
import { randomUUID } from 'node:crypto';
import { renderStep, signOffFor } from '@realty/core/assistant';
import { SCRIPTS } from '@realty/core/voice/testing';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { call } from '../admin/testing.js';
import { queueOutboundInTx } from '../comms/compose.js';
import { emailWebhook, ownedContact, playbookFixture, sid, telephonyWebhook } from '../comms/testing.js';
import { type VoiceWorld, aiCall, handbacksOf, setVoicePack, voiceWorld } from '../voice/testing.js';
import { evidenceForClaims } from '../workspace/repos/evidence.js';
import { systemActor } from '../worker/systemActor.js';

let h: ApiHarness;
let w: VoiceWorld;
beforeAll(async () => {
  h = await createApiHarness();
  await setVoicePack(h, { reviewed: true, vendorReady: true });
  w = await voiceWorld(h);
}, 180_000);
afterAll(async () => {
  await h?.close();
});

type Inbox = { items: { id: string; kind: string; claims: { text: string; evidence: { label: string; locator: Record<string, unknown> }[] }[] }[] };
const fieldClaimsOf = async (actionId: string) =>
  (await h.su.query<{ id: string; locator: Record<string, unknown> }>("SELECT c.id, e.locator FROM assistant_claims c JOIN evidence_refs e ON e.claim_id = c.id WHERE c.action_id = $1 AND e.locator->>'kind' = 'field'", [actionId])).rows;

const step = { stepKey: 'checkin', channel: 'sms', delay: { anchor: 'enrollment', offsetSeconds: 0 }, purpose: 'informational', category: 'reminder', intent: 'appointment_reminder', template: 'Reminder: your showing is tomorrow at 10.', personalization: 'none', slots: [], maxLength: 640, stopIf: [] };

/** A live enrollment with one queued assistant text for the contact, so a reply hands back. */
async function enrolled(contactId: string): Promise<void> {
  const s = (await h.su.query<{ b: string; t: string | null }>('SELECT brokerage_legal_name AS b, team_name AS t FROM tenant_settings WHERE tenant_id = $1', [w.tenantId])).rows[0]!;
  const r0 = renderStep(step as never, {}, { signOff: signOffFor({ scope: 'team', agentFirstName: null, teamName: s.t ?? s.b }), brokerageName: s.b, firstInThread: true });
  if (!r0.ok) throw new Error('render');
  const pb = await playbookFixture(h, w.tenantId, w.owner, contactId, { scope: 'team', step, body: r0.text, category: 'reminder', purpose: 'informational' });
  const q = await withTenantTx(systemActor(w.tenantId, 'assistant'), (tx, now) => queueOutboundInTx(tx, w.deps, { contactId, channel: 'sms', body: r0.text, initiator: 'assistant', purpose: 'informational', category: 'reminder', assistantActionId: pb.actionId, playbookStepRunId: pb.stepRunId, idempotencyKey: `n:${randomUUID()}`, scheduleAt: (Date.now() + 3600_000) as never }, now), { db: h.database });
  expect(q.ok).toBe(true);
}

describe('E662: field-locator evidence on a handback (verify 1)', () => {
  it('E662 R-STAFF-9: the recipient of a voice handback reads GET /assistant/inbox (200), and its call-field evidence is worded by the field (the web shows the claim text, never the stored value)', async () => {
    const c = await aiCall(h, w, SCRIPTS.booking);
    const hb = (await handbacksOf(h, c.callId))[0]!;
    const fields = await fieldClaimsOf(hb.id);
    expect(fields.length).toBeGreaterThan(0);
    expect(fields.every((f) => typeof f.locator.field === 'string' && f.locator.name === undefined)).toBe(true);
    const r = await call<Inbox>(w.agents[0]!, 'GET', '/assistant/inbox');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const card = r.body.items.find((a) => a.id === hb.id);
    expect(card).toBeDefined();
    const labels = card!.claims.flatMap((x) => x.evidence.map((e) => e.label));
    expect(labels.some((l) => /voice outcome|starts at/.test(l))).toBe(true);
  });

  it('E662: the task read path (workspace/repos/evidence.ts) words the same claims, and GET /tasks shows a task that cites one', async () => {
    const c = await aiCall(h, w, SCRIPTS.booking);
    const hb = (await handbacksOf(h, c.callId))[0]!;
    const fields = await fieldClaimsOf(hb.id);
    const ids = fields.map((x) => x.id);
    const actor = w.agents[0]!.actor();
    const ev = await withTenantTx(actor, (tx) => evidenceForClaims(tx, actor, w.deps.envelope, ids), { db: h.database });
    expect([...ev.values()].flat().length).toBe(ids.length);
    // a task whose source claim is the call's outcome field (the voice handback's own task carries no claim, VERIFY in
    // voice/handback.ts), so GET /tasks reaches the field evidence: before E662 this answered 500
    const outcome = fields.find((f) => f.locator.field === 'voice_outcome')!;
    const contactId = (await h.su.query<{ contact_id: string }>('SELECT contact_id FROM assistant_actions WHERE id = $1', [hb.id])).rows[0]!.contact_id;
    const taskId = randomUUID();
    await h.su.query(
      `INSERT INTO tasks (tenant_id, id, assignee_user_id, contact_id, kind, title, due_at, created_by_kind, source_action_id, source_claim_id, needs_review)
       VALUES ($1, $2, $3, $4, 'promise', 'Confirm the booked time', now() + interval '1 day', 'assistant', $5, $6, false)`,
      [w.tenantId, taskId, w.agents[0]!.userId, contactId, hb.id, outcome.id],
    );
    const t = await call<{ tasks: { id: string; source: { evidence: { label: string; locator: Record<string, unknown> }[] } | null }[] }>(w.agents[0]!, 'GET', '/tasks');
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    const task = t.body.tasks.find((x) => x.id === taskId);
    expect(task?.source?.evidence.map((e) => e.locator)).toEqual([{ kind: 'field', field: 'voice_outcome' }]);
    expect(task!.source!.evidence[0]!.label).toMatch(/^“[a-z_]+” \(voice outcome\) in the call$/);
  });

  it('E662: a missed call during an active enrollment hands back with a field claim (status), and the inbox answers 200', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    await enrolled(c.id);
    const r = await telephonyWebhook(h, '/webhooks/telephony/voice', { CallSid: sid('CA'), From: c.phone, To: w.mainNumber, CallStatus: 'no-answer', Direction: 'inbound' });
    expect(r.statusCode).toBe(200);
    const hb = (await h.su.query<{ id: string }>("SELECT id FROM assistant_actions WHERE contact_id = $1 AND kind = 'handback'", [c.id])).rows;
    expect(hb).toHaveLength(1);
    expect((await fieldClaimsOf(hb[0]!.id)).map((x) => x.locator)).toEqual([{ kind: 'field', field: 'status' }]);
    const inbox = await call<Inbox>(agent, 'GET', '/assistant/inbox');
    expect(inbox.status, JSON.stringify(inbox.body)).toBe(200);
    expect(inbox.body.items.some((a) => a.id === hb[0]!.id)).toBe(true);
  });

  it('E662: an auto-reply email during an active enrollment hands back with a header field claim, and the inbox answers 200 with it worded', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    await enrolled(c.id);
    // an upcoming appointment makes the agent's free-form email informational (R-CONSENT-5); it sets the reply token
    await h.su.query("INSERT INTO appointments (tenant_id, id, contact_id, user_id, kind, starts_at, ends_at, created_by_kind) VALUES ($1,$2,$3,$4,'consult',now() + interval '1 day',now() + interval '25 hours','user')", [w.tenantId, randomUUID(), c.id, agent.userId]);
    const sent = await call<{ result: string }>(agent, 'POST', `/contacts/${c.id}/messages`, { channel: 'email', subject: 'Showing', body: 'Here are the details.', idempotencyKey: `e-${randomUUID()}` });
    expect(sent.body.result, JSON.stringify(sent.body)).toBe('sent');
    const replyTo = h.providers.email.sent.filter((m) => m.to === c.email).at(-1)!.replyTo!;
    const r = await emailWebhook(h, '/webhooks/email/inbound', { eventId: randomUUID(), from: c.email, to: replyTo, subject: 'Out of office', text: 'I am away until Monday.', headers: { 'Auto-Submitted': 'auto-replied' } });
    expect(r.statusCode).toBe(200);
    const hb = (await h.su.query<{ id: string }>("SELECT id FROM assistant_actions WHERE contact_id = $1 AND kind = 'handback'", [c.id])).rows;
    expect(hb).toHaveLength(1);
    expect((await fieldClaimsOf(hb[0]!.id)).map((x) => x.locator)).toEqual([{ kind: 'field', field: 'header:auto-submitted' }]);
    const inbox = await call<Inbox>(agent, 'GET', '/assistant/inbox');
    expect(inbox.status, JSON.stringify(inbox.body)).toBe(200);
    const card = inbox.body.items.find((a) => a.id === hb[0]!.id);
    const claim = card?.claims.find((x) => x.evidence.some((e) => e.locator.kind === 'field'));
    expect(claim?.text).toBe('This looks like an automatic reply (Auto-Submitted: auto-replied). You can resume with one tap.');
    expect(claim!.evidence.map((e) => e.label)).toEqual(['“Auto-Submitted: auto-replied” (header:auto-submitted) in the email']);
  });
});
