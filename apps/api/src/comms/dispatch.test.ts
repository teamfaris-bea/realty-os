// api/comms dispatch: the one outbound path and its send-time gate (BUILD_PLAN module 12; ARCHITECTURE §9).
import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256Hex } from '@realty/core/compliance';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { command, contactState, intake, ledger, suFixture } from '../leads/testing.js';
import { dispatchOutbound } from './dispatch.js';
import { type CommsWorld, call, commsWorld, decisionsFor, grantConsent, inboundSms, messageRow, ownedContact, pointId, randomPhone, runJobs, sendText, telephonyWebhook } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 2 });
});
afterAll(async () => {
  await h?.close();
});

const smsTo = (phone: string) => h.providers.telephony.sms.filter((m) => m.to === phone);

describe('human texts (ARCHITECTURE §9 path 1)', () => {
  it('R-GATE-10: a human text is gated at send time; an allowed send writes no gate_decisions row (0013: blocked sends only)', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent, { consent: false });
    const r = await sendText(agent, c.id, 'Hi Jane, are you free for a quick call tomorrow?');
    expect(r.status).toBe(200);
    expect(r.body.result).toBe('sent');
    expect(r.body.decision).toEqual({ id: null, outcome: 'allow', reasons: [], explanation: 'OK to send', phase: 'send' });
    expect(smsTo(c.phone)).toHaveLength(1);
    const m = await messageRow(h, r.body.message!.id);
    expect(m.status).toBe('sent');
    expect(m.dispatched_at).not.toBeNull();
    expect(m.gate_decision_id).toBeNull();
    expect(await decisionsFor(h, { messageId: r.body.message!.id })).toHaveLength(0);
  });

  it('owner decision: no consent level is needed: a contact with no consent on file, an imported-only basis or an expired inquiry is texted by a human (marketing too)', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent, { consent: false });
    expect((await sendText(agent, c.id, 'New listings just hit your area this week.')).body.result).toBe('sent');
    expect((await sendText(agent, c.id, 'Are you free Thursday?')).body.result).toBe('sent');
    expect(smsTo(c.phone)).toHaveLength(2);
  });

  it('R-GATE-11: a blocked send writes its gate_decisions row (policy, rules version, plaintext-free inputs, digest) and the message links it', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const pid = await pointId(h, c.id, 'phone');
    expect((await call(agent, 'POST', `/contacts/${c.id}/consent`, { kind: 'revoke', pointId: pid, channel: 'sms', purpose: 'all', evidence: {} })).status).toBe(200);
    const r = await sendText(agent, c.id, 'Hi Jane');
    const ds = await decisionsFor(h, { messageId: r.body.message!.id });
    expect(ds).toHaveLength(1);
    const d = ds[0]!;
    expect((await messageRow(h, r.body.message!.id)).gate_decision_id).toBe(d.id);
    expect(r.body.decision!.id).toBe(d.id);
    expect([d.phase, d.outcome]).toEqual(['send', 'deny']);
    expect(d.core_rules_version).toMatch(/^core-compliance\/2\./);
    expect(d.policy_version_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(d.inputs_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(d.inputs_sha256).toBe(sha256Hex(canonicalJson(d.inputs)));
    // R-CONSENT-1 / R-GATE-11: no plaintext address in the decision inputs
    const inputs = JSON.stringify(d.inputs);
    expect(inputs).not.toContain(c.phone);
    expect(inputs).not.toContain(c.phone.slice(2));
  });

  it('R-GATE-10 R-GATE-6: an opted-out address is denied for a human with no override, and the provider fake is never called', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const pid = await pointId(h, c.id, 'phone');
    expect((await call(agent, 'POST', `/contacts/${c.id}/consent`, { kind: 'revoke', pointId: pid, channel: 'sms', purpose: 'all', evidence: {} })).status).toBe(200);
    const r = await sendText(agent, c.id, 'Hi Jane, following up');
    expect(r.body.result).toBe('blocked');
    expect(r.body.decision!.outcome).toBe('deny');
    expect(r.body.decision!.reasons).toContain('CONSENT_REVOKED');
    expect(r.body.decision!.explanation).toMatch(/opted out/i);
    expect(smsTo(c.phone)).toHaveLength(0);
    const m = await messageRow(h, r.body.message!.id);
    expect(m.status).toBe('blocked');
    expect(m.gate_decision_id).not.toBeNull();
    // the contact timeline says it was not sent (the thread never draws a blocked text as sent)
    const t = await call<{ items: { id: string; type: string; status: string | null }[] }>(agent, 'GET', `/contacts/${c.id}/timeline`);
    expect(t.body.items.find((i) => i.id === r.body.message!.id)).toMatchObject({ type: 'message', status: 'blocked' });
    expect(t.body.items.filter((i) => i.type !== 'message').every((i) => i.status === null)).toBe(true);
  });

  it('R-GATE-7: payment or wire instructions are denied for every initiator with the safety sentence', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const r = await sendText(agent, c.id, 'Please wire the deposit: routing 021000021 account 12345678');
    expect(r.body.decision!.reasons).toContain('PAYMENT_INSTRUCTIONS');
    expect(r.body.decision!.explanation).toContain("wiring details can't be sent");
    expect(smsTo(c.phone)).toHaveLength(0);
  });

  it('R-GATE-12: a marketing text renders the brokerage legal name (appended when missing) and is allowed only then', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const r = await sendText(agent, c.id, 'New listings just hit your area this week.');
    expect(r.body.result).toBe('sent');
    expect(r.body.message!.body).toMatch(/\n— .+$/);
    const brokerage = (await h.su.query<{ n: string }>('SELECT brokerage_legal_name AS n FROM tenant_settings WHERE tenant_id = $1', [w.tenantId])).rows[0]!.n;
    expect(smsTo(c.phone)[0]!.body).toContain(brokerage);
    expect(await decisionsFor(h, { messageId: r.body.message!.id })).toHaveLength(0);
  });

  it('owner decision: there are no manual-text caps and nothing waits for a confirmation; a stale confirmDecisionId is rejected as an unknown field', async () => {
    const agent = w.agents[1]!;
    const c = await ownedContact(agent);
    for (let i = 0; i < 6; i++) expect((await sendText(agent, c.id, `Message ${i}`)).body.result).toBe('sent');
    expect(smsTo(c.phone)).toHaveLength(6);
    expect((await sendText(agent, c.id, 'One more thing', { confirmDecisionId: randomUUID() })).status).toBe(422);
  });

  it('R-CONSENT-7: a STOP texted from another of the contact\'s phones blocks texting this one too, with no override', async () => {
    const agent = w.agents[0]!;
    const first = randomPhone();
    const second = randomPhone();
    const cr = await call<{ contact: { id: string } }>(agent, 'POST', '/contacts', { commandId: randomUUID(), firstName: 'Two', lastName: 'Phones', phones: [first, second], emails: [] });
    expect([200, 201]).toContain(cr.status);
    const id = cr.body.contact.id;
    expect((await sendText(agent, id, 'Hi there')).body.result).toBe('sent');
    expect((await inboundSms(h, second, w.mainNumber, 'STOP')).statusCode).toBe(200);
    const r = await sendText(agent, id, 'Still interested?');
    expect(r.body.result).toBe('blocked');
    expect(r.body.decision!.reasons).toContain('CONSENT_REVOKED');
    expect(smsTo(first)).toHaveLength(1);
    expect(smsTo(first)[0]!.body).toMatch(/^Hi there/);
  });

  it('R-PERM-5: texting a contact the agent cannot see is 404', async () => {
    const other = w.agents[1]!;
    const c = await ownedContact(w.agents[0]!);
    expect((await sendText(other, c.id, 'hi')).status).toBe(404);
  });
});

describe('touch (R-OWN-14)', () => {
  it('R-OWN-14: the gate-allowed human text records the first touch in the dispatch transaction (touch instant = TX1 dispatched_at)', async () => {
    const lead = await intake(h, w, { fullName: 'Tina Touch' });
    const st = await contactState(h, lead.contactId);
    const agent = w.agents.find((a) => a.userId === st.offered_to_user_id)!;
    expect((await command(agent, lead.contactId, 'accept', { offerId: st.offer_id })).status).toBe(200);
    await grantConsent(agent, lead.contactId, 'sms');
    const r = await sendText(agent, lead.contactId, 'Hi Tina, thanks for reaching out!');
    expect(r.body.result).toBe('sent');
    const after = await contactState(h, lead.contactId);
    const m = await messageRow(h, r.body.message!.id);
    expect((after as unknown as { first_touch_at: Date }).first_touch_at?.getTime()).toBe(m.dispatched_at!.getTime());
    expect((await ledger(h, lead.contactId)).map((e) => e.type)).toContain('first_touch_recorded');
  });
});

describe('scheduled human texts (path 2)', () => {
  it('a scheduled text is checked at send time and needs no gate decision row to go', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const at = new Date(Date.now() + 3600_000).toISOString();
    const r = await sendText(agent, c.id, 'Reminder: open house Saturday', { scheduleAt: at });
    expect(r.body.result).toBe('scheduled');
    expect(await decisionsFor(h, { messageId: r.body.message!.id })).toHaveLength(0);
    await h.su.query("UPDATE messages SET scheduled_for = now() - interval '1 second' WHERE id = $1", [r.body.message!.id]);
    await runJobs(h, w.tenantId, ['comms.dispatch']);
    const m = await messageRow(h, r.body.message!.id);
    expect(m.status).toBe('sent');
    expect(await decisionsFor(h, { messageId: r.body.message!.id })).toHaveLength(0);
    expect(smsTo(c.phone)).toHaveLength(1);
  });

  it('a scheduled text to a number that opts out before send time never goes (the opt-out cancels it; the send-time check would block it too)', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const r = await sendText(agent, c.id, 'Open house Sunday', { scheduleAt: new Date(Date.now() + 3600_000).toISOString() });
    const pid = await pointId(h, c.id, 'phone');
    expect((await call(agent, 'POST', `/contacts/${c.id}/consent`, { kind: 'revoke', pointId: pid, channel: 'sms', purpose: 'all', evidence: {} })).status).toBe(200);
    await h.su.query("UPDATE messages SET scheduled_for = now() - interval '1 second' WHERE id = $1", [r.body.message!.id]);
    await runJobs(h, w.tenantId, ['comms.dispatch']);
    const m = await messageRow(h, r.body.message!.id);
    expect(['canceled:OPTED_OUT', 'blocked:CONSENT_REVOKED']).toContain(`${m.status}:${m.status_reason}`);
    expect(smsTo(c.phone)).toHaveLength(0);
  });

  it('E27: the client replied after the agent scheduled a text: it is not sent and needs a re-tap; the re-tap sends it', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const r = await sendText(agent, c.id, 'Following up on the house', { scheduleAt: new Date(Date.now() + 3600_000).toISOString() });
    expect((await inboundSms(h, c.phone, w.mainNumber, 'Actually we found a place')).statusCode).toBe(200);
    await h.su.query("UPDATE messages SET scheduled_for = now() - interval '1 second' WHERE id = $1", [r.body.message!.id]);
    await runJobs(h, w.tenantId, ['comms.dispatch']);
    const m = await messageRow(h, r.body.message!.id);
    expect(m.status).toBe('queued');
    expect(m.status_reason).toBe('CLIENT_REPLIED_SINCE_SCHEDULED');
    expect(smsTo(c.phone)).toHaveLength(0);
    const re = await call<{ result: string }>(agent, 'POST', `/messages/${r.body.message!.id}/send`, {});
    expect(re.body.result).toBe('sent');
    expect(smsTo(c.phone)).toHaveLength(1);
  });

  it('E15: the old owner\'s scheduled text is blocked at send time once the lead moved (SENDER_NOT_AUTHORIZED); the new owner gets it as a suggested draft; nothing reaches the client', async () => {
    const [a, b] = w.agents as [typeof w.agents[0], typeof w.agents[0]];
    const c = await ownedContact(a);
    const r = await sendText(a, c.id, 'See you Saturday at 10', { scheduleAt: new Date(Date.now() + 3600_000).toISOString() });
    await (await import('../admin/testing.js')).freshReauth(h, w.owner);
    expect((await command(w.owner, c.id, 'reassign', { toUserId: b.userId, reason: 'MANUAL_REASSIGN' })).status).toBe(200);
    await h.su.query("UPDATE messages SET scheduled_for = now() - interval '1 second' WHERE id = $1", [r.body.message!.id]);
    await runJobs(h, w.tenantId, ['comms.dispatch']);
    const m = await messageRow(h, r.body.message!.id);
    expect(m.status).toBe('blocked');
    expect(m.status_reason).toBe('SENDER_NOT_AUTHORIZED');
    expect(smsTo(c.phone)).toHaveLength(0);
    const d = (await decisionsFor(h, { messageId: r.body.message!.id }))[0]!;
    expect(d.outcome).toBe('deny');
    expect(d.reason_codes[0]).toBe('SENDER_NOT_AUTHORIZED');
    // integrity-2 / R-GATE-11: the stored digest is the digest of the stored inputs, API-level reasons included
    expect(d.inputs.dispatchReasons).toEqual(['SENDER_NOT_AUTHORIZED']);
    expect(d.inputs_sha256).toBe(sha256Hex(canonicalJson(d.inputs)));
    const drafts = await h.su.query("SELECT owner_user_id, kind FROM assistant_actions WHERE contact_id = $1 AND kind = 'message_draft'", [c.id]);
    expect(drafts.rows).toEqual([{ owner_user_id: b.userId, kind: 'message_draft' }]);
  });
});

describe('dispatch_unknown and reconciliation (R-GATE-8, E7)', () => {
  it('R-GATE-8 E7: a provider timeout after submit becomes dispatch_unknown (never resent); reconciliation by idempotency key finds it and marks it sent', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    h.providers.telephony.failNext('timeout_after_submit');
    const r = await sendText(agent, c.id, 'Hello from the timeout test');
    expect(r.body.result).toBe('dispatch_unknown');
    expect((await messageRow(h, r.body.message!.id)).status).toBe('dispatch_unknown');
    // a re-run of the dispatch never re-sends (only scheduled/queued messages are claimed)
    expect((await dispatchOutbound(r.body.message!.id, w.deps, { tenantId: w.tenantId })).kind).toBe('noop');
    await runJobs(h, w.tenantId, ['comms.reconcile']);
    const m = await messageRow(h, r.body.message!.id);
    expect(m.status).toBe('sent');
    expect(m.provider_message_ref).not.toBeNull();
    expect(smsTo(c.phone)).toHaveLength(1);
  });

  it('R-GATE-8: a submit the provider never saw stays unknown for up to 10 minutes, then fails with a human Retry (no blind resend)', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    h.providers.telephony.failNext('timeout');
    const r = await sendText(agent, c.id, 'Lost in transit');
    expect(r.body.result).toBe('dispatch_unknown');
    await runJobs(h, w.tenantId, ['comms.reconcile']);
    expect((await messageRow(h, r.body.message!.id)).status).toBe('dispatch_unknown');
    await h.su.query("UPDATE messages SET dispatched_at = now() - interval '11 minutes' WHERE id = $1", [r.body.message!.id]);
    await runJobs(h, w.tenantId, ['comms.reconcile']);
    const m = await messageRow(h, r.body.message!.id);
    expect(m.status).toBe('failed');
    expect(m.status_reason).toBe('DISPATCH_UNKNOWN_UNRESOLVED');
    expect(smsTo(c.phone)).toHaveLength(0);
  });

  it('R-GATE-8: status callbacks only move forward and are idempotent; a carrier opt-out error is a provider_report revoke (R-CONSENT-12)', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const r = await sendText(agent, c.id, 'Status test');
    const ref = (await messageRow(h, r.body.message!.id)).provider_message_ref!;
    const cb = (status: string, extra: Record<string, string> = {}) => telephonyWebhook(h, `/webhooks/telephony/status?m=${r.body.message!.id}`, { MessageSid: ref, MessageStatus: status, From: w.mainNumber, To: c.phone, ...extra });
    expect((await cb('delivered')).statusCode).toBe(200);
    expect((await cb('sent')).statusCode).toBe(200); // late, out of order
    expect((await cb('delivered')).statusCode).toBe(200); // duplicate
    expect((await messageRow(h, r.body.message!.id)).status).toBe('delivered');
    const evs = await h.su.query('SELECT mapped_status FROM message_status_events WHERE message_id = $1 ORDER BY received_at', [r.body.message!.id]);
    expect(evs.rows.map((x) => x.mapped_status)).toEqual(['delivered', 'sent']);

    const r2 = await sendText(agent, c.id, 'Second');
    const ref2 = (await messageRow(h, r2.body.message!.id)).provider_message_ref!;
    await telephonyWebhook(h, `/webhooks/telephony/status?m=${r2.body.message!.id}`, { MessageSid: ref2, MessageStatus: 'undelivered', ErrorCode: '21610', From: w.mainNumber, To: c.phone });
    expect((await messageRow(h, r2.body.message!.id)).status).toBe('undelivered');
    const st = await h.su.query("SELECT status FROM consent_state WHERE channel = 'sms' AND address_hmac = (SELECT address_hmac FROM contact_points WHERE contact_id = $1 AND kind = 'phone')", [c.id]);
    expect(st.rows.every((x) => x.status === 'revoked')).toBe(true);
    const src = await h.su.query("SELECT source FROM consent_events WHERE contact_id = $1 AND event_type = 'revoke'", [c.id]);
    expect(src.rows.map((x) => x.source)).toEqual(['provider_report']);
    expect((await sendText(agent, c.id, 'Third')).body.decision!.reasons).toContain('CONSENT_REVOKED');
  });
});

describe('imports (path 10)', () => {
  it('R-GATE-10: imported history never calls a provider (dispatch is a no-op)', async () => {
    const c = await ownedContact(w.agents[0]!);
    const batch = randomUUID();
    const stage = randomUUID();
    const rec = randomUUID();
    const conv = randomUUID();
    const mid = randomUUID();
    await suFixture(h, [
      { text: "INSERT INTO import_batches (tenant_id, id, source, status, created_by_user_id) VALUES ($1,$2,'csv','connection_test',$3)", values: [w.tenantId, batch, w.owner.userId] },
      { text: "INSERT INTO import_stages (tenant_id, id, batch_id, category, seq, status) VALUES ($1,$2,$3,'messages',4,'pending')", values: [w.tenantId, stage, batch] },
      { text: "INSERT INTO import_records (tenant_id, id, stage_id, source_ref, outcome, raw_purged_at) VALUES ($1,$2,$3,'r1','will_import',now())", values: [w.tenantId, rec, stage] },
      { text: 'INSERT INTO conversations (tenant_id, id, contact_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', values: [w.tenantId, conv, c.id] },
      { text: "INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, from_address, to_address, body, status, initiator, imported, import_record_id, occurred_at) SELECT $1,$2,id,$3,'sms','outbound','+14155550000',$4,'old text','queued','import',true,$5,now() FROM conversations WHERE contact_id = $3", values: [w.tenantId, mid, c.id, c.phone, rec] },
    ]);
    expect((await dispatchOutbound(mid, w.deps, { tenantId: w.tenantId })).kind).toBe('noop');
    expect(smsTo(c.phone)).toHaveLength(0);
  });
});
