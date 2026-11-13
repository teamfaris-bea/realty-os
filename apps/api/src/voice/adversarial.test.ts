// Module 48 adversarial (R-VOICE-4, R-VOICE-6, R-VOICE-8, R-TEN-1, R-DATA-6): injected transfer numbers and foreign
// member ids, a cross-tenant signed ref and reconnect, PII in tool args, model turns that claim to be human.
import { OTHER_MEMBER_ID, OWNER_ID, SCRIPTS, SCRIPT_EVENTS as ev, FIXTURE_HOT_RULE, HOT_CLAIMS } from '@realty/core/voice/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { telephonyWebhook } from '../comms/testing.js';
import { inboundCallRef } from '../comms/voice.js';
import { depsFromPlatform } from '../comms/runtime.js';
import { setVoiceTestSeams } from './runtime.js';
import { type VoiceWorld, aiCall, callRowOf, handbacksOf, ledgerOf, setVoicePack, settled, voiceWorld, waitFor } from './testing.js';

let h: ApiHarness;
let a: VoiceWorld;
let b: VoiceWorld;
beforeAll(async () => {
  h = await createApiHarness();
  await setVoicePack(h, { reviewed: true, vendorReady: true });
  a = await voiceWorld(h);
  b = await voiceWorld(h);
  for (const t of [a.tenantId, b.tenantId]) await h.su.query("UPDATE tenant_settings SET routing_hours_start = '00:00', routing_hours_end = '23:59' WHERE tenant_id = $1", [t]);
  setVoiceTestSeams(h.app.platform, { hotRuleFor: () => FIXTURE_HOT_RULE });
});
afterAll(async () => {
  await h?.close();
});

const OPEN = [ev.disclosed(4000), ev.announced(7000), ev.model(7500, 'How can I help you today?')];

describe('R-VOICE-6 R-VOICE-4: the model\'s words never choose a target', () => {
  it('R-VOICE-6: an injected phone number, another member of the team and another tenant\'s member are never rung and never logged', async () => {
    const script = { name: 'targets', steps: [...OPEN, ev.claims(9000, HOT_CLAIMS), ev.caller(10_000, 'Can I talk to my agent? I want to go see it today.'),
      ev.tool(10_400, 'warm_transfer', { target_user_id: '+15550100199' }), ev.tool(10_500, 'warm_transfer', { target_user_id: OTHER_MEMBER_ID }), ev.tool(10_600, 'warm_transfer', { target_user_id: b.agents[0]!.userId }),
      ev.tool(10_700, 'dial_number', { number: '+15550100199' }), ev.hangup(12_000)] };
    const c = await aiCall(h, a, script, { faults: { idMap: { [OTHER_MEMBER_ID]: a.agents[1]!.userId! } } });
    const l = await ledgerOf(h, c.callId);
    expect(l.filter((x) => x.tool === 'warm_transfer').map((x) => [x.decision, x.reason_code, x.args])).toEqual([
      ['deny', 'VOICE_TOOL_ARGS_INVALID', {}],
      ['deny', 'TRANSFER_NOT_OWNER', {}],
      ['deny', 'TRANSFER_NOT_OWNER', {}],
    ]);
    const r = await settled(h, a.tenantId, c.callId);
    expect(r!.unlogged.map((u) => u.reason)).toContain('VOICE_TOOL_UNKNOWN'); // dial_number: outside the closed set, never written
    expect((await callRowOf(h, c.callSid)).transferred_to_user_id).toBeNull();
    expect(h.providers.voiceAgent.sessions.find((s) => s.sessionId === c.callId)!.handOffs.filter((x) => x.twiml.includes('<Dial'))).toHaveLength(0);
    expect(JSON.stringify(l)).not.toMatch(/555|\+1/);
  });

  it('R-DATA-6 R-VOICE-4: PII in tool arguments never reaches the ledger', async () => {
    const script = { name: 'pii', steps: [...OPEN, ev.caller(10_000, 'Take a message'), ev.tool(10_500, 'take_message', { topic: 'CALLBACK', note: 'Jane Doe at +15550100123', email: 'jane@example.com' }),
      ev.tool(10_600, 'take_message', { topic: 'Call Jane at 555 0100' }), ev.tool(10_700, 'end_call', { reason_code: 'MY NAME IS JANE' })] };
    const c = await aiCall(h, a, script);
    const l = await ledgerOf(h, c.callId);
    expect(JSON.stringify(l)).not.toMatch(/Jane|555|example\.com|NAME/i);
    expect(l.map((x) => x.args)).toEqual([{ topic: 'CALLBACK' }, {}, {}]);
    const hb = (await handbacksOf(h, c.callId))[0];
    expect(JSON.stringify(hb.payload)).not.toMatch(/Jane|555|example\.com/i);
  });

  it('R-VOICE-8: model turns that claim to be a person, also obfuscated, are never spoken', async () => {
    const c = await aiCall(h, a, SCRIPTS.injection, { faults: { idMap: { [OWNER_ID]: a.agents[0]!.userId! } } });
    const says = h.providers.voiceAgent.sessions.find((s) => s.sessionId === c.callId)!.says.map((x) => x.text);
    expect(says.some((t) => /Casey|450k|real person/i.test(t))).toBe(false);
    expect(says.every((t) => /assistant|AI|Goodbye|help you/i.test(t))).toBe(true);
  });
});

describe('R-TEN-1: a ref or a session of another tenant does nothing', () => {
  it("R-TEN-1: tenant A's signed ref naming tenant B's call, on screen, accept and dial-result, changes nothing in B; A's fake cannot reconnect B's session", async () => {
    const c = await aiCall(h, b, SCRIPTS.hotTransfer, { faults: { idMap: { [OWNER_ID]: b.agents[0]!.userId! }, pauseOnHandOff: true }, settle: false });
    await waitFor(() => h.providers.voiceAgent.transportOf(b.tenantId, c.callId)?.isHandedOff === true, 'the transfer hand-off');
    const forged = inboundCallRef(depsFromPlatform(h.app.platform), a.tenantId, c.callId);
    for (const path of ['voice/screen', 'voice/accept', 'voice/dial-result']) {
      const r = await telephonyWebhook(h, `/webhooks/telephony/${path}?c=${forged}`, { CallSid: c.callSid, Digits: '1', DialCallStatus: 'no-answer' });
      expect(r.statusCode).toBe(200);
      expect(r.body).not.toContain('fake-voice://');
    }
    expect((await callRowOf(h, c.callSid)).transfer_outcome).toBeNull();
    await expect(h.providers.voiceAgent.reconnect({ sessionId: c.callId, tenantId: a.tenantId })).rejects.toMatchObject({ providerCode: 'VOICE_SESSION_UNKNOWN' });
    // a forged ref (wrong MAC) is refused before any work
    expect((await telephonyWebhook(h, `/webhooks/telephony/voice/accept?c=${forged.slice(0, -2)}xx`, { Digits: '1' })).statusCode).toBeGreaterThanOrEqual(400);
    h.providers.voiceAgent.transportOf(b.tenantId, c.callId)!.advance(30_000);
    h.providers.voiceAgent.transportOf(b.tenantId, c.callId)!.resume();
    await settled(h, b.tenantId, c.callId);
    expect(await handbacksOf(h, c.callId)).toHaveLength(1);
  });
});
