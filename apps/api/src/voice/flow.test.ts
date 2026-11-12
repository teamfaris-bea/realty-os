// Module 48 end to end: webhooks → takeover → session against FakeVoiceAgent → one handback (real Postgres).
import { SCRIPTS } from '@realty/core/voice/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { type VoiceWorld, aiCall, callRowOf, handbacksOf, ledgerOf, setVoicePack, voiceWorld } from './testing.js';

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

describe('smoke', () => {
  it('R-VOICE-7: booking script ends in one handback', async () => {
    const c = await aiCall(h, w, SCRIPTS.booking);
    expect(c.ringTwiml).toContain('timeout="20"');
    expect(c.answer).toContain('fake-voice://session/');
    const row = await callRowOf(h, c.callSid);
    console.log(row.handled_by, row.voice_outcome, row.status, row.answered_at, row.ai_disclosed_at);
    console.log(await ledgerOf(h, c.callId));
    console.log(JSON.stringify(h.providers.voiceAgent.sessions.at(-1)!.says.map((x) => x.text)));
    const hb = await handbacksOf(h, c.callId);
    console.log(JSON.stringify(hb.map((x) => x.payload)));
    expect(hb).toHaveLength(1);
  });
});
