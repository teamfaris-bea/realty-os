// Module 48: every refusal is Phase 1's voicemail with no assistant row (R-VOICE-1, R-VOICE-9, R-VOICE-12, R-INT-6,
// R-GATE-9; E420, E436, E150). Plan-time refusals are decided at the ring; the DB refuses at the takeover when the
// state changed in between (app.calls_voice_guard).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { call, freshReauth } from '../admin/testing.js';
import { setAiEnabled } from '../assistant/testing.js';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { ownedContact, telephonyWebhook } from '../comms/testing.js';
import { FakeVoiceAgent } from './fake.js';
import { UnconfiguredVoiceAgent } from './provider.js';
import { clearVoiceTestSeams, setVoiceTestSeams } from './runtime.js';
import { refusalSentence } from './takeover.js';
import { type VoiceWorld, aiCall, callRowOf, expectPhase1Voicemail, hookPath, ringing, setVoicePack, sid, voiceWorld } from './testing.js';

let h: ApiHarness;
beforeAll(async () => {
  h = await createApiHarness();
  await setVoicePack(h, { reviewed: true, vendorReady: true });
});
afterEach(async () => {
  clearVoiceTestSeams(h.app.platform);
  await setVoicePack(h, { reviewed: true, vendorReady: true });
});
afterAll(async () => {
  await h?.close();
});

async function refusedAtRing(w: VoiceWorld, code: string) {
  const c = await aiCall(h, w, null);
  expect(c.ringTwiml).toContain('timeout="20"'); // Phase 1's ring timeout, not the takeover's
  await expectPhase1Voicemail(h, c, code);
  const v = await call<{ state: string; sentence: string }>(w.agents[0]!, 'GET', `/calls/${c.callId}/voice`);
  expect(v.body).toMatchObject({ state: 'not_answered', sentence: refusalSentence(code) });
  return c;
}

class StubAgent extends FakeVoiceAgent {
  override readonly kind = 'stub-vendor' as 'fake';
}

describe('E420 E436 R-VOICE-11 R-VOICE-12: refusals at the ring are Phase 1 voicemail, with no assistant row', () => {
  it('R-VOICE-1 E420: a revoked voice playbook', async () => {
    const w = await voiceWorld(h);
    const r = await call(w.owner, 'POST', `/playbook-versions/${w.playbookVersionId}/revoke`, { attestation: 'I revoke this playbook.', contentSha256: w.playbookSha });
    expect(r.status).toBe(200);
    await refusedAtRing(w, 'VOICE_PLAYBOOK_NOT_APPROVED');
  });

  it('R-VOICE-1 E420: a draft voice playbook (never approved) cannot be turned on, and its calls are not answered', async () => {
    const w = await voiceWorld(h, { enable: false });
    await call(w.owner, 'POST', `/playbook-versions/${w.playbookVersionId}/revoke`, { attestation: 'I revoke this playbook.', contentSha256: w.playbookSha });
    await call(w.owner, 'POST', '/playbooks', { templateKey: 'voice_answering' });
    await freshReauth(h, w.owner);
    const { VOICE_ATTESTATION_TEXT } = await import('./answering.js');
    expect((await call(w.owner, 'POST', '/voice/answering/enable', { attestation: VOICE_ATTESTATION_TEXT })).code).toBe('VOICE_PLAYBOOK_NOT_APPROVED');
    await refusedAtRing(w, 'VOICE_PLAYBOOK_NOT_APPROVED');
  });

  it('R-VOICE-9 E420: the Owner turned AI answering off', async () => {
    const w = await voiceWorld(h);
    expect((await call(w.owner, 'POST', '/voice/answering/disable', {})).status).toBe(200);
    await refusedAtRing(w, 'VOICE_ANSWERING_OFF');
  });

  it('R-INT-6 E420: platform:voice not counsel-reviewed', async () => {
    const w = await voiceWorld(h);
    await setVoicePack(h, { reviewed: false, vendorReady: true });
    await refusedAtRing(w, 'VOICE_NOT_CLEARED');
  });

  it('R-INT-6 E420 D11: counsel reviewed but no vendor passed the latency spike: still not cleared', async () => {
    const w = await voiceWorld(h);
    await setVoicePack(h, { reviewed: true, vendorReady: false });
    await refusedAtRing(w, 'VOICE_NOT_CLEARED');
  });

  it('R-VOICE-10 E420: a pack whose max_turn_latency_ms is not a positive integer refuses the takeover', async () => {
    const w = await voiceWorld(h);
    await setVoicePack(h, { reviewed: true, vendorReady: true, maxTurnLatencyMs: 'fast' });
    await refusedAtRing(w, 'VOICE_NOT_CLEARED');
  });

  it('R-VOICE-12 E436: the team turned the assistant off (ai_enabled false)', async () => {
    const w = await voiceWorld(h);
    await setAiEnabled(h, w.tenantId, false);
    await refusedAtRing(w, 'AI_DISABLED');
  });

  it('R-VOICE-12 E436 O13: recording off in the active policy', async () => {
    const w = await voiceWorld(h);
    const r = await call(w.owner, 'POST', '/compliance-policies', { recordingEnabled: false, activate: true });
    expect(r.status).toBe(201);
    await refusedAtRing(w, 'VOICE_RECORDING_OFF');
  });

  it('R-VOICE-12 E436: no voice vendor configured (the production stand-in)', async () => {
    const w = await voiceWorld(h);
    setVoiceTestSeams(h.app.platform, { voiceAgent: new UnconfiguredVoiceAgent() });
    await refusedAtRing(w, 'VOICE_VENDOR_NOT_CONFIGURED');
  });

  it('R-VOICE-12 E436: the fake voice agent never answers real telephony (TELEPHONY_PROVIDER=twilio)', async () => {
    const w = await voiceWorld(h);
    setVoiceTestSeams(h.app.platform, { telephonyProvider: 'twilio' });
    await refusedAtRing(w, 'VOICE_FAKE_ON_REAL_TELEPHONY');
  });

  it('R-VOICE-12 O5 R-TWL-1: a vendor on real telephony with the kill switch off is refused', async () => {
    const w = await voiceWorld(h);
    setVoiceTestSeams(h.app.platform, { telephonyProvider: 'twilio', telephonyLiveRequests: false, voiceAgent: new StubAgent() });
    await refusedAtRing(w, 'TELEPHONY_LIVE_OFF');
  });
});

describe('R-VOICE-1 R-VOICE-9 R-VOICE-11 E150 E420: the DB refuses at the takeover when things changed after the ring', () => {
  async function ringThen(w: VoiceWorld, change: () => Promise<void>, code: string) {
    const c = await ownedContact(w.agents[0]!, { consent: false });
    const callSid = sid();
    const ring = await ringing(h, w, callSid, c.phone);
    expect(ring.body).toContain('<Dial');
    const row = await callRowOf(h, callSid);
    expect(row.recording_decision.voiceTakeover.at).not.toBeNull();
    await change();
    const answer = (await telephonyWebhook(h, hookPath(ring.body, 'action'), { CallSid: callSid, DialCallStatus: 'no-answer' })).body;
    await expectPhase1Voicemail(h, { callSid, callId: row.id, contactId: c.id, from: c.phone, ringTwiml: ring.body, answer }, code);
  }

  it('R-VOICE-1: the playbook was revoked between the ring and the takeover: VOICE_PLAYBOOK_NOT_APPROVED from calls_voice_guard', async () => {
    const w = await voiceWorld(h);
    await ringThen(w, async () => void (await call(w.owner, 'POST', `/playbook-versions/${w.playbookVersionId}/revoke`, { attestation: 'I revoke this playbook.', contentSha256: w.playbookSha })), 'VOICE_PLAYBOOK_NOT_APPROVED');
  });

  it('R-VOICE-9 E150: AI answering was turned off in between: VOICE_ANSWERING_OFF from calls_voice_guard', async () => {
    const w = await voiceWorld(h);
    await ringThen(w, async () => void (await call(w.owner, 'POST', '/voice/answering/disable', {})), 'VOICE_ANSWERING_OFF');
  });

  it('R-INT-6: the pack lost its clearance in between: VOICE_NOT_CLEARED from calls_voice_guard', async () => {
    const w = await voiceWorld(h);
    await ringThen(w, () => setVoicePack(h, { reviewed: false, vendorReady: false }), 'VOICE_NOT_CLEARED');
  });
});
