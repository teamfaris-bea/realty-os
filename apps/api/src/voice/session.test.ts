// Module 48 items 5 and 7: the runner's ledger, ordering, booking, recording and merge edges
// (R-VOICE-2, R-VOICE-4, R-VOICE-7, R-VOICE-10, R-VOICE-11, R-VOICE-14, R-VOICE-15, R-VOICE-16; E116, E117, E421, E423–E425,
// E427, E429, E430).
import { SCRIPTS, SCRIPT_EVENTS as ev, SLOT_A, SLOT_ARGS, type VoiceScript } from '@realty/core/voice/testing';
import { withTenantTx } from '@realty/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runJobs as runAssistantJobs } from '../assistant/testing.js';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { bookSlot } from '../calendar/service.js';
import { VOICEMAIL_NOTICE } from '../comms/voice.js';
import { mayKeepVoicemail } from '../comms/recordings.js';
import { handlerOf } from '../comms/repos/notify.js';
import { ownedContact, runJobs, telephonyWebhook } from '../comms/testing.js';
import { importedUnassigned, randomPhone } from '../leads/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { VOICE_LEDGER_CAP } from './ledger.js';
import { clearVoiceTestSeams, setVoiceTestSeams } from './runtime.js';
import { type VoiceWorld, aiCall, callRowOf, callStatus, handbacksOf, hookPath, ledgerOf, ringing, setVoicePack, settled, sid, voiceWorld, waitFor } from './testing.js';

let h: ApiHarness;
let w: VoiceWorld;
beforeAll(async () => {
  h = await createApiHarness();
  await setVoicePack(h, { reviewed: true, vendorReady: true });
  w = await voiceWorld(h);
});
afterEach(() => clearVoiceTestSeams(h.app.platform));
afterAll(async () => {
  await h?.close();
});

const OPEN = [ev.disclosed(4000), ev.announced(7000), ev.model(7500, 'How can I help you today?')];

describe('R-VOICE-4 R-VOICE-14 E429: the ledger is written exactly as core decided', () => {
  it('R-VOICE-2 R-VOICE-4 E429: a request before both disclosures is only in unlogged; allowed rows pass the DB allowlist', async () => {
    const c = await aiCall(h, w, SCRIPTS.booking);
    const r = await settled(h, w.tenantId, c.callId);
    expect(r!.unlogged).toEqual([expect.objectContaining({ seq: 1, reason: 'VOICE_TOOL_BEFORE_DISCLOSURE' })]);
    expect((await ledgerOf(h, c.callId)).map((x) => x.seq)).toEqual([2, 3, 4]);
  });

  it('E429: a request that arrived as the session ended before the disclosure is unlogged, not an error', async () => {
    const script: VoiceScript = { name: 'hang up at once', steps: [ev.hangup(1000), ev.tool(1000, 'end_call')] };
    const c = await aiCall(h, w, script);
    const r = await settled(h, w.tenantId, c.callId);
    expect(r!.handback.endReason).toBe('CALLER_HUNG_UP');
    expect(r!.unlogged.map((u) => u.reason)).toEqual(['VOICE_SESSION_ENDED']);
    expect(await ledgerOf(h, c.callId)).toHaveLength(0);
    expect(await handbacksOf(h, c.callId)).toHaveLength(1);
  });

  it(`R-VOICE-14 E429: the ${VOICE_LEDGER_CAP + 1}st request is not written; the session ends through vendor_error (LEDGER_CAP)`, async () => {
    const steps = [...OPEN, ...Array.from({ length: VOICE_LEDGER_CAP + 5 }, (_, i) => ev.tool(8000 + i * 5, 'take_message', { topic: 'GENERAL' }))];
    const c = await aiCall(h, w, { name: 'flood', steps });
    const r = await settled(h, w.tenantId, c.callId);
    expect(await ledgerOf(h, c.callId)).toHaveLength(VOICE_LEDGER_CAP);
    expect(r!.unlogged.map((u) => u.reason)).toContain('LEDGER_CAP');
    expect(r!.handback).toMatchObject({ endReason: 'VENDOR_ERROR', outcome: 'fallback_voicemail' });
  });
});

describe('E423 E424 R-VOICE-2 R-VOICE-11: provider ordering', () => {
  it("E423 R-VOICE-11: an AI call's retried /voice fetch and retried dial-result replay the stream, never Phase 1's hang-up or its voicemail switch", async () => {
    const c = await aiCall(h, w, { name: 'hold', steps: [...OPEN] }, { faults: { holdBeforeStep: 3 }, settle: false });
    await waitFor(() => h.providers.voiceAgent.transportOf(w.tenantId, c.callId)?.isPaused === true, 'the paused session');
    expect((await callRowOf(h, c.callSid)).status).toBe('in_progress');
    const again = await ringing(h, w, c.callSid, c.from);
    expect(again.body).toContain('fake-voice://session/');
    const dr = await telephonyWebhook(h, hookPath(c.ringTwiml, 'action'), { CallSid: c.callSid, DialCallStatus: 'no-answer' });
    expect(dr.body).toContain('fake-voice://session/');
    expect((await callRowOf(h, c.callSid)).handled_by).toBe('assistant');
    h.providers.voiceAgent.transportOf(w.tenantId, c.callId)!.resume();
    await settled(h, w.tenantId, c.callId);
  });

  it('E424 R-VOICE-2: the provider\'s in_progress status before the announcement sets no answered_at; a hang-up before the announcement answers nothing', async () => {
    const c = await aiCall(h, w, { name: 'disclosure only', steps: [ev.disclosed(4000)] }, { faults: { holdBeforeStep: 1 }, settle: false });
    await waitFor(() => h.providers.voiceAgent.transportOf(w.tenantId, c.callId)?.isPaused === true, 'the paused session');
    const st = await callStatus(h, w, c.callSid, c.from, 'in-progress');
    expect(st.statusCode).toBe(200);
    const row = await callRowOf(h, c.callSid);
    expect(row.answered_at).toBeNull();
    expect(row.status).toBe('ringing');
    expect(row.ai_disclosed_at).not.toBeNull();
    // E424: the caller hangs up before the announcement played: nothing was answered, one critical handback, no tool
    // rows, no recording kept
    await callStatus(h, w, c.callSid, c.from, 'completed', { CallDuration: '5' });
    const r = await settled(h, w.tenantId, c.callId);
    expect(r!.handback.endReason).toBe('CALLER_HUNG_UP');
    expect(r!.handback).toMatchObject({ outcome: 'caller_ended', critical: true });
    expect((await callRowOf(h, c.callSid)).answered_at).toBeNull();
    expect(await ledgerOf(h, c.callId)).toHaveLength(0);
    const hbs = await handbacksOf(h, c.callId);
    expect(hbs).toHaveLength(1);
    expect((await h.su.query("SELECT priority FROM notifications WHERE subject_id = $1 AND kind = 'handback_hot'", [hbs[0].id])).rows).toEqual([{ priority: 'critical' }]);
    // a recording callback for the call (the provider's), then the copy job: nothing is kept
    await telephonyWebhook(h, '/webhooks/telephony/recording', { CallSid: c.callSid, From: w.mainNumber, RecordingSid: `RE${c.callSid.slice(2)}`, RecordingDuration: '5' });
    await runJobs(h, w.tenantId, ['comms.recording_copy']);
    expect((await h.su.query('SELECT 1 FROM recordings WHERE call_id = $1', [c.callId])).rows).toHaveLength(0);
  });

  it('R-VOICE-10 R-VOICE-21: a retried fetch for an AI call whose session is unknown here (a restart) gets voicemail', async () => {
    const c = await aiCall(h, w, SCRIPTS.booking);
    h.providers.voiceAgent.transports.delete(`${w.tenantId}:${c.callId}`);
    const again = await ringing(h, w, c.callSid, c.from);
    expect(again.body).toContain(VOICEMAIL_NOTICE);
    // answered under the announcement: the plain recording callback, not the ?vm= voicemail one
    expect(again.body).not.toContain('recording?vm=');
  });
});

describe('E421 E425 E427: takeover and booking edges', () => {
  it('E421: nobody can be rung: the assistant answers at once; ai_takeover_at is the decision instant', async () => {
    const x = await voiceWorld(h);
    await h.su.query('UPDATE memberships SET alert_phone_verified_at = NULL WHERE tenant_id = $1', [x.tenantId]); // nobody is ringable
    const contact = await ownedContact(x.agents[0]!, { consent: false });
    const c = await aiCall(h, x, SCRIPTS.takeMeOff, { contact });
    expect(c.ringTwiml).toContain('fake-voice://session/');
    const row = await callRowOf(h, c.callSid);
    expect(row.handled_by).toBe('assistant');
    expect(Math.abs(new Date(row.ai_takeover_at).getTime() - new Date(row.started_at).getTime())).toBeLessThan(10_000);
  });

  it('E421 voice-13: with nobody ringable, a failure inside the immediate takeover falls through to Phase 1\'s voicemail, never an error to the provider', async () => {
    const x = await voiceWorld(h);
    await h.su.query('UPDATE memberships SET alert_phone_verified_at = NULL WHERE tenant_id = $1', [x.tenantId]); // nobody is ringable
    const contact = await ownedContact(x.agents[0]!, { consent: false });
    const fn = `voice13_fail_${x.tenantId.replace(/-/g, '')}`;
    await h.su.query(`CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.tenant_id = '${x.tenantId}' AND NEW.handled_by = 'assistant' THEN RAISE EXCEPTION 'INJECTED_FAILURE'; END IF; RETURN NEW; END $$`);
    await h.su.query(`CREATE TRIGGER ${fn} BEFORE UPDATE ON calls FOR EACH ROW EXECUTE FUNCTION public.${fn}()`);
    try {
      const callSid = sid();
      const r = await ringing(h, x, callSid, contact.phone);
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain(VOICEMAIL_NOTICE);
      expect(r.body).not.toContain('fake-voice://session/');
      expect((await callRowOf(h, callSid)).handled_by).toBe('voicemail');
    } finally {
      await h.su.query(`DROP TRIGGER ${fn} ON calls`);
      await h.su.query(`DROP FUNCTION public.${fn}()`);
    }
  });

  it('E425 R-VOICE-10: the vendor does not connect: the session starts and ends with vendor_error, to voicemail, never answered; its voicemail is kept', async () => {
    const c = await aiCall(h, w, SCRIPTS.booking, { faults: { connectFailure: true } });
    expect(c.answer).toContain(VOICEMAIL_NOTICE);
    expect(c.answer).toContain('recording?vm=');
    const row = await callRowOf(h, c.callSid);
    expect(row).toMatchObject({ handled_by: 'assistant', voice_outcome: 'fallback_voicemail', answered_at: null, status: 'no_answer' });
    expect(typeof row.recording_decision.voicemailNoticeAt).toBe('string');
    // the recording job may run before the end transaction: the rule reads only the call's own state
    expect(mayKeepVoicemail({ ...row, voice_outcome: null })).toBe(true);
    expect(mayKeepVoicemail({ ...row, answered_at: new Date() })).toBe(false);
    await telephonyWebhook(h, hookPath(c.answer, 'recordingStatusCallback'), { CallSid: c.callSid, RecordingSid: `RE${c.callSid.slice(2)}`, RecordingDuration: '12' });
    await runJobs(h, w.tenantId, ['comms.recording_copy']);
    expect((await h.su.query('SELECT 1 FROM recordings WHERE call_id = $1', [c.callId])).rows).toHaveLength(1);
  });

  it('R-VOICE-2 R-COACH-3: an answered AI call\'s recording is kept under its announcement; a call review of it is refused (coaching reviews human calls only)', async () => {
    const c = await aiCall(h, w, SCRIPTS.booking);
    const row = await callRowOf(h, c.callSid);
    expect(row).toMatchObject({ recording_mode: 'announced_all_parties' });
    expect(row.recording_announced_at).not.toBeNull();
    expect(new Date(row.recording_announced_at).getTime()).toBe(new Date(row.answered_at).getTime());
    await telephonyWebhook(h, '/webhooks/telephony/recording', { CallSid: c.callSid, From: w.mainNumber, RecordingSid: `RE${c.callSid.slice(2)}`, RecordingDuration: '30' });
    await runJobs(h, w.tenantId, ['comms.recording_copy']);
    expect((await h.su.query('SELECT 1 FROM recordings WHERE call_id = $1', [c.callId])).rows).toHaveLength(1);
    await expect(withTenantTx(systemActor(w.tenantId, 'worker'), (tx) => tx.executeQuery({ sql: 'INSERT INTO call_scores (tenant_id, call_id, rubric_version, agent_user_id, contact_id, items, met_count, scored_count) VALUES (app.tenant_id(), $1, $2, $3, $4, $5, 0, 0)', parameters: [c.callId, 'rubric/1', w.agents[0]!.userId, c.contactId, '[]'], query: { kind: 'RawNode' } } as never), { db: h.database })).rejects.toThrow(/CALL_REVIEW_SUBJECT|COACHING/);
  });

  it('E426 R-VOICE-10: a vendor error mid-call, after both announcements, ends in voicemail under the announced basis with the reason in the handback', async () => {
    const script: VoiceScript = { name: 'vendor error mid-call', steps: [...OPEN, ev.caller(10_000, 'Hi, I saw the house on Main Street.'), ev.model(10_500, 'Thanks for calling.')] };
    const c = await aiCall(h, w, script, { faults: { vendorErrorAtStep: 4 } });
    const r = await settled(h, w.tenantId, c.callId);
    expect(r!.handback).toMatchObject({ endReason: 'VENDOR_ERROR', outcome: 'fallback_voicemail' });
    const row = await callRowOf(h, c.callSid);
    expect(row).toMatchObject({ handled_by: 'assistant', voice_outcome: 'fallback_voicemail', recording_mode: 'announced_all_parties' });
    expect(row.answered_at).not.toBeNull();
    expect(await handbacksOf(h, c.callId)).toHaveLength(1);
  });

  it('E427 R-VOICE-16: a booking that settles after the session ended is canceled and its calendar push enqueued', async () => {
    setVoiceTestSeams(h.app.platform, { bookSlot: async (...a: Parameters<typeof bookSlot>) => {
      await new Promise((r) => setTimeout(r, 300));
      return bookSlot(...a);
    } });
    const script: VoiceScript = { name: 'hang up mid-booking', steps: [...OPEN, ev.caller(10_000, 'Saturday?'), ev.tool(10_200, 'check_availability'), ev.tool(10_500, 'book_appointment', SLOT_ARGS(SLOT_A)), ev.hangup(10_600)] };
    const c = await aiCall(h, w, script, { faults: { ignorePending: true } });
    const r = await settled(h, w.tenantId, c.callId);
    expect(r!.handback.booked).toBeNull();
    expect(r!.appointmentId).not.toBeNull();
    expect((await h.su.query('SELECT status FROM appointments WHERE id = $1', [r!.appointmentId])).rows[0].status).toBe('canceled');
    expect((await h.su.query("SELECT 1 FROM jobs WHERE kind LIKE 'calendar.%' AND payload::text LIKE '%' || $1 || '%'", [r!.appointmentId])).rows.length).toBeGreaterThan(0);
    // E427: UNCONFIRMED_SLOT, as a needs-review claim on the one handback
    expect(r!.handback.needsReview).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'UNCONFIRMED_SLOT' })]));
    const hbs = await handbacksOf(h, c.callId);
    expect(hbs).toHaveLength(1);
    const claims = (await h.su.query('SELECT text, needs_review FROM assistant_claims WHERE action_id = $1', [hbs[0].id])).rows;
    expect(claims).toContainEqual({ text: 'The caller picked a time, but the booking was not confirmed. Confirm a time with them.', needs_review: true });
  });

  it('R-VOICE-6 O8: an unowned caller is offered no slots and cannot book; the handback goes to whoever the offer reaches', async () => {
    // an unassigned person, made the way the ownership engine makes one (an import's import_assign)
    const phone = randomPhone();
    const id = await importedUnassigned(h, w.tenantId, { firstName: 'Una', lastName: 'Signed', phones: [phone] });
    const before = (await h.su.query('SELECT owner_user_id, ownership_state, offered_to_user_id FROM contacts WHERE id = $1', [id])).rows[0];
    expect(before).toMatchObject({ owner_user_id: null, ownership_state: 'unassigned' });
    const c = await aiCall(h, w, SCRIPTS.booking, { contact: { id, phone } });
    await settled(h, w.tenantId, c.callId);
    const l = await ledgerOf(h, c.callId);
    expect(l.find((x) => x.tool === 'check_availability')).toMatchObject({ decision: 'deny', reason_code: 'CONTACT_NOT_OWNED' });
    expect((await h.su.query('SELECT 1 FROM appointments WHERE contact_id = $1', [id])).rows).toHaveLength(0);
    const hbs = await handbacksOf(h, c.callId);
    expect(hbs).toHaveLength(1);
    // O8's default: the offered agent, else whoever handles the contact now (handlerOf)
    const expected = before.offered_to_user_id ?? (await withTenantTx(systemActor(w.tenantId, 'worker'), (tx) => handlerOf(tx, id), { db: h.database })).userId;
    expect(expected).not.toBeNull();
    expect(hbs[0].owner_user_id).toBe(expected);
  });
});

describe('R-VOICE-22: an AI call is never a touch, first contact, speed-to-lead event or ownership change', () => {
  it('R-VOICE-22: after a booked AI call the contact\'s owner, ownership state, first touch and ownership events are unchanged', async () => {
    const contact = await ownedContact(w.agents[0]!, { consent: false });
    const COLS = 'owner_user_id, ownership_state, owned_at, first_touch_due_at, first_touch_at, first_touch_breached_at, release_due_at';
    const before = (await h.su.query(`SELECT ${COLS} FROM contacts WHERE id = $1`, [contact.id])).rows[0];
    const events = async () => (await h.su.query('SELECT count(*)::int AS n FROM lead_ownership_events WHERE contact_id = $1', [contact.id])).rows[0].n as number;
    const eventsBefore = await events();
    const c = await aiCall(h, w, SCRIPTS.booking, { contact });
    await settled(h, w.tenantId, c.callId);
    expect((await callRowOf(h, c.callSid)).handled_by).toBe('assistant');
    expect((await h.su.query(`SELECT ${COLS} FROM contacts WHERE id = $1`, [contact.id])).rows[0]).toEqual(before);
    expect(await events()).toBe(eventsBefore);
  });
});

describe('E430 R-VOICE-15: one handback, merged into a ring-time handback', () => {
  it('E430: a ring-time handback with a pending enrich job keeps the confirmation draft after the job runs', async () => {
    const contact = await ownedContact(w.agents[0]!, { consent: false });
    const callSid = sid();
    const ring = await ringing(h, w, callSid, contact.phone);
    const row = await callRowOf(h, callSid);
    // the handback inbound.ts writes at ring time when the assistant was running this contact's thread
    const hbId = (await h.su.query("SELECT gen_random_uuid() AS id")).rows[0].id;
    await h.su.query(`INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, status, owner_user_id, explanation, payload, pinned_inbound_seq, dedupe_key)
                      VALUES ($1, $2, $3, 'handback', 'internal', 'internal', 'proposed', $4, 'They called.', jsonb_build_object('inboundCallId', $5::text), 1, 'handback:none:' || $5)`, [w.tenantId, hbId, contact.id, w.agents[0]!.userId, row.id]);
    await h.su.query("INSERT INTO jobs (tenant_id, queue, kind, payload, dedupe_key, run_at) VALUES ($1, 'default', 'assistant.enrich_handback', jsonb_build_object('actionId', $2::text), 'assistant.enrich_handback:' || $2, now())", [w.tenantId, hbId]);
    const enrichJob = () => h.su.query("SELECT status FROM jobs WHERE kind = 'assistant.enrich_handback' AND payload ->> 'actionId' = $1", [hbId]).then((r) => r.rows.map((x) => x.status as string));
    expect(await enrichJob()).toEqual(['pending']);
    h.providers.voiceAgent.nextCall(SCRIPTS.booking);
    await telephonyWebhook(h, hookPath(ring.body, 'action'), { CallSid: callSid, DialCallStatus: 'no-answer' });
    await settled(h, w.tenantId, row.id);
    const hbs = await handbacksOf(h, row.id);
    expect(hbs).toHaveLength(1);
    expect(hbs[0].id).toBe(hbId);
    expect(hbs[0].payload).toMatchObject({ enriched: true, suggested: true, voice: { outcome: 'booked' }, draft: { channel: 'sms' } });
    expect(await enrichJob()).toEqual(['pending']);
    await runAssistantJobs(h, w.tenantId, ['assistant.enrich_handback']);
    // the job ran (it skipped at its locked re-read) and the draft is the voice result's
    expect(await enrichJob()).not.toContain('pending');
    const after = (await h.su.query('SELECT payload FROM assistant_actions WHERE id = $1', [hbId])).rows[0].payload;
    expect(after.draft).toEqual(hbs[0].payload.draft);
    expect((await callRowOf(h, callSid)).handback_action_id).toBe(hbId);
    // the provider's final status: still no missed-call card, the handback is in front of the agent
    await callStatus(h, w, callSid, contact.phone, 'completed', { CallDuration: '60' });
    expect((await h.su.query("SELECT 1 FROM priority_feed_items WHERE contact_id = $1 AND item_type = 'missed_call'", [contact.id])).rows).toHaveLength(0);
    expect((await h.su.query("SELECT 1 FROM notifications WHERE subject_id = $1 AND kind = 'missed_call'", [row.id])).rows).toHaveLength(0);
  });

  it('E430: a ring-time handback the agent already handled is left alone: the voice result is a new handback', async () => {
    const contact = await ownedContact(w.agents[0]!, { consent: false });
    const callSid = sid();
    const ring = await ringing(h, w, callSid, contact.phone);
    const row = await callRowOf(h, callSid);
    const oldId = (await h.su.query("SELECT gen_random_uuid() AS id")).rows[0].id;
    await h.su.query(`INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, status, owner_user_id, explanation, payload, pinned_inbound_seq, dedupe_key,
                        decided_by_user_id, decided_at)
                      VALUES ($1, $2, $3, 'handback', 'internal', 'internal', 'rejected', $4, 'They called.', jsonb_build_object('inboundCallId', $5::text), 1, 'handback:none:' || $5, $4, now())`,
      [w.tenantId, oldId, contact.id, w.agents[0]!.userId, row.id]);
    h.providers.voiceAgent.nextCall(SCRIPTS.booking);
    await telephonyWebhook(h, hookPath(ring.body, 'action'), { CallSid: callSid, DialCallStatus: 'no-answer' });
    await settled(h, w.tenantId, row.id);
    const hbs = await handbacksOf(h, row.id);
    expect(hbs.map((x) => x.id)).toHaveLength(2);
    const fresh = hbs.find((x) => x.id !== oldId)!;
    expect(fresh.payload).toMatchObject({ voice: { outcome: 'booked' } });
    expect((await callRowOf(h, callSid)).handback_action_id).toBe(fresh.id);
    const old = (await h.su.query('SELECT status, payload FROM assistant_actions WHERE id = $1', [oldId])).rows[0];
    expect(old.status).toBe('rejected');
    expect(old.payload.voice).toBeUndefined();
  });
});

