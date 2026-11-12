// Property tests of the policy machine (docs/AI_ISA.md §13.1): over random event sequences.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { HOUR_MS, type Instant, at, instant } from '../foundation/index.js';
import { type IsaEvent, type IsaInbound, type IsaState, initialState, step } from './machine.js';
import { matchSlotChoice } from './slots.js';
import { MUST_ESCALATE, MUST_NOT_ESCALATE, NEGATED, classify, emptyDecision, facts, NY } from './testing/fixtures.js';
import { ESCALATION_CLASSES, type IsaSlot } from './types.js';
import { runs } from './testing/runs.js';

const T0 = at('2026-11-12T15:00:00Z');
const F = facts();
const SLOTS: IsaSlot[] = [
  { startsAt: at('2026-11-17T20:00:00Z'), endsAt: at('2026-11-17T20:30:00Z') },
  { startsAt: at('2026-11-18T15:00:00Z'), endsAt: at('2026-11-18T15:30:00Z') },
];
const TEXTS = [...Object.values(MUST_ESCALATE).flat(), ...Object.values(NEGATED).flat(), ...MUST_NOT_ESCALATE, '1', '2', '3', 'yes', 'Tuesday at 3pm', 'we want to make an offer', 'can we see it'];

function inb(text: string, seq: number, atMs: number, o: Partial<IsaInbound> = {}): IsaInbound {
  return { seq, messageId: `m${seq}`, channel: 'sms', at: instant(atMs), ownText: text, ownTextReliable: true, classification: classify(text), reaction: false, ...o };
}

/** An arbitrary event; `k` orders time and inbound seqs. */
const eventArb = (k: number): fc.Arbitrary<IsaEvent> => {
  const t = instant(T0 + k * HOUR_MS);
  return fc.oneof(
    fc.record({ text: fc.constantFrom(...TEXTS), reaction: fc.boolean(), email: fc.boolean(), reliable: fc.boolean() }).map(
      (r): IsaEvent => ({ type: 'inbound', at: t, messages: [inb(r.text, k + 1, t, { reaction: r.reaction, channel: r.email ? 'email' : 'sms', ownTextReliable: r.reliable })] }),
    ),
    fc.constantFrom<IsaEvent>(
      { type: 'model_output', at: t, epoch: 1, decision: emptyDecision({ reply: { text: 'Got it' } }) },
      { type: 'model_output', at: t, epoch: 1, decision: emptyDecision({ offerSlots: { kind: 'buyer_consult' } }) },
      { type: 'model_output', at: t, epoch: 1, decision: emptyDecision({ shareListings: ['L1'] }) },
      { type: 'model_output', at: t, epoch: 1, decision: emptyDecision({ replyBlocked: { codes: ['VALUATION_TERM'], fallback: 'pricing' } }) },
      { type: 'model_output', at: t, epoch: 2, decision: emptyDecision({ reply: { text: 'stale epoch' } }) },
      { type: 'model_failed', at: t, epoch: 1, reason: 'schema' },
      { type: 'offer_ready', at: t, offerId: `o${k}`, slots: SLOTS, zones: [NY], expiresAt: instant(t + 24 * HOUR_MS) },
      { type: 'offer_unavailable', at: t },
      { type: 'send_result', at: t, messageId: `s${k}`, messageKind: 'offer', status: 'sent' },
      { type: 'send_result', at: t, messageId: `s${k}`, messageKind: 'conversation', status: 'undelivered' },
      { type: 'send_result', at: t, messageId: `s${k}`, messageKind: 'conversation', status: 'blocked', reasonCodes: ['CONSENT_REVOKED'] },
      { type: 'booking_result', at: t, ok: true, appointmentId: `ap${k}` },
      { type: 'booking_result', at: t, ok: false, code: 'SLOT_TAKEN' },
      { type: 'human_control', at: t, control: 'pause', byOwner: false },
      { type: 'human_control', at: t, control: 'resume', byOwner: true },
      { type: 'human_control', at: t, control: 'resume', byOwner: false },
      { type: 'human_control', at: t, control: 'take_over', byOwner: false },
      { type: 'human_control', at: t, control: 'undo', byOwner: false },
      { type: 'human_control', at: t, control: 'finalize', byOwner: false },
      { type: 'human_contact', at: t },
      { type: 'authorization_lost', at: t, effect: 'hold' },
      { type: 'authorization_lost', at: t, effect: 'pause', pauseReason: 'pack_withdrawn' },
      { type: 'authorization_lost', at: t, effect: 'end', endReason: 'tenant_off' },
      { type: 'stop_signal', at: t, reason: 'opted_out' },
      { type: 'timer', at: t, timer: 'follow_up' },
      { type: 'timer', at: t, timer: 'offer_expiry' },
      { type: 'timer', at: t, timer: 'pause_expiry' },
      { type: 'escalation_resolved', at: t, class: 'pricing_negotiation' },
      { type: 'listing_event', at: t, factKind: 'listings', handles: ['L2'] },
    ),
  );
};

const sequenceArb = fc.integer({ min: 1, max: 30 }).chain((n) => fc.tuple(...Array.from({ length: n }, (_, k) => eventArb(k))));

/** A state with an offer delivered at T0 − 1 h (so inbounds in the sequence can answer it). */
function offeredStart(): IsaState {
  const t = instant(T0 - 3 * HOUR_MS);
  let s = step(initialState({ assignmentId: 'a', side: 'both', startedAt: t }), { type: 'start', at: t }, F).state;
  s = step(s, { type: 'model_output', at: t, epoch: 1, decision: emptyDecision({ offerSlots: { kind: 'buyer_consult' } }) }, F).state;
  s = step(s, { type: 'offer_ready', at: t, offerId: 'o0', slots: SLOTS, zones: [NY], expiresAt: instant(T0 + 48 * HOUR_MS) }, F).state;
  return step(s, { type: 'send_result', at: instant(T0 - HOUR_MS), messageId: 'so', messageKind: 'offer', status: 'sent' }, F).state;
}

function start(): IsaState {
  return step(initialState({ assignmentId: 'a', side: 'both', startedAt: T0 }), { type: 'start', at: T0 }, F).state;
}

describe('R-ISA-14 R-ISA-5 policy machine properties', () => {
  it('exactly one handoff per assignment once ended, never more; no message is queued from a paused or ended state; escalations only grow', () => {
    fc.assert(
      fc.property(sequenceArb, fc.boolean(), (events, fromOffer) => {
        let s = fromOffer ? offeredStart() : start();
        let handoffs = 0;
        for (const e of events) {
          const before = s;
          const r = step(s, e, F);
          handoffs += r.actions.filter((a) => a.kind === 'handoff').length;
          if (before.ended !== null || before.paused !== null) expect(r.actions.filter((a) => a.kind === 'queue_message')).toEqual([]);
          expect(r.state.escalations.slice(0, before.escalations.length)).toEqual(before.escalations);
          for (const c of r.state.escalations) expect(ESCALATION_CLASSES).toContain(c);
          if (before.ended !== null) expect(r.state).toBe(before);
          s = r.state;
          expect(handoffs).toBeLessThanOrEqual(1);
          expect(s.handoffs).toBe(handoffs);
        }
        expect(handoffs === 1).toBe(s.ended !== null);
      }),
      { numRuns: runs(1500) },
    );
  });
  it('book only after the offer was delivered, and (from an inbound) only on a verified, unique own-text match', () => {
    let books = 0;
    fc.assert(
      fc.property(sequenceArb, fc.boolean(), (events, fromOffer) => {
        let s = fromOffer ? offeredStart() : start();
        for (const e of events) {
          const before = s;
          const r = step(s, e, F);
          for (const a of r.actions) {
            if (a.kind !== 'book') continue;
            books += 1;
            expect(before.offer?.status).toBe('offered');
            expect(before.offer?.deliveredAt).not.toBeNull();
            expect(before.ended).toBeNull();
            expect(before.paused).toBeNull();
            if (e.type === 'inbound') {
              const o = before.offer!;
              const unique = e.messages.filter((m) => m.at > (o.deliveredAt as Instant) && (m.channel === 'sms' || m.ownTextReliable) && !m.reaction).map((m) => matchSlotChoice(m.ownText, o.slots, o.zones));
              expect(unique.some((u) => u.kind === 'unique' && u.index === a.slotIndex)).toBe(true);
            } else expect(e.type).toBe('model_output');
          }
          s = r.state;
        }
      }),
      { numRuns: runs(1500) },
    );
    // the generator reaches bookings, so the property is not vacuous
    expect(books).toBeGreaterThan(0);
  });
  it('permutation invariance: the order of an inbound batch does not change the result', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...TEXTS), { minLength: 1, maxLength: 5 }), fc.integer({ min: 0, max: 1000 }), (texts, seed) => {
        const batch = texts.map((t, k) => inb(t, k + 1, T0 + k * 1000));
        const shuffled = [...batch].sort((a, b) => ((a.seq * 7919 + seed) % 101) - ((b.seq * 7919 + seed) % 101));
        const s = start();
        expect(step(s, { type: 'inbound', at: T0, messages: shuffled }, F)).toEqual(step(s, { type: 'inbound', at: T0, messages: batch }, F));
      }),
      { numRuns: runs(500) },
    );
  });
  it('determinism: the same state and event give the same result', () => {
    fc.assert(
      fc.property(sequenceArb, (events) => {
        let a = start();
        let b = start();
        for (const e of events) {
          const ra = step(a, e, F);
          const rb = step(b, e, F);
          expect(ra).toEqual(rb);
          a = ra.state;
          b = rb.state;
        }
      }),
      { numRuns: runs(300) },
    );
  });
});
