// The 60-second first response (R-AST-15, R-AST-16, R-CONSENT-5, R-CONSENT-13; E8, E37), end to end:
// lead intake (api/leads) → assistant.first_response → comms.dispatch → fake provider.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { intake, zoneWithLocalHour } from '../leads/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { sendFirstResponse } from './firstResponse.js';
import { type AssistantWorld, actionsOf, approvedPlaybook, assistantWorld, assistantWorker, decisionsFor, depsOf, grantConsent, messagesOf, randomEmail, randomPhone, runJobs } from './testing.js';

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

  it('R-AST-16 E37 R-CONSENT-5: approved; a lead with no texting consent gets ONE email (never a text), signed by the team assistant with the brokerage name', async () => {
    await approvedPlaybook(w.owner, { templateKey: 'new_lead_response' });
    const email = randomEmail();
    const phone = randomPhone();
    const r = await intake(h, w, { fullName: 'Ella East', phones: [phone], emails: [email], message: 'Do you take VA loans?' });
    await runJobs(h, w.tenantId, FR);
    const ms = await messagesOf(h, r.contactId);
    expect(ms.map((m) => `${m.channel}:${m.status}:${m.initiator}:${m.action_category}`)).toEqual(['email:sent:assistant:speed_to_lead_reply']);
    expect(ms[0]!.body).toContain('Hi Ella');
    expect(ms[0]!.body).toContain('VA loan'); // the form indicated it (R-AST-12: never inferred)
    expect(ms[0]!.body).toMatch(/assistant/);
    expect(h.providers.telephony.sms.filter((s) => s.to === phone)).toHaveLength(0);
    expect(h.providers.email.sent.filter((s) => s.to === email)).toHaveLength(1);
    const a = (await actionsOf(h, r.contactId)).find((x) => x.kind === 'autonomous_message')!;
    expect(a.explanation).toMatch(/by email/);
  });

  it('R-AST-16: with an express texting basis the reply is ONE text with the STOP line; deduped per contact per 24 h; and it never counts as a touch (R-AST-15)', async () => {
    const phone = randomPhone();
    const r = await intake(h, w, { fullName: 'Sam South', phones: [phone] });
    await grantConsent(w.owner, r.contactId, 'sms');
    await runJobs(h, w.tenantId, FR);
    const ms = await messagesOf(h, r.contactId);
    expect(ms.map((m) => `${m.channel}:${m.status}`)).toEqual(['sms:sent']);
    expect(ms[0]!.body).toContain('Reply STOP to opt out');
    expect(ms[0]!.body).not.toContain('VA loan');
    expect((await decisionsFor(h, { messageId: ms[0]!.id })).map((d) => `${d.initiator}:${d.outcome}`)).toEqual(['assistant:allow']);
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

  it('R-AST-16: with no allowed channel nothing is sent and the lead card says why', async () => {
    const r = await intake(h, w, { fullName: 'Ned None', phones: [randomPhone()] });
    await runJobs(h, w.tenantId, FR);
    expect(await messagesOf(h, r.contactId)).toEqual([]);
    const cards = (await h.su.query<{ reasons: { code: string; text: string }[] }>("SELECT reasons FROM priority_feed_items WHERE contact_id = $1 AND item_type IN ('lead_offer','first_touch_due','pond_new')", [r.contactId])).rows;
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.some((c) => c.reasons.some((x) => x.code === 'NO_INSTANT_REPLY' && /no texting consent/.test(x.text)))).toBe(true);
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

describe('quiet hours (E8, R-CONSENT-13)', () => {
  it('E8 R-CONSENT-13: a lead at night gets the text DEFERRED to the next opening (09:00 her time), while an email-only lead is answered at once', async () => {
    const night = await assistantWorld(h, { agents: 1, timezone: zoneWithLocalHour(1, 5) });
    await approvedPlaybook(night.owner, { templateKey: 'new_lead_response' });
    const a = await intake(h, night, { fullName: 'Owl One', phones: [randomPhone()] });
    await grantConsent(night.owner, a.contactId, 'sms');
    const b = await intake(h, night, { fullName: 'Owl Two', emails: [randomEmail()] });
    await runJobs(h, night.tenantId, FR);
    const [sms] = await messagesOf(h, a.contactId);
    expect(sms!.status).toBe('scheduled');
    const d = (await decisionsFor(h, { messageId: sms!.id }))[0]!;
    expect(d.outcome).toBe('defer');
    expect(d.reason_codes).toContain('QUIET_HOURS_DEFERRED');
    expect(d.defer_until!.getTime()).toBeGreaterThan(Date.now() + 3_600_000);
    const [mail] = await messagesOf(h, b.contactId);
    expect(mail!.status).toBe('sent');
  });
});
