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

describe('b12 review F5: a merge during an AI-answered call (R-OWN-24, R-VOICE handback; E526)', () => {
  it('R-OWN-24: the record is merged while the AI is on the call: the booked appointment, the handback and its card land on the survivor with the call', async () => {
    const { command } = await import('../leads/testing.js');
    const { ownedContact } = await import('../comms/testing.js');
    const { settled, waitFor } = await import('./testing.js');
    const survivor = await ownedContact(w.agents[0]!, { consent: false });
    const c = await aiCall(h, w, SCRIPTS.booking, { faults: { holdBeforeStep: 3 }, settle: false });
    await waitFor(() => h.providers.voiceAgent.transportOf(w.tenantId, c.callId)?.isPaused === true, 'the paused session');
    const m = await command(w.owner, survivor.id, 'merge', { loserId: c.contactId, ownerChoice: w.agents[0]!.userId });
    expect(m.status).toBe(200);
    h.providers.voiceAgent.transportOf(w.tenantId, c.callId)!.resume();
    const r = await settled(h, w.tenantId, c.callId);
    expect(r?.appointmentId).toBeTruthy();
    const ids = [c.contactId, survivor.id];
    expect((await h.su.query(`SELECT contact_id FROM calls WHERE id = $1`, [c.callId])).rows).toEqual([{ contact_id: survivor.id }]);
    expect((await h.su.query(`SELECT contact_id FROM assistant_actions WHERE kind = 'handback' AND payload ->> 'inboundCallId' = $1`, [c.callId])).rows).toEqual([{ contact_id: survivor.id }]);
    expect((await h.su.query(`SELECT contact_id FROM appointments WHERE contact_id = ANY($1::uuid[]) AND created_by_kind = 'assistant'`, [ids])).rows).toEqual([{ contact_id: survivor.id }]);
    expect((await h.su.query(`SELECT contact_id, state FROM priority_feed_items WHERE contact_id = ANY($1::uuid[]) AND item_type = 'handback'`, [ids])).rows).toEqual([{ contact_id: survivor.id, state: 'open' }]);
  });
});
