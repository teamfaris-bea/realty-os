// Module 48: opt-outs heard in an AI call and the confirmation draft (R-VOICE-18, R-VOICE-17, D1, R-PAR-12,
// R-CONSENT-7, R-CONSENT-8, R-CHAN-3, R-GATE-14; E112).
import { randomUUID } from 'node:crypto';
import { SCRIPTS, SCRIPT_EVENTS as ev, SLOT_A, SLOT_ARGS } from '@realty/core/voice/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call } from '../admin/testing.js';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { inboundSms, ownedContact, randomEmail } from '../comms/testing.js';
import { type VoiceWorld, aiCall, handbacksOf, ledgerOf, setVoicePack, settled, voiceWorld } from './testing.js';

let h: ApiHarness;
let w: VoiceWorld;
beforeAll(async () => {
  h = await createApiHarness();
  await setVoicePack(h, { reviewed: true, vendorReady: true });
  w = await voiceWorld(h);
});
afterAll(async () => {
  await h?.close();
});

const consentOf = (contactId: string) =>
  h.su.query("SELECT channel, event_type, source, needs_review, evidence_call_id, evidence_message_id, encode(address_hmac, 'hex') AS hmac FROM consent_events WHERE contact_id = $1 AND event_type = 'revoke' ORDER BY channel", [contactId]).then((r) => r.rows);
const hmacOf = (contactId: string, kind: string) => h.su.query("SELECT encode(address_hmac, 'hex') AS h FROM contact_points WHERE contact_id = $1 AND kind = $2", [contactId, kind]).then((r) => r.rows.map((x) => x.h as string));

const OPEN = [ev.disclosed(4000), ev.announced(7000), ev.model(7500, 'How can I help you today?')];

describe('R-VOICE-18 R-CONSENT-7: an opt-out heard in the call is applied as planInboundEffects on voice', () => {
  it('R-CONSENT-7: a spoken STOP revokes voice on the caller\'s address only, cites the call, and the ledger carries core\'s channel', async () => {
    const second = `+1555010${String(Date.now()).slice(-4)}`;
    const c0 = await ownedContact(w.agents[0]!, { consent: false });
    await h.su.query("INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac, label, is_primary) SELECT tenant_id, $2, contact_id, 'phone', $3, decode(repeat('ab', 32), 'hex'), 'work', false FROM contact_points WHERE contact_id = $1 LIMIT 1", [c0.id, randomUUID(), second]);
    const c = await aiCall(h, w, SCRIPTS.spokenStop, { contact: c0 });
    const rows = await consentOf(c.contactId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: 'voice', source: 'inbound_keyword', needs_review: false, evidence_call_id: c.callId, evidence_message_id: null });
    expect(rows[0].hmac).not.toBe('ab'.repeat(32));
    // the model asked for channel 'sms'; the ledger holds the channel core heard
    const l = await ledgerOf(h, c.callId);
    expect(l.find((x) => x.tool === 'record_opt_out')).toMatchObject({ args: { channel: 'voice' }, decision: 'allow', reason_code: 'ALLOW_OPT_OUT_HEARD' });
    expect(l.find((x) => x.tool === 'book_appointment')).toMatchObject({ decision: 'deny', reason_code: 'VOICE_OPTED_OUT' });
    expect((await h.su.query("SELECT 1 FROM audit_log WHERE action = 'consent.opt_out_received' AND entity_type = 'call' AND entity_id = $1", [c.callId])).rows).toHaveLength(1);
  });

  it('R-CHAN-3 R-PAR-12: "please stop calling me" revokes voice (needs review) on every phone of the person, removed ones that still count included, and sets the person-level do-not-contact; by SMS the same words also revoke texts', async () => {
    const c0 = await ownedContact(w.agents[0]!, { consent: false });
    await h.su.query("INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac, label, is_primary, status, removed_at, removed_reason) SELECT tenant_id, $2, contact_id, 'phone', '+15550100177', decode(repeat('cd', 32), 'hex'), 'other', false, 'removed', now(), 'old' FROM contact_points WHERE contact_id = $1 LIMIT 1", [c0.id, randomUUID()]);
    const c = await aiCall(h, w, SCRIPTS.stopCalling, { contact: c0 });
    const rows = await consentOf(c.contactId);
    expect(new Set(rows.map((r) => r.channel))).toEqual(new Set(['voice']));
    expect(rows.every((r) => r.source === 'inbound_language' && r.needs_review === true && r.evidence_call_id === c.callId)).toBe(true);
    expect(rows.map((r) => r.hmac)).toEqual(expect.arrayContaining([...(await hmacOf(c.contactId, 'phone')), 'cd'.repeat(32)]));
    const dnc = (await h.su.query('SELECT do_not_contact_at FROM contacts WHERE id = $1', [c.contactId])).rows[0];
    expect(dnc.do_not_contact_at).not.toBeNull();
    expect((await ledgerOf(h, c.callId)).find((x) => x.tool === 'record_opt_out')?.args).toEqual({ channel: 'all' });
    // the same words by SMS: the inbound channel (sms) is revoked as well, otherwise the same effects
    const s = await ownedContact(w.agents[0]!, { consent: false });
    await inboundSms(h, s.phone, w.mainNumber, 'please stop calling me');
    expect(new Set((await consentOf(s.id)).map((r) => r.channel))).toEqual(new Set(['sms', 'voice']));
  });

  it("R-CONSENT-8: \"don't stop, I want to see it\" changes nothing, and the model's record_opt_out is denied", async () => {
    const c = await aiCall(h, w, SCRIPTS.dontStop);
    expect(await consentOf(c.contactId)).toHaveLength(0);
    expect((await ledgerOf(h, c.callId)).find((x) => x.tool === 'record_opt_out')).toMatchObject({ decision: 'deny', reason_code: 'OPT_OUT_NOT_HEARD' });
  });
});

describe('E112 R-VOICE-17 R-GATE-14: the confirmation is a one-tap draft on an allowed channel only', () => {
  it('E112: texts opted out before the call: the draft is by email; with no allowed channel there is no draft', async () => {
    const withEmail = await ownedContact(w.agents[0]!, { consent: false, email: randomEmail() });
    await inboundSms(h, withEmail.phone, w.mainNumber, 'STOP');
    const a = await aiCall(h, w, SCRIPTS.booking, { contact: withEmail });
    const hb = (await handbacksOf(h, a.callId))[0];
    expect(hb.payload.voice.confirmationChannel).toBe('email');
    expect(hb.payload.draft).toMatchObject({ channel: 'email', subject: 'Your appointment' });
    const noEmail = await ownedContact(w.agents[0]!, { consent: false });
    await h.su.query("UPDATE contact_points SET status = 'removed', removed_at = now(), removed_reason = 'old' WHERE contact_id = $1 AND kind = 'email'", [noEmail.id]);
    await inboundSms(h, noEmail.phone, w.mainNumber, 'STOP');
    const b = await aiCall(h, w, SCRIPTS.booking, { contact: noEmail });
    const hb2 = (await handbacksOf(h, b.callId))[0];
    expect(hb2.payload.voice).toMatchObject({ outcome: 'booked', confirmationChannel: null });
    expect(hb2.payload.draft).toBeUndefined();
  });

  it('E112: an opt-out heard in this call withdraws the confirmation; a promise after a failed transfer names no callback when calls are opted out', async () => {
    const script = { name: 'booked then STOP', steps: [...OPEN, ev.caller(10_000, 'Hi'), ev.tool(10_500, 'check_availability'), ev.model(11_000, 'Saturday at 10?'), ev.caller(12_000, 'Yes'), ev.tool(12_500, 'book_appointment', SLOT_ARGS(SLOT_A)), ev.caller(14_000, 'STOP'), ev.tool(14_500, 'end_call')] };
    const c = await aiCall(h, w, script);
    const hb = (await handbacksOf(h, c.callId))[0];
    expect(hb.payload.voice).toMatchObject({ confirmationChannel: null, noPhoneCallback: true });
    expect(hb.payload.draft).toBeUndefined();
  });

  it('R-GATE-14: the caller texts STOP after the call, before the tap: the tap is refused by the send-time gate and nothing is sent', async () => {
    const c = await aiCall(h, w, SCRIPTS.booking);
    const hb = (await handbacksOf(h, c.callId))[0];
    expect(hb.payload.draft).toMatchObject({ channel: 'sms' });
    await inboundSms(h, c.from, w.mainNumber, 'STOP');
    let r = await call<{ result: string; decision: { outcome: string; reasons: string[] } | null; error?: { details?: { inboundSeq?: number } } }>(w.agents[0]!, 'POST', `/assistant/actions/${hb.id}/approve`, { commandId: randomUUID() });
    if (r.code === 'DRAFT_STALE') {
      // the STOP is a newer inbound: the agent re-reviews, then taps again (R-AST-6)
      r = await call(w.agents[0]!, 'POST', `/assistant/actions/${hb.id}/approve`, { commandId: randomUUID(), reviewedInboundSeq: r.body.error?.details?.inboundSeq });
    }
    expect(r.body).toMatchObject({ result: 'blocked', decision: { outcome: 'deny', reasons: ['CONSENT_REVOKED'] } });
    expect((await h.su.query("SELECT 1 FROM messages WHERE contact_id = $1 AND direction = 'outbound' AND status IN ('sent','delivered','dispatching')", [c.contactId])).rows).toHaveLength(0);
  });
});

void settled;
