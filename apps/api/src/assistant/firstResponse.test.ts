// The 60-second first response (R-AST-15, R-AST-16; E8, E37; core-compliance/2.0.0), end to end:
// lead intake (api/leads) → assistant.first_response → comms.dispatch → fake provider.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { intake, zoneWithLocalHour } from '../leads/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { sendFirstResponse } from './firstResponse.js';
import { type AssistantWorld, actionsOf, approvedPlaybook, assistantWorld, assistantWorker, call, decisionsFor, depsOf, inboundSms, messagesOf, randomEmail, randomPhone, runJobs } from './testing.js';

let h: ApiHarness;
let w: AssistantWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await assistantWorld(h, { agents: 2 });
});
afterAll(async () => {
  await h?.close();
});

const FR = ['assistant.first_response', 'comms.dispatch'];

describe('the 60-second first response (R-AST-16)', () => {
  it('R-AST-16: with no approved new_lead_response playbook nothing is sent and no provider is called', async () => {
    const sms = h.providers.telephony.sms.length;
    const mail = h.providers.email.sent.length;
    const r = await intake(h, w, { fullName: 'Nora North', phones: [randomPhone()], emails: [randomEmail()] });
    await runJobs(h, w.tenantId, FR);
    expect(await messagesOf(h, r.contactId)).toEqual([]);
    expect(h.providers.telephony.sms.length).toBe(sms);
    expect(h.providers.email.sent.length).toBe(mail);
  });

  it('R-AST-16: approved; a new lead with a mobile number gets ONE text with the STOP line and no consent level on file (owner decision); deduped per contact per 24 h; never a touch (R-AST-15)', async () => {
    await approvedPlaybook(w.owner, { templateKey: 'new_lead_response' });
    const phone = randomPhone();
    const r = await intake(h, w, { fullName: 'Sam South', phones: [phone], emails: [randomEmail()] });
    await runJobs(h, w.tenantId, FR);
    const ms = await messagesOf(h, r.contactId);
    expect(ms.map((m) => `${m.channel}:${m.status}:${m.initiator}:${m.action_category}`)).toEqual(['sms:sent:assistant:speed_to_lead_reply']);
    expect(ms[0]!.body).toContain('Reply STOP to opt out');
    expect(ms[0]!.body).toMatch(/assistant/);
    expect(h.providers.telephony.sms.filter((x) => x.to === phone)).toHaveLength(1);
    expect(await decisionsFor(h, { messageId: ms[0]!.id })).toHaveLength(0);
    // a second run (job redelivery, a re-inquiry) inside 24 h sends nothing more
    const again = await sendFirstResponse(systemActor(w.tenantId, 'assistant'), r.contactId, depsOf(h));
    expect(again).toMatchObject({ kind: 'not_sent', reason: 'ALREADY_SENT' });
    await runJobs(h, w.tenantId, FR);
    expect(await messagesOf(h, r.contactId)).toHaveLength(1);
    // R-AST-15: no first touch, no human touch, no touch event in the ownership ledger
    const c = (await h.su.query('SELECT first_touch_at, last_human_touch_at FROM contacts WHERE id = $1', [r.contactId])).rows[0];
    expect(c).toEqual({ first_touch_at: null, last_human_touch_at: null });
    expect((await h.su.query("SELECT count(*)::int AS n FROM lead_ownership_events WHERE contact_id = $1 AND type = 'first_touch_recorded'", [r.contactId])).rows[0].n).toBe(0);
  });

  it('R-AST-16 E37: a lead whose number is recorded as "do not text" gets ONE email instead (never a text), signed by the team assistant with the brokerage name', async () => {
    const email = randomEmail();
    const phone = randomPhone();
    const r = await intake(h, w, { fullName: 'Ella East', phones: [phone], emails: [email], message: 'Do you take VA loans?' });
    const pid = (await h.su.query<{ id: string }>("SELECT id FROM contact_points WHERE contact_id = $1 AND kind = 'phone'", [r.contactId])).rows[0]!.id;
    expect((await call(w.owner, 'POST', `/contacts/${r.contactId}/consent`, { kind: 'revoke', pointId: pid, channel: 'sms', purpose: 'all', evidence: { note: 'asked for email only' } })).status).toBe(200);
    await runJobs(h, w.tenantId, FR);
    const ms = (await messagesOf(h, r.contactId)).filter((m) => m.initiator === 'assistant');
    expect(ms.map((m) => `${m.channel}:${m.status}:${m.initiator}:${m.action_category}`)).toEqual(['email:sent:assistant:speed_to_lead_reply']);
    expect(ms[0]!.body).toContain('Hi Ella');
    expect(ms[0]!.body).toContain('VA loan'); // the form indicated it (R-AST-12: never inferred)
    expect(ms[0]!.body).toMatch(/assistant/);
    expect(h.providers.telephony.sms.filter((x) => x.to === phone && !/unsubscribed|opted out/i.test(x.body))).toHaveLength(0);
    expect(h.providers.email.sent.filter((x) => x.to === email)).toHaveLength(1);
    const a = (await actionsOf(h, r.contactId)).find((x) => x.kind === 'autonomous_message')!;
    expect(a.explanation).toMatch(/by email/);
  });

  it('R-PAR-12 R-AST-16: an opt-out on a phone of the lead that was then removed still counts: the first response goes by email, never a text to the lead’s other phone', async () => {
    const email = randomEmail();
    const [first, second] = [randomPhone(), randomPhone()];
    const r = await intake(h, w, { fullName: 'Rita Removed', phones: [first, second], emails: [email] });
    const pid = (await h.su.query<{ id: string }>('SELECT id FROM contact_points WHERE contact_id = $1 AND address = $2', [r.contactId, first])).rows[0]!.id;
    expect((await call(w.owner, 'POST', `/contacts/${r.contactId}/consent`, { kind: 'revoke', pointId: pid, channel: 'sms', purpose: 'all', evidence: { note: 'asked us to stop texting' } })).status).toBe(200);
    expect((await call(w.owner, 'POST', `/contacts/${r.contactId}/points/${pid}/remove`, { reason: 'old' })).status).toBe(200);
    await runJobs(h, w.tenantId, FR);
    const ms = (await messagesOf(h, r.contactId)).filter((m) => m.initiator === 'assistant');
    expect(ms.map((m) => `${m.channel}:${m.status}:${m.action_category}`)).toEqual(['email:sent:speed_to_lead_reply']);
    expect(h.providers.telephony.sms.filter((x) => x.to === first || x.to === second)).toHaveLength(0);
    expect(h.providers.email.sent.filter((x) => x.to === email)).toHaveLength(1);
  });

  it('R-AST-16: with no allowed channel (the only number opted out) nothing is sent and the lead card says why', async () => {
    const phone = randomPhone();
    const r = await intake(h, w, { fullName: 'Ned None', phones: [phone] });
    const num = (await h.su.query<{ e164: string }>("SELECT e164 FROM phone_numbers WHERE tenant_id = $1 AND purpose = 'team_main' AND released_at IS NULL LIMIT 1", [w.tenantId])).rows[0]!.e164;
    expect((await inboundSms(h, phone, num, 'STOP')).statusCode).toBe(200);
    await runJobs(h, w.tenantId, FR);
    expect((await messagesOf(h, r.contactId)).filter((m) => m.initiator === 'assistant')).toEqual([]);
    const cards = (await h.su.query<{ reasons: { code: string; text: string }[] }>("SELECT reasons FROM priority_feed_items WHERE contact_id = $1 AND item_type IN ('lead_offer','first_touch_due','pond_new')", [r.contactId])).rows;
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.some((c) => c.reasons.some((x) => x.code === 'NO_INSTANT_REPLY' && /opted out/.test(x.text)))).toBe(true);
  });

  it('R-AST-16 p95 smoke (reduced scale, in-process): intake → sent stays far below 60 s', async () => {
    const leads: { contactId: string; t0: number }[] = [];
    for (let i = 0; i < 12; i++) {
      const t0 = Date.now();
      const r = await intake(h, w, { fullName: `Pat P${i}`, emails: [randomEmail()] });
      leads.push({ contactId: r.contactId, t0 });
    }
    const worker = assistantWorker(h);
    const deadline = Date.now() + 30_000;
    const done = new Map<string, number>();
    while (done.size < leads.length && Date.now() < deadline) {
      await worker.tick();
      for (const l of leads) {
        if (done.has(l.contactId)) continue;
        const r = await h.su.query<{ at: Date | null }>("SELECT dispatched_at AS at FROM messages WHERE contact_id = $1 AND status IN ('sent','delivered')", [l.contactId]);
        if (r.rows[0]?.at) done.set(l.contactId, Date.now() - l.t0);
      }
    }
    expect(done.size).toBe(leads.length);
    const lat = [...done.values()].sort((a, b) => a - b);
    const p95 = lat[Math.ceil(lat.length * 0.95) - 1]!;
    expect(p95).toBeLessThan(60_000);
  });
});

describe('owner decision: no quiet hours (E8)', () => {
  it('E8: a lead arriving in the middle of the recipient\'s night gets the text at once (nothing is deferred)', async () => {
    const night = await assistantWorld(h, { agents: 1, timezone: zoneWithLocalHour(1, 5) });
    await approvedPlaybook(night.owner, { templateKey: 'new_lead_response' });
    const a = await intake(h, night, { fullName: 'Owl One', phones: [randomPhone()] });
    const b = await intake(h, night, { fullName: 'Owl Two', emails: [randomEmail()] });
    await runJobs(h, night.tenantId, FR);
    const [sms] = await messagesOf(h, a.contactId);
    expect(sms!.status).toBe('sent');
    expect(await decisionsFor(h, { messageId: sms!.id })).toHaveLength(0);
    const [mail] = await messagesOf(h, b.contactId);
    expect(mail!.status).toBe('sent');
  });
});
