// Module 48 item 6: the live transfer legs (R-VOICE-6, R-VOICE-16; E432, E433, E434, E435). calls.transfer_outcome is
// the single arbiter: of a press, the hold end and the dial result exactly one wins.
import { FIXTURE_HOT_RULE, OWNER_ID, SCRIPTS } from '@realty/core/voice/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { ownedContact, telephonyWebhook } from '../comms/testing.js';
import { BRIDGE_TWIML } from '../providers/twilio/voiceTwiml.js';
import { setVoiceTestSeams } from './runtime.js';
import { LATE_PRESS_TEXT, TRANSFER_WHISPER } from './transfer.js';
import { type AiCall, type VoiceWorld, aiCall, callRowOf, callStatus, handbacksOf, hookPath, setVoicePack, settled, voiceWorld, waitFor } from './testing.js';

let h: ApiHarness;
let w: VoiceWorld;
beforeAll(async () => {
  h = await createApiHarness();
  await setVoicePack(h, { reviewed: true, vendorReady: true });
  w = await voiceWorld(h);
  await h.su.query("UPDATE tenant_settings SET routing_hours_start = '00:00', routing_hours_end = '23:59' WHERE tenant_id = $1", [w.tenantId]);
  setVoiceTestSeams(h.app.platform, { hotRuleFor: () => FIXTURE_HOT_RULE });
});
afterAll(async () => {
  await h?.close();
});

const transport = (c: AiCall) => h.providers.voiceAgent.transportOf(w.tenantId, c.callId)!;

/** A hot caller asks for their agent; the session hands the call to the owner's ring and waits there. */
async function inTransfer(owner = w.agents[0]!): Promise<{ c: AiCall; ring: string }> {
  const contact = await ownedContact(owner, { consent: false });
  const c = await aiCall(h, w, SCRIPTS.hotTransfer, { contact, faults: { idMap: { [OWNER_ID]: owner.userId! }, pauseOnHandOff: true }, settle: false });
  await waitFor(() => transport(c)?.isHandedOff === true, 'the transfer hand-off');
  const ring = h.providers.voiceAgent.sessions.find((s) => s.sessionId === c.callId)!.handOffs[0]!.twiml;
  return { c, ring };
}

describe('E432 E433 E434 E435 R-VOICE-6: transfer to the contact\'s own agent', () => {
  it('E432 R-VOICE-6: the owner is rung from the team number for the hold, hears the whisper, presses 1: connected', async () => {
    const { c, ring } = await inTransfer();
    expect(ring).toContain(`callerId="${w.mainNumber}"`);
    expect(ring).toContain('timeout="20"');
    expect(ring).toContain(`>${w.ownerPhone}</Number>`);
    expect(ring).not.toContain('<Say>'); // no second announcement to the caller
    expect(await callRowOf(h, c.callSid)).toMatchObject({ transferred_to_user_id: w.agents[0]!.userId, ring_user_id: w.agents[0]!.userId, transfer_outcome: null });
    const screen = await telephonyWebhook(h, hookPath(ring, 'url'), { CallSid: 'CAleg1', ParentCallSid: c.callSid });
    expect(screen.body.replace(/&apos;/g, "'")).toContain(TRANSFER_WHISPER);
    const accept = await telephonyWebhook(h, hookPath(screen.body, 'action'), { CallSid: 'CAleg1', Digits: '1' });
    expect(accept.body).toBe(BRIDGE_TWIML);
    const r = await settled(h, w.tenantId, c.callId);
    expect(r?.handback).toMatchObject({ outcome: 'transferred', critical: false, transferOutcome: 'connected' });
    expect(await callRowOf(h, c.callSid)).toMatchObject({ transfer_outcome: 'connected', agent_user_id: w.agents[0]!.userId, voice_outcome: 'transferred' });
    // the bridged call ended: the dial result hangs up, and a retried press still bridges
    expect((await telephonyWebhook(h, hookPath(ring, 'action'), { CallSid: c.callSid, DialCallStatus: 'completed' })).body).toContain('<Hangup/>');
    expect((await telephonyWebhook(h, hookPath(screen.body, 'action'), { CallSid: 'CAleg1', Digits: '1' })).body).toBe(BRIDGE_TWIML);
    const hb = (await handbacksOf(h, c.callId))[0];
    expect((await h.su.query('SELECT priority FROM notifications WHERE subject_id = $1', [hb.id])).rows.map((x) => x.priority)).toEqual(['high']);
  });

  it('E433 R-VOICE-16: the hold ends first; a later press is refused and the caller is back with the assistant', async () => {
    const { c, ring } = await inTransfer();
    transport(c).advance(25_000); // past the 20 s hold
    for (let i = 0; i < 300; i++) {
      if ((await callRowOf(h, c.callSid)).transfer_outcome !== null) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect((await callRowOf(h, c.callSid)).transfer_outcome).toBe('no_answer');
    const screen = await telephonyWebhook(h, hookPath(ring, 'url'), { CallSid: 'CAleg2', ParentCallSid: c.callSid });
    expect(screen.body).toContain('<Hangup/>');
    const late = await telephonyWebhook(h, hookPath(ring, 'url').replace('/voice/screen', '/voice/accept'), { CallSid: 'CAleg2', Digits: '1' });
    expect(late.body).toContain(LATE_PRESS_TEXT);
    // the Dial ends: the caller goes back to the assistant's stream
    const back = await telephonyWebhook(h, hookPath(ring, 'action'), { CallSid: c.callSid, DialCallStatus: 'no-answer' });
    expect(back.body).toContain('fake-voice://session/');
    const r = await settled(h, w.tenantId, c.callId);
    expect(r?.handback).toMatchObject({ transferOutcome: 'no_answer', critical: true });
    expect(r?.handback.promiseTask).not.toBeNull();
    expect((await callRowOf(h, c.callSid)).agent_user_id).toBe(w.agents[0]!.userId); // the owner of the contact, unchanged
  });

  it('E433: the owner declines (any other key): declined, the owner leg hangs up, a promise task follows', async () => {
    const { c, ring } = await inTransfer();
    const screen = await telephonyWebhook(h, hookPath(ring, 'url'), { CallSid: 'CAleg3', ParentCallSid: c.callSid });
    const no = await telephonyWebhook(h, hookPath(screen.body, 'action'), { CallSid: 'CAleg3', Digits: '7' });
    expect(no.body).toContain('<Hangup/>');
    await telephonyWebhook(h, hookPath(ring, 'action'), { CallSid: c.callSid, DialCallStatus: 'completed' });
    transport(c).resume();
    const r = await settled(h, w.tenantId, c.callId);
    expect(r?.handback.transferOutcome).toBe('declined');
    const hb = (await handbacksOf(h, c.callId))[0];
    expect((await h.su.query("SELECT 1 FROM tasks WHERE source_action_id = $1 AND kind = 'promise'", [hb.id])).rows).toHaveLength(1);
  });

  it('E435: the caller hangs up during the hold: the session ends with one handback; the owner\'s late dial result changes nothing', async () => {
    const { c, ring } = await inTransfer();
    await callStatus(h, w, c.callSid, c.from, 'completed', { CallDuration: '30' });
    const r = await settled(h, w.tenantId, c.callId);
    expect(r?.handback.endReason).toBe('CALLER_HUNG_UP');
    await telephonyWebhook(h, hookPath(ring, 'action'), { CallSid: c.callSid, DialCallStatus: 'no-answer' });
    expect(await handbacksOf(h, c.callId)).toHaveLength(1);
  });

  it('E434: the owner has no verified alert phone: no ring, transfer_result no_answer at once', async () => {
    const contact = await ownedContact(w.agents[1]!, { consent: false });
    const c = await aiCall(h, w, SCRIPTS.hotTransfer, { contact, faults: { idMap: { [OWNER_ID]: w.agents[1]!.userId! } } });
    const r = await settled(h, w.tenantId, c.callId);
    expect(h.providers.voiceAgent.sessions.find((s) => s.sessionId === c.callId)!.handOffs.filter((x) => x.twiml.includes('<Dial'))).toHaveLength(0);
    expect(r?.handback.transferOutcome).toBe('no_answer');
    expect((await callRowOf(h, c.callSid)).transferred_to_user_id).toBeNull();
  });
});
