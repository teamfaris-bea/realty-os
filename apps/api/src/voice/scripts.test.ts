// Module 48: every core/voice scripted caller through the real webhooks and FakeVoiceAgent (R-VOICE-1…10; E112–E119).
// Each session ends in exactly one handback, one voice_outcome and one handback_action_id; the ledger rows are
// exactly core's written entries; sessionViolations() finds nothing.
import { IDENTITY, OTHER_MEMBER_ID, OWNER_ID, SCRIPTS, FIXTURE_HOT_RULE, type ScriptName, sessionViolations } from '@realty/core/voice/testing';
import { voiceTurnGuard } from '@realty/core/voice';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { setVoiceTestSeams } from './runtime.js';
import type { SessionResult } from './session.js';
import { type VoiceWorld, aiCall, callRowOf, handbacksOf, ledgerOf, setVoicePack, settled, voiceWorld } from './testing.js';

let h: ApiHarness;
let w: VoiceWorld;
beforeAll(async () => {
  h = await createApiHarness();
  await setVoicePack(h, { reviewed: true, vendorReady: true });
  w = await voiceWorld(h);
  // every hour is a routing hour here, so a transfer's "inside routing hours" never depends on when CI runs
  await h.su.query("UPDATE tenant_settings SET routing_hours_start = '00:00', routing_hours_end = '23:59' WHERE tenant_id = $1", [w.tenantId]);
  setVoiceTestSeams(h.app.platform, { hotRuleFor: () => FIXTURE_HOT_RULE });
});
afterAll(async () => {
  await h?.close();
});

const idMap = (): Record<string, string> => ({ [OWNER_ID]: w.agents[0]!.userId!, [OTHER_MEMBER_ID]: w.agents[1]!.userId! });

export async function expectOneHandback(callSid: string, callId: string, r: SessionResult | null): Promise<void> {
  expect(r).not.toBeNull();
  const row = await callRowOf(h, callSid);
  expect(row.handled_by).toBe('assistant');
  expect(row.voice_outcome).toBe(r!.handback.outcome);
  const hbs = await handbacksOf(h, callId);
  expect(hbs).toHaveLength(1);
  expect(row.handback_action_id).toBe(hbs[0].id);
  const rows = await ledgerOf(h, callId);
  const written = r!.state.ledger.filter((e) => !r!.unlogged.some((u) => u.seq === e.seq));
  expect(rows.map((x) => [x.seq, x.tool, x.args, x.decision, x.reason_code])).toEqual(written.map((e) => [e.seq, e.row!.tool, e.row!.args, e.decision, e.reason]));
  expect(sessionViolations({ state: r!.state, actions: r!.trace, clock: null as never }, (t) => voiceTurnGuard(t, IDENTITY).pass || r!.trace.some((a) => a.action.kind === 'say' && a.action.source !== 'model' && a.action.text === t))).toEqual([]);
}

const PLAIN: ScriptName[] = ['booking', 'ownerNoAnswer', 'priceQuestion', 'robot', 'spokenStop', 'stopCalling', 'takeMeOff', 'dontStop', 'injection', 'silence', 'hangupMidBooking'];

describe('R-VOICE-7 E113 E114 E115 E119 R-CONSENT-8: every scripted caller ends in exactly one handback', () => {
  for (const name of PLAIN) {
    it(`R-VOICE-7: script "${SCRIPTS[name].name}"`, async () => {
      const c = await aiCall(h, w, SCRIPTS[name], { faults: { idMap: idMap() } });
      const r = await settled(h, w.tenantId, c.callId);
      await expectOneHandback(c.callSid, c.callId, r);
    });
  }

  it('E113 R-VOICE-8: "are you a robot" gets the truthful answer; the model\'s human claims are never spoken', async () => {
    const c = await aiCall(h, w, SCRIPTS.robot);
    const says = h.providers.voiceAgent.sessions.at(-1)!.says.map((x) => x.text);
    expect(says.some((t) => t.startsWith("No, you're talking to the team's automated assistant"))).toBe(true);
    expect(says.some((t) => /real person|Jordan/.test(t))).toBe(false);
    void c;
  });

  it('E114 R-VOICE-5: the price question is declined, a message is taken, and the handback names the topic', async () => {
    const c = await aiCall(h, w, SCRIPTS.priceQuestion);
    const hb = (await handbacksOf(h, c.callId))[0];
    // the outcome is core's: with live ticks, the model's silence after take_message runs past the turn limit (R-VOICE-10)
    expect(hb.payload.voice).toMatchObject({ categories: expect.arrayContaining(['money']), messageTopics: expect.arrayContaining(['PRICE']) });
    const says = h.providers.voiceAgent.sessions.at(-1)!.says.map((x) => x.text);
    expect(says).toContain("I'm the team's automated assistant, so I can't answer that one. I'll pass your question to your agent so they can get back to you.");
    expect(says.some((t) => t.includes('450k'))).toBe(false);
  });

  it('E115 R-VOICE-6: the owner does not answer within the hold: back to the caller, a critical handback and a promise task', async () => {
    const c = await aiCall(h, w, SCRIPTS.ownerNoAnswer, { faults: { idMap: idMap() } });
    const row = await callRowOf(h, c.callSid);
    expect(row).toMatchObject({ transfer_outcome: 'no_answer', transferred_to_user_id: w.agents[0]!.userId });
    const hb = (await handbacksOf(h, c.callId))[0];
    expect(hb.payload.voice).toMatchObject({ transferOutcome: 'no_answer', outcome: 'message_taken' });
    const tasks = (await h.su.query("SELECT * FROM tasks WHERE source_action_id = $1 AND kind = 'promise'", [hb.id])).rows;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: 'Call back the caller who asked for you', source_claim_id: null, assignee_user_id: w.agents[0]!.userId });
    const n = (await h.su.query("SELECT priority FROM notifications WHERE subject_id = $1", [hb.id])).rows;
    expect(n.map((x) => x.priority)).toEqual(['critical']);
  });
});
