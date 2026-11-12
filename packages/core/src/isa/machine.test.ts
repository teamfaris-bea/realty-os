import { describe, expect, it } from 'vitest';
import { DAY_MS, HOUR_MS, type Instant, at, instant } from '../foundation/index.js';
import { type IsaAction, type IsaEvent, type IsaState, type QueueMessage, heldClasses, initialState, step } from './machine.js';
import { emptyDecision, facts, inbound, NOW, NY } from './testing/fixtures.js';
import type { IsaSlot, UsableQualClaim } from './types.js';

const F = facts();
const T = (ms: number): Instant => instant(NOW + ms);
const start = (side: 'buyer' | 'seller' = 'buyer'): IsaState => step(initialState({ assignmentId: 'a1', side, startedAt: NOW }), { type: 'start', at: NOW }, F).state;
const run = (s: IsaState, events: IsaEvent[], f = F): { state: IsaState; actions: IsaAction[] } => {
  let st = s;
  const actions: IsaAction[] = [];
  for (const e of events) {
    const r = step(st, e, f);
    st = r.state;
    actions.push(...r.actions);
  }
  return { state: st, actions };
};
const kinds = (a: IsaAction[]) => a.map((x) => x.kind);
const queued = (a: IsaAction[]) => a.filter((x): x is QueueMessage => x.kind === 'queue_message');
const handoffs = (a: IsaAction[]) => a.filter((x) => x.kind === 'handoff');
const say = (text: string, o: Parameters<typeof inbound>[1] = {}): IsaEvent => ({ type: 'inbound', at: o.at ?? NOW, messages: [inbound(text, o)] });
const awaiting = (s: IsaState): IsaState => (s.awaitingModel ? s : { ...s, awaitingModel: true });
const SLOTS: IsaSlot[] = [
  { startsAt: at('2026-11-17T20:00:00Z'), endsAt: at('2026-11-17T20:30:00Z') },
  { startsAt: at('2026-11-18T15:00:00Z'), endsAt: at('2026-11-18T15:30:00Z') },
  { startsAt: at('2026-11-17T15:00:00Z'), endsAt: at('2026-11-17T15:30:00Z') },
];

/** Drives a buyer to an offered offer delivered at NOW + 1 h. */
function offered(): IsaState {
  let s = start();
  s = step(s, { type: 'model_output', at: NOW, epoch: 1, decision: emptyDecision({ offerSlots: { kind: 'buyer_consult' } }) }, F).state;
  s = step(s, { type: 'offer_ready', at: NOW, offerId: 'off1', slots: SLOTS, zones: [NY], expiresAt: T(24 * HOUR_MS) }, F).state;
  return step(s, { type: 'send_result', at: T(HOUR_MS), messageId: 'mo', messageKind: 'offer', status: 'sent' }, F).state;
}

describe('R-ISA-5 starting and the model turn', () => {
  it('start asks the model for the first (initiated) message', () => {
    const r = step(initialState({ assignmentId: 'a1', side: 'buyer', startedAt: NOW }), { type: 'start', at: NOW }, F);
    expect(r.state.phase).toBe('engaged');
    expect(r.actions).toEqual([{ kind: 'await_model', repair: false, initiated: true }]);
    expect(step(r.state, { type: 'start', at: NOW }, F).actions).toEqual([]);
  });
  it('a reply is queued as marketing conversation with a follow-up timer; the phase awaits the reply', () => {
    const r = step(start(), { type: 'model_output', at: NOW, epoch: 1, decision: emptyDecision({ reply: { text: 'Hi! What area?' } }) }, F);
    expect(queued(r.actions)).toMatchObject([{ messageKind: 'conversation', purpose: 'marketing', text: 'Hi! What area?' }]);
    expect(r.actions).toContainEqual({ kind: 'schedule_timer', timer: 'follow_up', at: T(3 * DAY_MS) });
    expect(r.state.phase).toBe('awaiting_reply');
  });
  it('an output from an older epoch, or when no model call is pending, is discarded', () => {
    const s = start();
    expect(step(s, { type: 'model_output', at: NOW, epoch: 2, decision: emptyDecision({ reply: { text: 'x' } }) }, F).actions).toEqual([]);
    const done = step(s, { type: 'model_output', at: NOW, epoch: 1, decision: emptyDecision({ reply: { text: 'x' } }) }, F).state;
    expect(step(done, { type: 'model_output', at: NOW, epoch: 1, decision: emptyDecision({ reply: { text: 'y' } }) }, F).actions).toEqual([]);
  });
  it('E510 one schema repair, then a second failure escalates uncertain with one handoff', () => {
    const s = start();
    const r1 = step(s, { type: 'model_failed', at: NOW, epoch: 1, reason: 'schema' }, F);
    expect(r1.actions).toEqual([{ kind: 'await_model', repair: true, initiated: true }]);
    const r2 = step(r1.state, { type: 'model_failed', at: NOW, epoch: 1, reason: 'schema' }, F);
    expect(r2.state.ended).toMatchObject({ reason: 'escalated', escalation: 'uncertain' });
    expect(handoffs(r2.actions)).toHaveLength(1);
    expect(queued(r2.actions)[0]!.lines).toEqual(['uncertain']);
    expect(step(r2.state, { type: 'model_failed', at: NOW, epoch: 1, reason: 'schema' }, F).actions).toEqual([]);
  });
  it('E506 a guard block sends the class line; two in a row escalate uncertain', () => {
    const blocked = emptyDecision({ replyBlocked: { codes: ['VALUATION_TERM'], fallback: 'pricing' } });
    const r1 = step(start(), { type: 'model_output', at: NOW, epoch: 1, decision: blocked }, F);
    expect(queued(r1.actions)[0]!.lines).toEqual(['pricing']);
    const r2 = step(awaiting(r1.state), { type: 'model_output', at: NOW, epoch: 1, decision: emptyDecision({ replyBlocked: { codes: ['FAIR_HOUSING'], fallback: 'fair_housing' } }) }, F);
    expect(r2.state.ended).toMatchObject({ escalation: 'uncertain' });
    const r3 = step(awaiting(r1.state), { type: 'model_output', at: NOW, epoch: 1, decision: emptyDecision({ reply: { text: 'ok' } }) }, F);
    expect(r3.state.counters.guardBlocks).toBe(0);
    const fh = step(start(), { type: 'model_output', at: NOW, epoch: 1, decision: emptyDecision({ replyBlocked: { codes: ['FAIR_HOUSING'], fallback: 'fair_housing' } }) }, F);
    expect(queued(fh.actions)[0]!.lines).toEqual(['fair_housing']);
    const hold = step(start(), { type: 'model_output', at: NOW, epoch: 1, decision: emptyDecision({ replyBlocked: { codes: ['COMMITMENT_TERM'], fallback: 'holding' } }) }, F);
    expect(queued(hold.actions)[0]!.lines).toEqual(['holding']);
  });
  it('facts go without model text; listings, competition and comps (by email)', () => {
    const l = step(start(), { type: 'model_output', at: NOW, epoch: 1, decision: emptyDecision({ shareListings: ['L1'], proposeSavedSearch: true }) }, F);
    expect(queued(l.actions)).toMatchObject([{ messageKind: 'facts', handles: ['L1'], text: null, initiated: true }]);
    expect(kinds(l.actions)).toContain('propose_saved_search');
    const c = step(start('seller'), { type: 'model_output', at: NOW, epoch: 1, decision: emptyDecision({ shareCompetition: ['C1'] }) }, F);
    expect(queued(c.actions)[0]!.handles).toEqual(['C1']);
    const comps = step(start('seller'), { type: 'model_output', at: NOW, epoch: 1, decision: emptyDecision({ sendComps: true }) }, F);
    expect(queued(comps.actions)[0]).toMatchObject({ channel: 'email', handles: ['comps'] });
    const f = step(start(), { type: 'model_output', at: NOW, epoch: 1, decision: emptyDecision({ followUp: '14d' }) }, F);
    expect(f.actions).toEqual([{ kind: 'schedule_timer', timer: 'follow_up', at: T(14 * DAY_MS) }]);
  });
  it('claims are recorded and denials kept as codes only', () => {
    const c: UsableQualClaim = { claimId: 'c1', field: 'beds_min', value: 3, quote: '3 beds', messageId: 'm', saidAt: NOW };
    const r = step(start(), { type: 'model_output', at: NOW, epoch: 1, decision: emptyDecision({ claims: [c], unusableClaims: [{ field: 'budget', source: 'S2', code: 'VALUE_NOT_QUOTED' }], denied: [{ item: 'share_listings', code: 'HANDLE_UNKNOWN', handles: ['L9'] }] }) }, F);
    expect(r.actions[0]).toEqual({ kind: 'denied', codes: ['share_listings:HANDLE_UNKNOWN'] });
    expect(r.actions[1]).toMatchObject({ kind: 'record_claims', claims: [c] });
    expect(r.state.claims).toEqual([c]);
  });
});

describe('R-ISA-6 inbound escalations and precedence', () => {
  it('E490 a plain reply asks the model (no handback), resets unanswered and marks the inbound unanswered', () => {
    const r = step(start(), say('we are looking in Springfield'), F);
    expect(r.actions).toEqual([{ kind: 'await_model', repair: false, initiated: false }]);
    expect(r.state).toMatchObject({ inboundUnanswered: true, phase: 'engaged', awaitingModel: true });
  });
  it('E498 STOP ends care opted_out with a block and no client line', () => {
    const r = step(start(), say('STOP'), F);
    expect(r.state.ended).toMatchObject({ reason: 'opted_out', escalation: 'opt_out' });
    expect(queued(r.actions)).toEqual([]);
    expect(r.actions).toContainEqual({ kind: 'block_person', reason: 'opt_out' });
    expect(handoffs(r.actions)).toHaveLength(1);
  });
  it('E530 safety: the line only when the window is open now; otherwise nothing is sent; critical either way', () => {
    const open = step(start(), say('I want to kill myself'), F);
    expect(queued(open.actions)[0]!.lines).toEqual(['safety']);
    const closed = step(start(), say('I want to kill myself'), facts({ windowOpenNow: false }));
    expect(queued(closed.actions)).toEqual([]);
    expect(handoffs(closed.actions)[0]).toMatchObject({ handoff: { priority: 'critical', escalation: 'safety' } });
  });
  it('E530 consent_dispute, privacy_request, third_party and fraud_risk are terminal with their lines', () => {
    expect(queued(step(start(), say('how did you get my number?'), F).actions)).toEqual([]);
    expect(queued(step(start(), say('please delete my data'), F).actions)[0]!.lines).toEqual(['privacy_request']);
    expect(queued(step(start(), say('this is her husband'), F).actions)[0]!.lines).toEqual(['third_party']);
    expect(queued(step(start(), say('send the deposit to this new account'), F).actions)[0]!.lines).toEqual(['fraud_risk']);
  });
  it('E500 bot question: the truthful line, care continues; a human request ends with its line in the handoff step', () => {
    const bot = step(start(), say('Is this a real person?'), F);
    expect(queued(bot.actions)[0]!.lines).toEqual(['bot_question']);
    expect(bot.state.ended).toBeNull();
    const human = step(start(), say('I want to talk to a real person'), F);
    expect(human.state.ended).toMatchObject({ escalation: 'human_request' });
    expect(kinds(human.actions)).toEqual(['escalate', 'cancel_timers', 'cancel_messages', 'handoff', 'queue_message', 'end']);
  });
  it('E505 "you text too much" and "I don\'t want to text a bot" end with a person block', () => {
    for (const t of ['you text too much', "I don't want to text a bot"]) {
      const r = step(start(), say(t), F);
      expect(r.state.ended).not.toBeNull();
      expect(kinds(r.actions)).toContain('block_person');
    }
  });
  it('E501 "Is it safe? Who lives there?": the area line, terminal fair_housing', () => {
    const r = step(start(), say('Is it safe? Who lives there?'), F);
    expect(r.state.ended).toMatchObject({ escalation: 'fair_housing' });
    expect(queued(r.actions)[0]!.lines).toEqual(['fair_housing']);
  });
  it('E502 E504 hold topics: the pricing or financial line, awaiting_agent, a card once; the same topic again gets only the line', () => {
    const r1 = step(start('seller'), say("what's my home worth?"), F);
    expect(r1.state.phase).toBe('awaiting_agent');
    expect([...heldClasses(r1.state)]).toEqual(['pricing_negotiation']);
    expect(r1.actions).toContainEqual({ kind: 'escalate', class: 'pricing_negotiation', type: 'hold_topic', priority: 'high' });
    expect(queued(r1.actions)[0]!.lines).toEqual(['pricing']);
    const r2 = step(r1.state, say('so what should I list at?'), F);
    expect(kinds(r2.actions)).toEqual(['queue_message']);
    const fin = step(start(), say('What rate can we get?'), F);
    expect(queued(fin.actions)[0]!.lines).toEqual(['financial']);
    // the hold clears when the agent acts; care returns to the previous phase
    const cleared = step(r1.state, { type: 'escalation_resolved', at: NOW, class: 'pricing_negotiation' }, F);
    expect(cleared.state).toMatchObject({ phase: 'engaged', held: [] });
    expect(step(cleared.state, { type: 'escalation_resolved', at: NOW, class: 'financial' }, F).actions).toEqual([]);
  });
  it('a team-configured holding line replaces the class line', () => {
    const r = step(start(), say('What rate can we get?'), facts({ content: { ...F.content, holdingLines: { financial: "That's a question for Avery. I've passed it on." } } }));
    expect(queued(r.actions)[0]!.lines).toEqual(['holding']);
  });
  it('other_agent pauses with a "Check this" card; flood ends care', () => {
    const r = step(start(), say('my agent is handling it'), F);
    expect(r.state.paused).toMatchObject({ reason: 'check_this' });
    expect(r.state.ended).toBeNull();
    const flood = step(start(), say('hello'), facts({ recentInboundCount: 10 }));
    expect(flood.state.ended).toMatchObject({ reason: 'limit_reached', escalation: 'flood' });
  });
  it('E502 B2: a buyer\'s "we want to make an offer" hands off ready_buyer with the ready line', () => {
    const r = step(start(), say('we want to make an offer on it'), F);
    expect(r.state.ended).toMatchObject({ reason: 'ready_buyer' });
    expect(handoffs(r.actions)[0]).toMatchObject({ handoff: { basis: { rule: 'B2' }, priority: 'critical' } });
    expect(queued(r.actions)[0]!.lines).toEqual(['ready']);
  });
  it('E492 two texts 5 s apart are one turn that reads both (one model call)', () => {
    const r = step(start(), { type: 'inbound', at: T(5000), messages: [inbound('hi, we are looking', { seq: 41, at: NOW }), inbound('in Springfield', { seq: 42, at: T(5000) })] }, F);
    expect(r.actions).toEqual([{ kind: 'await_model', repair: false, initiated: false }]);
    expect(r.state.lastInboundSeq).toBe(42);
    // a replay of the same batch (a stuck lease) is a no-op
    expect(step(r.state, { type: 'inbound', at: T(6000), messages: [inbound('hi, we are looking', { seq: 41 }), inbound('in Springfield', { seq: 42 })] }, F).actions).toEqual([]);
  });
  it('inbounds already consumed, or arriving while paused or ended, do nothing', () => {
    const s = step(start(), say('hi', { seq: 5 }), F).state;
    expect(step(s, say('again', { seq: 5 }), F).actions).toEqual([]);
    expect(step(s, { type: 'inbound', at: NOW, messages: [] }, F).actions).toEqual([]);
    const paused = step(s, { type: 'human_control', at: NOW, control: 'pause', byOwner: false }, F).state;
    expect(step(paused, say('hello?', { seq: 9 }), F).actions).toEqual([]);
  });
  it('intents in an email are used only when its own text is reliable and not team text', () => {
    const r = step(start(), say('we want to make an offer', { channel: 'email', ownTextReliable: false }), F);
    expect(r.state.ended).toBeNull();
    const pasted = step(start(), say('we want to make an offer'), facts({ teamTexts: ['Tell me if we want to make an offer soon'] }));
    expect(pasted.state.ended).toBeNull();
  });
});

describe('R-ISA-13 the appointment boundary', () => {
  it('offer requested, ready, delivered: offered with an expiry timer', () => {
    let s = start();
    const r1 = step(s, { type: 'model_output', at: NOW, epoch: 1, decision: emptyDecision({ offerSlots: { kind: 'buyer_consult' } }) }, F);
    expect(r1.actions).toContainEqual({ kind: 'request_offer', appointmentKind: 'buyer_consult' });
    s = r1.state;
    expect(s.phase).toBe('scheduling');
    const r2 = step(s, { type: 'offer_ready', at: NOW, offerId: 'off1', slots: SLOTS, zones: [NY], expiresAt: T(24 * HOUR_MS) }, F);
    expect(queued(r2.actions)).toMatchObject([{ messageKind: 'offer', offerId: 'off1' }]);
    const r3 = step(r2.state, { type: 'send_result', at: T(HOUR_MS), messageId: 'mo', messageKind: 'offer', status: 'sent' }, F);
    expect(r3.state.offer).toMatchObject({ status: 'offered', deliveredAt: T(HOUR_MS) });
    expect(r3.actions).toContainEqual({ kind: 'schedule_timer', timer: 'offer_expiry', at: T(24 * HOUR_MS) });
  });
  it('E528 "2" books slot 2; the booking result hands off appointment_booked and queues the confirmation', () => {
    const r = step(offered(), say('2', { at: T(2 * HOUR_MS) }), F);
    expect(r.actions).toEqual([{ kind: 'book', offerId: 'off1', slotIndex: 1, messageId: expect.any(String) }]);
    expect(r.state.phase).toBe('booking');
    const b = step(r.state, { type: 'booking_result', at: T(3 * HOUR_MS), ok: true, appointmentId: 'ap1' }, F);
    expect(b.state.ended).toMatchObject({ reason: 'appointment_booked' });
    expect(queued(b.actions)).toMatchObject([{ messageKind: 'confirmation', slotIndex: 1, offerId: 'off1' }]);
    expect(handoffs(b.actions)[0]).toMatchObject({ handoff: { appointment: { appointmentId: 'ap1', confirmationQueued: true }, basis: { rule: 'B1' } } });
  });
  it('E529 "2 works. Also what\'s our house worth?": booked first, then one message holds the confirmation and the pricing line', () => {
    const r = step(offered(), say("2 works. Also what's our house worth?", { at: T(2 * HOUR_MS) }), F);
    expect(kinds(r.actions)).toEqual(['book']);
    const b = step(r.state, { type: 'booking_result', at: T(3 * HOUR_MS), ok: true, appointmentId: 'ap1' }, F);
    expect(queued(b.actions)).toHaveLength(1);
    expect(queued(b.actions)[0]).toMatchObject({ messageKind: 'confirmation', lines: ['pricing'] });
    expect(b.state.escalations).toContain('pricing_negotiation');
  });
  it('E529 E508 "Tuesday works" with two Tuesday slots, a reaction, a pasted slot line: one clarification, then uncertain', () => {
    const r1 = step(offered(), say('Tuesday works', { at: T(2 * HOUR_MS) }), F);
    expect(queued(r1.actions)).toMatchObject([{ messageKind: 'offer', lines: ['slot_clarify_intro'] }]);
    const r2 = step(r1.state, say('👍', { at: T(3 * HOUR_MS), reaction: true }), F);
    expect(r2.state.ended).toMatchObject({ escalation: 'uncertain' });
    expect(handoffs(r2.actions)[0]).toMatchObject({ handoff: { openOffer: { offerId: 'off1' } } });
    const pasted = step(offered(), say('Tue Nov 17, 3:00–3:30 PM ET', { at: T(2 * HOUR_MS) }), facts({ teamTexts: ['1) Tue Nov 17, 3:00–3:30 PM ET'] }));
    expect(kinds(pasted.actions)).toEqual(['queue_message']);
  });
  it('E495 an unreliable email answer is never agreement; an answer from before delivery is not read as one', () => {
    const r = step(offered(), say('2', { at: T(2 * HOUR_MS), channel: 'email', ownTextReliable: false }), F);
    expect(kinds(r.actions)).toEqual(['queue_message']);
    const early = step(offered(), say('2', { at: T(30 * 60_000) }), F);
    expect(kinds(early.actions)).toEqual(['await_model']);
  });
  it('a terminal class with an ambiguous slot answer wins over the clarification', () => {
    const r = step(offered(), say('Tuesday, and is it a safe area for families?', { at: T(2 * HOUR_MS) }), F);
    expect(r.state.ended).toMatchObject({ escalation: 'fair_housing' });
  });
  it('E531 SLOT_TAKEN makes a new offer once, then booking_unavailable; never the alternative booked', () => {
    const s = step(offered(), say('2', { at: T(2 * HOUR_MS) }), F).state;
    const f1 = step(s, { type: 'booking_result', at: T(3 * HOUR_MS), ok: false, code: 'SLOT_TAKEN' }, F);
    expect(f1.actions).toEqual([{ kind: 'request_offer', appointmentKind: 'buyer_consult' }]);
    expect(kinds(f1.actions)).not.toContain('book');
    let t = step(f1.state, { type: 'offer_ready', at: T(3 * HOUR_MS), offerId: 'off2', slots: SLOTS, zones: [NY], expiresAt: T(24 * HOUR_MS) }, F).state;
    t = step(t, { type: 'send_result', at: T(4 * HOUR_MS), messageId: 'mo2', messageKind: 'offer', status: 'sent' }, F).state;
    t = step(t, say('1', { at: T(5 * HOUR_MS) }), F).state;
    const f2 = step(t, { type: 'booking_result', at: T(6 * HOUR_MS), ok: false, code: 'SLOT_SOURCE_CHANGED' }, F);
    expect(f2.state.phase).toBe('awaiting_agent');
    expect([...heldClasses(f2.state)]).toEqual(['booking_unavailable']);
    const cal = step(s, { type: 'booking_result', at: T(3 * HOUR_MS), ok: false, code: 'CALENDAR_UNAVAILABLE' }, F);
    expect([...heldClasses(cal.state)]).toEqual(['booking_unavailable']);
    const un = step(step(start(), { type: 'model_output', at: NOW, epoch: 1, decision: emptyDecision({ offerSlots: { kind: 'buyer_consult' } }) }, F).state, { type: 'offer_unavailable', at: NOW }, F);
    expect([...heldClasses(un.state)]).toEqual(['booking_unavailable']);
  });
  it('E523 a pause during the booking: booked, no confirmation queued, the handoff is critical', () => {
    let s = step(offered(), say('2', { at: T(2 * HOUR_MS) }), F).state;
    s = step(s, { type: 'human_control', at: T(2 * HOUR_MS), control: 'pause', byOwner: false }, F).state;
    const b = step(s, { type: 'booking_result', at: T(3 * HOUR_MS), ok: true, appointmentId: 'ap1' }, F);
    expect(b.state.ended).toMatchObject({ reason: 'appointment_booked' });
    expect(queued(b.actions)).toEqual([]);
    expect(handoffs(b.actions)[0]).toMatchObject({ handoff: { appointment: { confirmationQueued: false }, priority: 'critical' } });
    expect(step(s, { type: 'booking_result', at: T(3 * HOUR_MS), ok: false, code: 'SLOT_TAKEN' }, F).actions).toEqual([]);
  });
  it('offer expiry returns to engaged; an offer message that fails or is cancelled drops the offer', () => {
    const e = step(offered(), { type: 'timer', at: T(24 * HOUR_MS), timer: 'offer_expiry' }, F);
    expect(e.state).toMatchObject({ offer: null, phase: 'engaged' });
    expect(step(offered(), { type: 'timer', at: T(2 * HOUR_MS), timer: 'offer_expiry' }, F).state.offer).not.toBeNull();
    let s = step(start(), { type: 'model_output', at: NOW, epoch: 1, decision: emptyDecision({ offerSlots: { kind: 'buyer_consult' } }) }, F).state;
    s = step(s, { type: 'offer_ready', at: NOW, offerId: 'o', slots: SLOTS, zones: [NY], expiresAt: T(HOUR_MS) }, F).state;
    expect(step(s, { type: 'send_result', at: NOW, messageId: 'x', messageKind: 'offer', status: 'undelivered' }, F).state.offer).toBeNull();
    expect(step(s, { type: 'send_result', at: NOW, messageId: 'x', messageKind: 'offer', status: 'canceled' }, F).state.offer).toBeNull();
  });
  it('the model book_slot and an ambiguous model answer', () => {
    const s = awaiting(offered());
    const b = step(s, { type: 'model_output', at: NOW, epoch: 1, decision: emptyDecision({ bookSlot: { offer: 'O1', slotIndex: 2, messageId: 'mx', quote: '3' } }) }, F);
    expect(b.actions).toContainEqual({ kind: 'book', offerId: 'off1', slotIndex: 2, messageId: 'mx' });
    const a1 = step(s, { type: 'model_output', at: NOW, epoch: 1, decision: emptyDecision({ slotAmbiguous: true }) }, F);
    expect(queued(a1.actions)[0]!.lines).toEqual(['slot_clarify_intro']);
    const a2 = step(awaiting(a1.state), { type: 'model_output', at: NOW, epoch: 1, decision: emptyDecision({ slotAmbiguous: true }) }, F);
    expect(a2.state.ended).toMatchObject({ escalation: 'uncertain' });
  });
});

describe('R-ISA-15 controls (core part)', () => {
  it('pause cancels and schedules the 72 h expiry; only the owner resumes, with epoch + 1', () => {
    const p = step(start(), { type: 'human_control', at: NOW, control: 'pause', byOwner: false }, F);
    expect(p.state.paused).toMatchObject({ reason: 'user', byKind: 'user' });
    expect(kinds(p.actions)).toEqual(['pause', 'cancel_messages', 'cancel_timers', 'schedule_timer']);
    expect(step(p.state, { type: 'human_control', at: NOW, control: 'resume', byOwner: false }, F).state.paused).not.toBeNull();
    const r = step(p.state, { type: 'human_control', at: NOW, control: 'resume', byOwner: true }, F);
    expect(r.state).toMatchObject({ paused: null, epoch: 2, phase: 'engaged' });
    expect(r.actions[0]).toEqual({ kind: 'resume', epoch: 2 });
    expect(step(start(), { type: 'human_control', at: NOW, control: 'resume', byOwner: true }, F).actions).toEqual([]);
  });
  it('E513 the pause expires after 72 h with a handoff', () => {
    const p = step(start(), { type: 'human_control', at: NOW, control: 'pause', byOwner: false }, F).state;
    expect(step(p, { type: 'timer', at: T(71 * HOUR_MS), timer: 'pause_expiry' }, F).state.ended).toBeNull();
    expect(step(p, { type: 'timer', at: T(72 * HOUR_MS), timer: 'pause_expiry' }, F).state.ended).toMatchObject({ reason: 'pause_expired' });
  });
  it('E496 take over: an immediate pause, Undo leaves it paused, finalize ends taken_over', () => {
    const t = step(start(), { type: 'human_control', at: NOW, control: 'take_over', byOwner: false }, F).state;
    expect(t.paused?.reason).toBe('taking_over');
    expect(step(t, { type: 'human_control', at: NOW, control: 'resume', byOwner: true }, F).state.paused).not.toBeNull();
    const undone = step(t, { type: 'human_control', at: NOW, control: 'undo', byOwner: false }, F).state;
    expect(undone).toMatchObject({ paused: { reason: 'user' }, ended: null });
    expect(step(undone, { type: 'human_control', at: NOW, control: 'finalize', byOwner: false }, F).state.ended).toBeNull();
    expect(step(t, { type: 'human_control', at: NOW, control: 'finalize', byOwner: false }, F).state.ended).toMatchObject({ reason: 'taken_over' });
    const e = step(start(), { type: 'human_control', at: NOW, control: 'end', byOwner: false }, F).state;
    expect(step(e, { type: 'human_control', at: NOW, control: 'finalize', byOwner: false }, F).state.ended).toMatchObject({ reason: 'ended_by_user' });
    expect(step(start(), { type: 'human_control', at: NOW, control: 'undo', byOwner: false }, F).actions).toEqual([]);
  });
  it('E496 a human contact pauses human_contact; a pause on a paused state keeps one pause', () => {
    const h = step(start(), { type: 'human_contact', at: NOW }, F);
    expect(h.state.paused?.reason).toBe('human_contact');
    expect(step(h.state, { type: 'human_contact', at: NOW }, F).actions).toEqual([]);
    expect(step(h.state, { type: 'human_control', at: NOW, control: 'pause', byOwner: false }, F).state.paused?.reason).toBe('user');
  });
  it('E491 E522 the link-failure table: hold changes nothing, pause pauses, end ends', () => {
    const s = start();
    expect(step(s, { type: 'authorization_lost', at: NOW, effect: 'hold' }, F)).toEqual({ state: s, actions: [] });
    expect(step(s, { type: 'authorization_lost', at: NOW, effect: 'pause', pauseReason: 'approval_revoked' }, F).state.paused?.reason).toBe('approval_revoked');
    expect(step(s, { type: 'authorization_lost', at: NOW, effect: 'pause' }, F).state.paused?.reason).toBe('pack_withdrawn');
    expect(step(s, { type: 'authorization_lost', at: NOW, effect: 'end', endReason: 'optin_revoked' }, F).state.ended?.reason).toBe('optin_revoked');
    expect(step(s, { type: 'authorization_lost', at: NOW, effect: 'end' }, F).state.ended?.reason).toBe('tenant_off');
  });
  it('E498 E499 E525 E526 stop signals end care (owner change, merge, opt-outs); blocks where the end sets one', () => {
    for (const reason of ['opted_out', 'suppressed', 'do_not_contact', 'wrong_number', 'owner_change', 'merged'] as const) {
      const r = step(start(), { type: 'stop_signal', at: NOW, reason }, F);
      expect(r.state.ended?.reason).toBe(reason);
      expect(kinds(r.actions).includes('block_person')).toBe(['opted_out', 'do_not_contact', 'wrong_number'].includes(reason));
    }
  });
});

describe('R-ISA-11 E518 limits, timers and send results', () => {
  it('follow-up timers ask for an initiated message; 7th unanswered ends dormant; slow cadence after 3', () => {
    let s = step(start(), { type: 'model_output', at: NOW, epoch: 1, decision: emptyDecision({ reply: { text: 'hi' } }) }, F).state;
    for (let k = 1; k <= 6; k++) {
      const r = step(s, { type: 'timer', at: T(k * DAY_MS), timer: 'follow_up' }, F);
      expect(r.actions).toEqual([{ kind: 'await_model', repair: false, initiated: true }]);
      s = step(r.state, { type: 'model_output', at: T(k * DAY_MS), epoch: 1, decision: emptyDecision({ reply: { text: 'checking in' } }) }, F).state;
    }
    expect(s.counters.unansweredInitiated).toBe(6);
    const slow = step(awaiting(s), { type: 'model_output', at: NOW, epoch: 1, decision: emptyDecision({ reply: { text: 'x' } }) }, F);
    expect(slow.actions).toContainEqual({ kind: 'schedule_timer', timer: 'follow_up', at: T(14 * DAY_MS) });
    expect(step(s, { type: 'timer', at: T(7 * DAY_MS), timer: 'follow_up' }, F).state.ended).toMatchObject({ reason: 'dormant' });
    expect(step({ ...start(), awaitingModel: false }, { type: 'timer', at: T(181 * DAY_MS), timer: 'follow_up' }, F).state.ended).toMatchObject({ reason: 'limit_reached' });
    expect(step(start(), { type: 'timer', at: NOW, timer: 'follow_up' }, F).actions).toEqual([]);
  });
  it('E516 the inactivity warning hands off', () => {
    expect(step(start(), { type: 'timer', at: NOW, timer: 'inactivity_warning' }, F).state.ended).toMatchObject({ reason: 'inactivity_warning' });
  });
  it('E518 two undelivered in a row end delivery_problem; a delivery resets the streak', () => {
    let s = start();
    s = step(s, { type: 'send_result', at: NOW, messageId: 'a', messageKind: 'conversation', status: 'undelivered' }, F).state;
    s = step(s, { type: 'send_result', at: NOW, messageId: 'b', messageKind: 'conversation', status: 'delivered' }, F).state;
    expect(s.counters.undeliveredStreak).toBe(0);
    s = step(s, { type: 'send_result', at: NOW, messageId: 'c', messageKind: 'conversation', status: 'failed' }, F).state;
    expect(step(s, { type: 'send_result', at: NOW, messageId: 'd', messageKind: 'conversation', status: 'undelivered' }, F).state.ended).toMatchObject({ reason: 'delivery_problem' });
  });
  it('the 40th sent message ends limit_reached', () => {
    const s = { ...start(), counters: { ...start().counters, messagesSent: 39 } };
    expect(step(s, { type: 'send_result', at: NOW, messageId: 'x', messageKind: 'conversation', status: 'sent' }, F).state.ended).toMatchObject({ reason: 'limit_reached', escalation: 'limit' });
  });
  it('R-ISA-31 a guard opt-out refusal ends care; other refusals do not', () => {
    expect(step(start(), { type: 'send_result', at: NOW, messageId: 'x', messageKind: 'conversation', status: 'blocked', reasonCodes: ['RECIPIENT_OPTED_OUT'] }, F).state.ended).toMatchObject({ reason: 'opted_out' });
    expect(step(start(), { type: 'send_result', at: NOW, messageId: 'x', messageKind: 'conversation', status: 'blocked', reasonCodes: ['ISA_QUIET_HOURS'] }, F).state.ended).toBeNull();
    expect(step(start(), { type: 'send_result', at: NOW, messageId: 'x', messageKind: 'conversation', status: 'dispatch_unknown' }, F).actions).toEqual([]);
  });
  it('listing events queue facts without a model call (not while booking)', () => {
    expect(queued(step(start(), { type: 'listing_event', at: NOW, factKind: 'listings', handles: ['L1'] }, F).actions)).toMatchObject([{ messageKind: 'facts', handles: ['L1'] }]);
    expect(step(start(), { type: 'listing_event', at: NOW, factKind: 'listings', handles: [] }, F).actions).toEqual([]);
  });
  it('a model end proposal pauses with a check-this card; it never ends care by itself', () => {
    const r = step(start(), { type: 'model_output', at: NOW, epoch: 1, decision: emptyDecision({ endProposal: { reason: 'has_agent', messageId: 'm' } }) }, F);
    expect(r.state).toMatchObject({ ended: null, paused: { reason: 'check_this' } });
    const n = step(start(), { type: 'model_output', at: NOW, epoch: 1, decision: emptyDecision({ endProposal: { reason: 'not_interested', messageId: 'm' } }) }, F);
    expect(n.state.paused?.reason).toBe('check_this');
  });
  it('a model escalation adds a class: terminal ends, a held class is not re-raised', () => {
    expect(step(start(), { type: 'model_output', at: NOW, epoch: 1, decision: emptyDecision({ escalations: ['legal_contract'] }) }, F).state.ended).toMatchObject({ escalation: 'legal_contract' });
    const held = step(start(), say('What rate can we get?'), F).state;
    const r = step(awaiting(held), { type: 'model_output', at: NOW, epoch: 1, decision: emptyDecision({ escalations: ['financial'], reply: { text: 'Got it' } }) }, F);
    expect(queued(r.actions)[0]!.text).toBe('Got it');
  });
  it('readiness after claims ends care ready (B3) from the model turn', () => {
    const cl = (field: UsableQualClaim['field'], value: UsableQualClaim['value']): UsableQualClaim => ({ claimId: field, field, value, quote: 'q', messageId: 'm', saidAt: NOW });
    const claims = [cl('timeline', 'in 2 months'), cl('financing_status_stated', 'cash'), cl('areas', ['Springfield']), cl('budget', 400000), cl('beds_min', 2)];
    const r = step(start(), { type: 'model_output', at: NOW, epoch: 1, decision: emptyDecision({ claims, reply: { text: 'Great' } }) }, F);
    expect(r.state.ended).toMatchObject({ reason: 'ready_buyer' });
    expect(handoffs(r.actions)[0]).toMatchObject({ handoff: { basis: { rule: 'B3', claimIds: ['timeline', 'financing_status_stated', 'areas', 'budget', 'beds_min'] } } });
  });
  it('events after the end change nothing', () => {
    const e = step(start(), say('STOP'), F).state;
    for (const ev of [say('hi', { seq: 99 }), { type: 'timer', at: NOW, timer: 'follow_up' }, { type: 'human_control', at: NOW, control: 'resume', byOwner: true }, { type: 'stop_signal', at: NOW, reason: 'merged' }, { type: 'escalation_resolved', at: NOW, class: 'financial' }, { type: 'booking_result', at: NOW, ok: true, appointmentId: 'x' }, { type: 'offer_ready', at: NOW, offerId: 'o', slots: [], zones: [], expiresAt: NOW }, { type: 'offer_unavailable', at: NOW }, { type: 'send_result', at: NOW, messageId: 'x', messageKind: 'conversation', status: 'sent' }] as IsaEvent[]) {
      expect(step(e, ev, F)).toEqual({ state: e, actions: [] });
    }
    void run;
  });
});
