// b18 review B18S-5 (owner product boundary, 2026-11-14): an AI-answered call is automated contact, so the assistant
// never takes over a call from a person a lead source marked "No automated contact for leads from this source" sent.
// The ring decides it (SOURCE_NO_AUTOMATED_CONTACT, Phase 1's voicemail, the call view's sentence), and 0098's guard
// refuses the takeover in the database when the setting changed between the ring and the dial result. A person on
// the team still answers or returns the call. A made-up source; fakes only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, freshReauth } from '../admin/testing.js';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { ownedContact, telephonyWebhook } from '../comms/testing.js';
import { SOURCE_NO_AUTOMATED_CONTACT, SOURCE_UNCLASSIFIED } from '../leads/automatedContact.js';
import { importedPerson } from '../leads/testing.js';
import { refusalSentence } from './takeover.js';
import { type VoiceWorld, aiCall, callRowOf, expectPhase1Voicemail, hookPath, ringing, setVoicePack, sid, voiceWorld } from './testing.js';

let h: ApiHarness;
let w: VoiceWorld;
let marked: string;

beforeAll(async () => {
  h = await createApiHarness();
  await setVoicePack(h, { reviewed: true, vendorReady: true });
  w = await voiceWorld(h);
  marked = (await call<{ source: { id: string } }>(w.owner, 'POST', '/lead-sources', { name: 'Partner referral (test)', kind: 'portal' })).body.source.id;
  await freshReauth(h, w.owner);
  expect((await call(w.owner, 'PUT', `/lead-sources/${marked}/ai-care`, { noAiCare: true })).status).toBe(200);
}, 240_000);
afterAll(async () => {
  await h?.close();
});

const markLead = (contactId: string) => h.su.query('UPDATE contacts SET original_lead_source_id = $2 WHERE id = $1', [contactId, marked]);

describe('R-LSRC-8 B18S-5: the assistant never answers a call from a lead the marked source sent', () => {
  it('B18S-5 E727: refused at the ring (SOURCE_NO_AUTOMATED_CONTACT): Phase 1 voicemail, no assistant row, and the call view says why', async () => {
    const c = await ownedContact(w.agents[0]!, { consent: false });
    await markLead(c.id);
    const r = await aiCall(h, w, null, { contact: c });
    expect(r.ringTwiml).toContain('timeout="20"');
    await expectPhase1Voicemail(h, r, SOURCE_NO_AUTOMATED_CONTACT);
    const v = await call<{ state: string; sentence: string }>(w.agents[0]!, 'GET', `/calls/${r.callId}/voice`);
    expect(v.body).toMatchObject({ state: 'not_answered', sentence: refusalSentence(SOURCE_NO_AUTOMATED_CONTACT) });
    expect(v.body.sentence).toMatch(/No automated contact for leads from this source/);
  });

  it('B18S-5 E727: marked between the ring and the dial result: the database refuses the takeover (0098) and the caller gets Phase 1 voicemail', async () => {
    const c = await ownedContact(w.agents[0]!, { consent: false });
    const callSid = sid();
    const ring = await ringing(h, w, callSid, c.phone);
    expect(ring.body).toContain('<Dial');
    await markLead(c.id);
    const answer = (await telephonyWebhook(h, hookPath(ring.body, 'action'), { CallSid: callSid, DialCallStatus: 'no-answer' })).body;
    const row = await callRowOf(h, callSid);
    await expectPhase1Voicemail(h, { callSid, callId: row.id, contactId: c.id, from: c.phone, ringTwiml: ring.body, answer }, SOURCE_NO_AUTOMATED_CONTACT);
  });

  it('B18S-5 E727: a caller from another source is still answered by the assistant', async () => {
    const c = await ownedContact(w.agents[0]!, { consent: false });
    const r = await aiCall(h, w, null, { contact: c });
    expect((await callRowOf(h, r.callSid)).handled_by).toBe('assistant');
  });
});

describe('R-LSRC-9 A2 A3: the assistant never answers a call from an imported person whose source is not reviewed yet', () => {
  it('R-LSRC-9 E729: refused at the ring with SOURCE_UNCLASSIFIED: Phase 1 voicemail, no assistant row, and the call view says the imported source has not been reviewed yet (never that a setting is on)', async () => {
    const c = await ownedContact(w.agents[0]!, { consent: false });
    await importedPerson(h, w.tenantId, w.owner.userId!, c.id);
    const r = await aiCall(h, w, null, { contact: c });
    expect(r.ringTwiml).toContain('timeout="20"');
    await expectPhase1Voicemail(h, r, SOURCE_UNCLASSIFIED);
    const v = await call<{ state: string; sentence: string }>(w.agents[0]!, 'GET', `/calls/${r.callId}/voice`);
    expect(v.body).toMatchObject({ state: 'not_answered', sentence: refusalSentence(SOURCE_UNCLASSIFIED) });
    expect(v.body.sentence).toBe('The assistant did not answer: this caller came in from an import and their imported source has not been reviewed yet (an Owner reviews it under Lead sources), so a person on the team answers or calls them back.');
    expect(v.body.sentence).not.toMatch(/No automated contact for leads from this source|Owner setting/);
  });

  it('R-LSRC-9 E729: imported between the ring and the dial result: the database refuses the takeover with SOURCE_UNCLASSIFIED, which is stored as the call\'s refusal, and the caller gets Phase 1 voicemail', async () => {
    const c = await ownedContact(w.agents[0]!, { consent: false });
    const callSid = sid();
    const ring = await ringing(h, w, callSid, c.phone);
    expect(ring.body).toContain('<Dial');
    await importedPerson(h, w.tenantId, w.owner.userId!, c.id);
    const answer = (await telephonyWebhook(h, hookPath(ring.body, 'action'), { CallSid: callSid, DialCallStatus: 'no-answer' })).body;
    const row = await callRowOf(h, callSid);
    await expectPhase1Voicemail(h, { callSid, callId: row.id, contactId: c.id, from: c.phone, ringTwiml: ring.body, answer }, SOURCE_UNCLASSIFIED);
  });
});
