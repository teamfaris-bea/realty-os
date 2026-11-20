// The stage an outcome suggests, through the two outcome routes (R-STG-2, E759 to E761): POST /contacts/:id/activities
// and POST /calls/:id/outcome answer `suggestedStage` and never change the stage themselves.
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type CommsWorld, call, commsWorld, ownedContact, randomPhone } from '../comms/testing.js';
import { command, contactState, intake } from '../leads/testing.js';
import { suggestedStageInTx } from './stageSuggestion.js';

let h: ApiHarness;
let w: CommsWorld;
let agent: TestClient;
let agent2: TestClient;
let tc: TestClient;

type Suggested = { stage: string; why: string; locked: boolean; alsoOffer: { stage: string; locked: boolean }[] } | null;
type ActivityRes = { note: { id: string }; replayed: boolean; suggestedStage: Suggested };
type OutcomeRes = { callId: string; outcome: string; recordedAs: string; suggestedStage: Suggested };

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 2, teamLead: true, others: ['tc'] });
  [agent, agent2] = w.agents as [TestClient, TestClient];
  [tc] = w.others as [TestClient];
  for (const a of w.agents) {
    // an agent needs a verified phone of their own to place a call (the bridge rings them first)
    const ch = await a.post('/api/me/alert-phone', { phone: randomPhone() });
    const code = h.providers.telephony.verificationCodes.at(-1)!.code;
    const r = await a.post('/api/me/alert-phone/verify', { challenge: (ch.json() as { challenge: string }).challenge, code });
    if (r.statusCode !== 200) throw new Error(`alert phone: ${r.statusCode} ${r.body}`);
  }
}, 240_000);
afterAll(async () => {
  await h?.close();
});

const log = (by: TestClient, contactId: string, body: Record<string, unknown>) => call<ActivityRes>(by, 'POST', `/contacts/${contactId}/activities`, { at: new Date().toISOString(), ...body });
const stageOf = async (id: string) => (await h.su.query<{ stage: string }>('SELECT stage FROM contacts WHERE id = $1', [id])).rows[0]!.stage;
const stageEvents = async (id: string) => (await h.su.query<{ n: number }>('SELECT count(*)::int AS n FROM contact_stage_events WHERE contact_id = $1', [id])).rows[0]!.n;
const setStage = (by: TestClient, id: string, stage: string) => call<{ stage: { stage: string } }>(by, 'POST', `/contacts/${id}/stage`, { stage });

/** A routed lead the offeree accepted: owned, first-touch SLA running, untouched (R-PAR-14 locks the later stages). */
async function routedUntouched(): Promise<{ id: string; owner: TestClient }> {
  const r = await intake(h, w);
  const st = await contactState(h, r.contactId);
  if (st.ownership_state !== 'offered') throw new Error(`not offered: ${st.ownership_state}`);
  const owner = w.agents.find((a) => a.userId === st.offered_to_user_id)!;
  const acc = await command(owner, r.contactId, 'accept', { offerId: st.offer_id, expectedSeq: Number(st.ownership_seq) });
  if (acc.status !== 200) throw new Error(`accept ${acc.status} ${JSON.stringify(acc.body)}`);
  return { id: r.contactId, owner };
}

async function dialAndLog(by: TestClient, contactId: string, outcome: string) {
  const d = await call<{ result: string; callId: string | null }>(by, 'POST', `/contacts/${contactId}/calls`, {});
  if (d.body.result !== 'dialing' || !d.body.callId) throw new Error(`dial: ${d.status} ${JSON.stringify(d.body)}`);
  return call<OutcomeRes>(by, 'POST', `/calls/${d.body.callId}/outcome`, { outcome });
}

describe('POST /contacts/:id/activities answers the suggested stage (R-STG-2)', () => {
  it('R-STG-2 E759 a logged voicemail on a new lead suggests "attempting" with a reason; the stage itself does not change', async () => {
    const c = await ownedContact(agent, { consent: false });
    const r = await log(agent, c.id, { kind: 'call', outcome: 'left_voicemail' });
    expect(r.status).toBe(201);
    expect(r.body.suggestedStage).toEqual({ stage: 'attempting', why: expect.stringMatching(/voicemail/i), locked: false, alsoOffer: [] });
    // the route never changes the stage: no stage write, no stage event
    expect(await stageOf(c.id)).toBe('new');
    expect(await stageEvents(c.id)).toBe(0);
  });

  it('R-STG-2 the table through the route: sent with no reply, their reply, talked, wrong number, no outcome, their voicemail to us', async () => {
    const fresh = async () => (await ownedContact(agent, { consent: false })).id;
    const got: Record<string, string | null> = {};
    const cases: [string, Record<string, unknown>][] = [
      ['call no_answer', { kind: 'call', outcome: 'no_answer' }],
      ['call other', { kind: 'call', outcome: 'other' }],
      ['call connected', { kind: 'call', outcome: 'connected' }],
      ['call wrong_number', { kind: 'call', outcome: 'wrong_number' }],
      // a call logged with no outcome says nothing about what happened
      ['call no outcome', { kind: 'call' }],
      ['text sent', { kind: 'text', direction: 'outbound' }],
      ['email sent', { kind: 'email' }],
      ['text reply', { kind: 'text', direction: 'inbound' }],
      ['email reply', { kind: 'email', direction: 'inbound' }],
      // they called and we talked: a conversation. They called and left US a voicemail, or we missed it: not our try
      ['inbound call connected', { kind: 'call', direction: 'inbound', outcome: 'connected' }],
      ['inbound call left_voicemail', { kind: 'call', direction: 'inbound', outcome: 'left_voicemail' }],
      ['inbound call no_answer', { kind: 'call', direction: 'inbound', outcome: 'no_answer' }],
    ];
    for (const [name, body] of cases) {
      const id = await fresh();
      const r = await log(agent, id, body);
      expect(r.status, name).toBe(201);
      got[name] = r.body.suggestedStage?.stage ?? null;
      expect(await stageOf(id), name).toBe('new');
    }
    expect(got).toEqual({
      'call no_answer': 'attempting',
      'call other': 'attempting',
      'call connected': 'connected',
      'call wrong_number': null,
      'call no outcome': null,
      'text sent': 'attempting',
      'email sent': 'attempting',
      'text reply': 'connected',
      'email reply': 'connected',
      'inbound call connected': 'connected',
      'inbound call left_voicemail': null,
      'inbound call no_answer': null,
    });
  });

  it('R-STG-2 E760 never a stage earlier than the current one, and a conversation never suggests "active"', async () => {
    const c = await ownedContact(agent, { consent: false });
    expect((await setStage(agent, c.id, 'connected')).status).toBe(200);
    expect((await log(agent, c.id, { kind: 'call', outcome: 'left_voicemail' })).body.suggestedStage).toBeNull();
    expect((await log(agent, c.id, { kind: 'call', outcome: 'connected' })).body.suggestedStage).toBeNull();
    expect((await log(agent, c.id, { kind: 'text', direction: 'inbound' })).body.suggestedStage).toBeNull();
    expect(await stageOf(c.id)).toBe('connected');
  });

  it('R-STG-2 E761 R-PAR-14 a suggestion the stage rule would refuse is marked locked (a logged outside call never unlocks a routed, untouched lead)', async () => {
    const lead = await routedUntouched();
    const talked = await log(lead.owner, lead.id, { kind: 'call', outcome: 'connected' });
    expect(talked.body.suggestedStage).toEqual({ stage: 'connected', why: expect.any(String), locked: true, alsoOffer: [{ stage: 'nurture', locked: true }] });
    // locked says exactly what the stage route would do with it
    const refuse = await setStage(lead.owner, lead.id, 'connected');
    expect(refuse.status).toBe(409);
    expect(refuse.code).toBe('STAGE_NEEDS_CONTACT');
    // "attempting" is always open, so that suggestion is not locked, and the route takes it
    const tried = await log(lead.owner, lead.id, { kind: 'call', outcome: 'left_voicemail' });
    expect(tried.body.suggestedStage).toEqual({ stage: 'attempting', why: expect.any(String), locked: false, alsoOffer: [] });
    expect((await setStage(lead.owner, lead.id, 'attempting')).status).toBe(200);
    // a Team Lead is not held by the rule: the same suggestion is not locked for them
    const tl = await log(w.teamLead!, lead.id, { kind: 'call', outcome: 'connected' });
    expect(tl.body.suggestedStage).toEqual({ stage: 'connected', why: expect.any(String), locked: false, alsoOffer: [{ stage: 'nurture', locked: false }] });
  });

  it('L12 E790 a log saved with "remind me" and replayed (a retry after a lost answer) answers the SAME reminder task, never null and never a second task; a log saved without one answers none', async () => {
    const c = await ownedContact(agent, { consent: false });
    const noteId = randomUUID();
    const first = await log(agent, c.id, { kind: 'call', outcome: 'no_answer', remindInDays: 2, noteId });
    expect(first.status).toBe(201);
    const taskId = (first.body as unknown as { taskId: string | null }).taskId;
    expect(taskId).toMatch(/^[0-9a-f-]{36}$/);
    // the retry: the body may even ask for another reminder; the stored note and its one task are the answer
    const again = await log(agent, c.id, { kind: 'call', outcome: 'no_answer', remindInDays: 7, noteId });
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect((again.body as unknown as { taskId: string | null }).taskId).toBe(taskId);
    expect((await h.su.query<{ id: string }>('SELECT id FROM tasks WHERE contact_id = $1', [c.id])).rows).toEqual([{ id: taskId }]);
    // no reminder first time: none on the replay, and the replay makes none
    const plain = randomUUID();
    const p1 = await log(agent, c.id, { kind: 'call', outcome: 'no_answer', noteId: plain });
    const p2 = await log(agent, c.id, { kind: 'call', outcome: 'no_answer', remindInDays: 3, noteId: plain });
    expect([(p1.body as unknown as { taskId: string | null }).taskId, (p2.body as unknown as { taskId: string | null }).taskId]).toEqual([null, null]);
    expect((await h.su.query('SELECT count(*)::int AS n FROM tasks WHERE contact_id = $1', [c.id])).rows[0].n).toBe(1);
    // another member's replay of that id is refused as before, and learns nothing about the task
    const other = await log(agent2, c.id, { kind: 'call', outcome: 'no_answer', noteId });
    expect(other.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(other.body)).not.toContain(taskId!);
  });

  it('R-STG-2 E766 a replay of the same log (a double tap) answers the same suggestion until the stage is confirmed, then none', async () => {
    const c = await ownedContact(agent, { consent: false });
    const noteId = randomUUID();
    const first = await log(agent, c.id, { kind: 'call', outcome: 'no_answer', noteId });
    const again = await log(agent, c.id, { kind: 'call', outcome: 'no_answer', noteId });
    expect([first.status, again.status]).toEqual([201, 200]);
    expect(again.body.replayed).toBe(true);
    expect(again.body.suggestedStage).toEqual(first.body.suggestedStage);
    expect(first.body.suggestedStage?.stage).toBe('attempting');
    expect((await setStage(agent, c.id, 'attempting')).status).toBe(200);
    expect((await log(agent, c.id, { kind: 'call', outcome: 'no_answer', noteId })).body.suggestedStage).toBeNull();
    expect((await h.su.query('SELECT count(*)::int AS n FROM notes WHERE contact_id = $1', [c.id])).rows[0].n).toBe(1);
  });
});

describe('a two-way conversation also offers "Long-term follow-up" (R-STG-2)', () => {
  type Offer = { suggestedStage: { stage: string; alsoOffer: { stage: string; locked: boolean }[] } | null };
  it('R-STG-2 a logged conversation or reply offers nurture beside connected; a voicemail and a callback request offer nothing more; the stage is never changed', async () => {
    const fresh = async () => (await ownedContact(agent, { consent: false })).id;
    const talked = await fresh();
    const a = await call<Offer>(agent, 'POST', `/contacts/${talked}/activities`, { kind: 'call', outcome: 'connected', at: new Date().toISOString() });
    expect(a.body.suggestedStage).toMatchObject({ stage: 'connected', alsoOffer: [{ stage: 'nurture', locked: false }] });
    const replied = await fresh();
    const b = await call<Offer>(agent, 'POST', `/contacts/${replied}/activities`, { kind: 'text', direction: 'inbound', at: new Date().toISOString() });
    expect(b.body.suggestedStage).toMatchObject({ stage: 'connected', alsoOffer: [{ stage: 'nurture', locked: false }] });
    const tried = await fresh();
    const c = await call<Offer>(agent, 'POST', `/contacts/${tried}/activities`, { kind: 'call', outcome: 'left_voicemail', at: new Date().toISOString() });
    expect(c.body.suggestedStage).toMatchObject({ stage: 'attempting', alsoOffer: [] });
    // through the call route too
    const d = (await dialAndLog(agent, await fresh(), 'connected')).body as unknown as Offer;
    expect(d.suggestedStage).toMatchObject({ stage: 'connected', alsoOffer: [{ stage: 'nurture', locked: false }] });
    const e = (await dialAndLog(agent, await fresh(), 'callback_requested')).body as unknown as Offer;
    expect(e.suggestedStage).toMatchObject({ stage: 'connected', alsoOffer: [] });
    for (const id of [talked, replied, tried]) expect(await stageOf(id)).toBe('new');
  });

  it('R-STG-2 E761 R-PAR-14 the extra offer is locked exactly when the stage rule would refuse it', async () => {
    const lead = await routedUntouched();
    const r = await call<Offer>(lead.owner, 'POST', `/contacts/${lead.id}/activities`, { kind: 'call', outcome: 'connected', at: new Date().toISOString() });
    expect(r.body.suggestedStage).toMatchObject({ stage: 'connected', alsoOffer: [{ stage: 'nurture', locked: true }] });
    expect((await setStage(lead.owner, lead.id, 'nurture')).code).toBe('STAGE_NEEDS_CONTACT');
    const tl = await call<Offer>(w.teamLead!, 'POST', `/contacts/${lead.id}/activities`, { kind: 'call', outcome: 'connected', at: new Date().toISOString() });
    expect(tl.body.suggestedStage).toMatchObject({ stage: 'connected', alsoOffer: [{ stage: 'nurture', locked: false }] });
  });
});

describe('POST /calls/:id/outcome answers the suggested stage (R-STG-2)', () => {
  it('R-STG-2 E759 a voicemail suggests "attempting", a conversation "connected", a callback request "connected"; the stage does not change', async () => {
    const got: Record<string, string | null> = {};
    for (const outcome of ['left_voicemail', 'no_answer', 'connected', 'callback_requested']) {
      const c = await ownedContact(agent, { consent: false });
      const r = await dialAndLog(agent, c.id, outcome);
      expect(r.status, outcome).toBe(200);
      expect(r.body).toMatchObject({ outcome, recordedAs: 'call' });
      got[outcome] = r.body.suggestedStage?.stage ?? null;
      if (r.body.suggestedStage) expect(r.body.suggestedStage).toEqual({ stage: expect.any(String), why: expect.any(String), locked: false, alsoOffer: outcome === 'connected' ? [{ stage: 'nurture', locked: false }] : [] });
      expect(await stageOf(c.id), outcome).toBe('new');
      expect(await stageEvents(c.id), outcome).toBe(0);
    }
    expect(got).toEqual({ left_voicemail: 'attempting', no_answer: 'attempting', connected: 'connected', callback_requested: 'connected' });
  });

  it('R-STG-2 a wrong number, a bad number and a do-not-call request suggest nothing (each has its own path)', async () => {
    for (const outcome of ['wrong_number', 'bad_number', 'do_not_call_request']) {
      const c = await ownedContact(agent, { consent: false });
      const r = await dialAndLog(agent, c.id, outcome);
      expect(r.status, outcome).toBe(200);
      expect(r.body.suggestedStage, outcome).toBeNull();
      expect(await stageOf(c.id), outcome).toBe('new');
    }
  });

  it('R-STG-2 R-PERM-7 an outcome handed to the new owner (the lead moved during the call) suggests nothing to the agent who no longer sees the person', async () => {
    const c = await ownedContact(agent, { consent: false });
    const d = await call<{ callId: string }>(agent, 'POST', `/contacts/${c.id}/calls`, {});
    await (await import('../admin/testing.js')).freshReauth(h, w.owner);
    expect((await call(w.owner, 'POST', `/leads/${c.id}/reassign`, { commandId: randomUUID(), toUserId: agent2.userId, reason: 'MANUAL_REASSIGN' })).status).toBe(200);
    const out = await call<OutcomeRes>(agent, 'POST', `/calls/${d.body.callId}/outcome`, { outcome: 'connected' });
    expect(out.status).toBe(200);
    expect(out.body.recordedAs).toBe('task_for_current_owner');
    expect(out.body.suggestedStage).toBeNull();
  });
});

describe('who a stage is suggested to (R-STG-2)', () => {
  it('R-STG-2 R-PERM-5 nothing is suggested to someone who does not see the person, or who sees them but may not change their stage (a TC on the deal)', async () => {
    const c = await ownedContact(agent, { consent: false });
    const signal = { kind: 'call' as const, outcome: 'connected' as const };
    const as = (who: TestClient) => withTenantTx(who.actor(), (tx) => suggestedStageInTx(tx, who.actor(), c.id, signal), { db: h.database });
    expect(await as(agent)).toEqual({ stage: 'connected', why: expect.any(String), locked: false, alsoOffer: [{ stage: 'nurture', locked: false }] });
    expect(await as(agent2)).toBeNull();
    // a TC on the person's deal sees the detail (and may call for the deal) but has no contact.edit
    const deal = await call<{ deal: { id: string } }>(agent, 'POST', '/deals', { primaryContactId: c.id, side: 'buy', name: 'Elm St purchase' });
    expect(deal.status).toBe(201);
    expect((await call(agent, 'POST', `/deals/${deal.body.deal.id}/members`, { userId: tc.userId, role: 'tc' })).status).toBe(200);
    expect((await call(tc, 'GET', `/contacts/${c.id}/details`)).status).toBe(200);
    expect(await as(tc)).toBeNull();
  });
});
