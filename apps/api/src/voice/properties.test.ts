// Module 48 property test (R-VOICE-6, R-VOICE-7, R-VOICE-16): random interleavings of transport events, late booking
// results, key presses, hold ends, dial results and provider statuses always give exactly one handback, one consistent
// transfer_outcome, and no id outside the session's facts (the owner is the only person ever rung, transferred to or booked).
import fc from 'fast-check';
import { FIXTURE_HOT_RULE, OWNER_ID, SCRIPTS } from '@realty/core/voice/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { bookSlot } from '../calendar/service.js';
import { ownedContact, telephonyWebhook } from '../comms/testing.js';
import { setVoiceTestSeams } from './runtime.js';
import { type VoiceWorld, aiCall, callRowOf, callStatus, handbacksOf, hookPath, ledgerOf, setVoicePack, settled, voiceWorld } from './testing.js';

let h: ApiHarness;
let w: VoiceWorld;
let bookingDelay = 0;
beforeAll(async () => {
  h = await createApiHarness();
  await setVoicePack(h, { reviewed: true, vendorReady: true });
  w = await voiceWorld(h);
  await h.su.query("UPDATE tenant_settings SET routing_hours_start = '00:00', routing_hours_end = '23:59' WHERE tenant_id = $1", [w.tenantId]);
  setVoiceTestSeams(h.app.platform, {
    hotRuleFor: () => FIXTURE_HOT_RULE,
    bookSlot: async (...a: Parameters<typeof bookSlot>) => {
      if (bookingDelay > 0) await new Promise((r) => setTimeout(r, bookingDelay));
      return bookSlot(...a);
    },
  });
});
afterAll(async () => {
  await h?.close();
});

type Ext = { kind: 'press'; digit: '1' | '7' } | { kind: 'dial'; status: 'no-answer' | 'completed' } | { kind: 'status'; status: 'completed' | 'in-progress' } | { kind: 'advance'; ms: number } | { kind: 'wait'; ms: number };
const ext: fc.Arbitrary<Ext> = fc.oneof(
  fc.record({ kind: fc.constant('press' as const), digit: fc.constantFrom('1' as const, '7' as const) }),
  fc.record({ kind: fc.constant('dial' as const), status: fc.constantFrom('no-answer' as const, 'completed' as const) }),
  fc.record({ kind: fc.constant('status' as const), status: fc.constantFrom('completed' as const, 'in-progress' as const) }),
  fc.record({ kind: fc.constant('advance' as const), ms: fc.integer({ min: 0, max: 30_000 }) }),
  fc.record({ kind: fc.constant('wait' as const), ms: fc.integer({ min: 0, max: 30 }) }),
);

describe('R-VOICE-7 R-VOICE-16 property: one handback, one transfer outcome, no foreign id', () => {
  it('R-VOICE-7: any interleaving', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('hotTransfer', 'ownerNoAnswer', 'booking', 'hangupMidBooking') as fc.Arbitrary<keyof typeof SCRIPTS>, fc.array(ext, { maxLength: 6 }), fc.boolean(), fc.integer({ min: 0, max: 80 }), async (name, actions, ignorePending, delay) => {
        bookingDelay = delay;
        const owner = w.agents[0]!;
        const contact = await ownedContact(owner, { consent: false });
        const c = await aiCall(h, w, SCRIPTS[name], { contact, settle: false, faults: { idMap: { [OWNER_ID]: owner.userId! }, pauseOnHandOff: true, ignorePending } });
        const t = () => h.providers.voiceAgent.transportOf(w.tenantId, c.callId);
        const session = h.providers.voiceAgent.sessions.find((s) => s.sessionId === c.callId);
        for (const a of actions) {
          const ring = session?.handOffs.find((x) => x.twiml.includes('<Dial'))?.twiml ?? null;
          if (a.kind === 'press' && ring) await telephonyWebhook(h, hookPath(ring, 'url').replace('/voice/screen', '/voice/accept'), { CallSid: 'CAleg', Digits: a.digit });
          if (a.kind === 'dial' && ring) await telephonyWebhook(h, hookPath(ring, 'action'), { CallSid: c.callSid, DialCallStatus: a.status });
          if (a.kind === 'status') await callStatus(h, w, c.callSid, c.from, a.status);
          if (a.kind === 'advance') t()?.advance(a.ms);
          if (a.kind === 'wait') await new Promise((r) => setTimeout(r, a.ms));
        }
        t()?.advance(60_000);
        t()?.resume();
        const r = await settled(h, w.tenantId, c.callId);
        expect(r).not.toBeNull();
        const row = await callRowOf(h, c.callSid);
        const hbs = await handbacksOf(h, c.callId);
        expect(hbs).toHaveLength(1);
        expect(row.handback_action_id).toBe(hbs[0].id);
        expect(row.voice_outcome).not.toBeNull();
        expect([null, owner.userId]).toContain(row.transferred_to_user_id);
        if (row.transfer_outcome !== null) expect(hbs[0].payload.voice.transferOutcome).toBe(row.transfer_outcome);
        if (row.transfer_outcome === 'connected') expect(row.agent_user_id).toBe(owner.userId);
        for (const l of await ledgerOf(h, c.callId)) if (l.args.target_user_id !== undefined) expect(l.args.target_user_id).toBe(owner.userId);
        const appts = (await h.su.query('SELECT user_id, status FROM appointments WHERE contact_id = $1', [contact.id])).rows;
        for (const x of appts) expect(x.user_id).toBe(owner.userId);
        expect(appts.filter((x) => x.status !== 'canceled').length).toBe(r!.handback.booked ? 1 : 0);
      }),
      { numRuns: 25, seed: 4848, endOnFailure: true },
    );
  }, 300_000);
});
