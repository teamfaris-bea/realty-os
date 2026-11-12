// Golden traces of core/isa (docs/AI_ISA.md §13.1, mutation coverage): scripted journeys through the machine and
// corpora through every decision function, compared IN FULL against committed snapshots. A behaviour change shows up
// as a snapshot diff that a reviewer must accept on purpose. The unit tests state the rules; these pin the exact
// outputs (phases, priorities, commitments, codes, lines, timers).
import { describe, expect, it } from 'vitest';
import { DAY_MS, HOUR_MS, type Instant, at, instant, zone } from '../foundation/index.js';
import { aiIsaConsentBasis, consentBasisSentence, type ConsentBasisInput } from './consent.js';
import { isaGuard } from './guard.js';
import { type IsaEvent, type IsaState, initialState, step } from './machine.js';
import { clientOwnText, isTeamText, qualValueQuoted, timelineDays } from './ownText.js';
import { intentSignals, readiness } from './readiness.js';
import { capsCheck, messageKind, planSend } from './sendPolicy.js';
import { inboundSignals, questionClauses, requestFrame } from './signals.js';
import { computeOffer, formatSlot, matchSlotChoice, renderOffer } from './slots.js';
import { MUST_ESCALATE, MUST_NOT_ESCALATE, NEGATED, classify, emptyDecision, facts, IDENTITY, inbound, NY, LA } from './testing/fixtures.js';
import type { IsaSlot, UsableQualClaim } from './types.js';
import { aiIsaRecipientZones, aiIsaSendWindow } from './zones.js';

const T0 = at('2026-11-12T15:00:00Z');
const T = (h: number): Instant => instant(T0 + h * HOUR_MS);
const SLOTS: IsaSlot[] = [
  { startsAt: at('2026-11-17T20:00:00Z'), endsAt: at('2026-11-17T20:30:00Z') },
  { startsAt: at('2026-11-18T15:00:00Z'), endsAt: at('2026-11-18T15:30:00Z') },
  { startsAt: at('2026-11-17T15:00:00Z'), endsAt: at('2026-11-17T15:30:00Z') },
];
const say = (text: string, h: number, seq: number, o: Parameters<typeof inbound>[1] = {}): IsaEvent => ({ type: 'inbound', at: T(h), messages: [inbound(text, { seq, at: T(h), messageId: `m${seq}`, ...o })] });
const model = (h: number, d: Parameters<typeof emptyDecision>[0], epoch = 1): IsaEvent => ({ type: 'model_output', at: T(h), epoch, decision: emptyDecision(d) });
const claim = (field: UsableQualClaim['field'], value: UsableQualClaim['value']): UsableQualClaim => ({ claimId: `c-${field}`, field, value, quote: String(value), messageId: 'mq', saidAt: T0 });

function trace(side: 'buyer' | 'seller' | 'both', events: IsaEvent[], f = facts()): { phase: string; state: Partial<IsaState>; actions: unknown[] }[] {
  let s = initialState({ assignmentId: 'a1', side, startedAt: T0 });
  const out: { phase: string; state: Partial<IsaState>; actions: unknown[] }[] = [];
  for (const e of [{ type: 'start', at: T0 } as IsaEvent, ...events]) {
    const r = step(s, e, f);
    s = r.state;
    const { assignmentId: _a, startedAt: _s, ...rest } = s;
    out.push({ phase: `${e.type}${e.type === 'human_control' ? `:${e.control}` : ''}`, state: rest, actions: r.actions });
  }
  return out;
}

const offerPrefix = (h0: number): IsaEvent[] => [
  model(h0, { offerSlots: { kind: 'buyer_consult' } }),
  { type: 'offer_ready', at: T(h0), offerId: 'off1', slots: SLOTS, zones: [NY], expiresAt: T(h0 + 24) },
  { type: 'send_result', at: T(h0 + 1), messageId: 'mo', messageKind: 'offer', status: 'sent' },
];

describe('golden journeys through step()', () => {
  const journeys: Record<string, () => ReturnType<typeof trace>> = {
    buyer_reply_then_ready: () => trace('buyer', [model(0, { reply: { text: 'Hi! What area?' } }), { type: 'send_result', at: T(0.1), messageId: 'x1', messageKind: 'conversation', status: 'sent' }, say('we want to make an offer on it', 1, 1)]),
    buyer_b3_from_claims: () => trace('buyer', [say('hello', 1, 1), model(1, { claims: [claim('timeline', 'in 2 months'), claim('financing_status_stated', 'preapproved'), claim('areas', ['Springfield']), claim('budget', 450000), claim('beds_min', 3)] })]),
    seller_pricing_hold_then_resolved: () => trace('seller', [say("what's my home worth?", 1, 1), say('and what should I list at?', 2, 2), { type: 'escalation_resolved', at: T(3), class: 'pricing_negotiation' }, say('ok thanks', 4, 3)]),
    two_holds_and_one_card: () => trace('buyer', [say('What rate can we get? and should we make an offer?', 1, 1)]),
    booking_with_hold_line: () => trace('buyer', [...offerPrefix(0), say("2 works. Also what's our house worth?", 2, 1), { type: 'booking_result', at: T(3), ok: true, appointmentId: 'ap1' }]),
    booking_seller: () => trace('seller', [model(0, { offerSlots: { kind: 'listing_appointment' } }), { type: 'offer_ready', at: T(0), offerId: 'off1', slots: SLOTS, zones: [NY], expiresAt: T(24) }, { type: 'send_result', at: T(1), messageId: 'mo', messageKind: 'offer', status: 'delivered' }, { type: 'send_result', at: T(1), messageId: 'mo', messageKind: 'offer', status: 'sent' }, say('1', 2, 1), { type: 'booking_result', at: T(3), ok: true, appointmentId: 'ap1' }]),
    slot_clarify_then_uncertain: () => trace('buyer', [...offerPrefix(0), say('Tuesday works', 2, 1), say('yes', 3, 2)]),
    slot_two_unique_disagree: () => trace('buyer', [...offerPrefix(0), { type: 'inbound', at: T(2), messages: [inbound('1', { seq: 1, at: T(2) }), inbound('2', { seq: 2, at: T(2) })] }]),
    slot_ambiguous_with_hold: () => trace('buyer', [...offerPrefix(0), say('Tuesday? also what rate can we get?', 2, 1)]),
    booking_taken_twice: () => trace('buyer', [...offerPrefix(0), say('2', 2, 1), { type: 'booking_result', at: T(3), ok: false, code: 'SLOT_TAKEN' }, { type: 'offer_ready', at: T(3), offerId: 'off2', slots: SLOTS, zones: [NY], expiresAt: T(27) }, { type: 'send_result', at: T(4), messageId: 'mo2', messageKind: 'offer', status: 'sent' }, say('3', 5, 2), { type: 'booking_result', at: T(6), ok: false, code: 'SLOT_TAKEN' }]),
    booking_member_inactive: () => trace('buyer', [...offerPrefix(0), say('2', 2, 1), { type: 'booking_result', at: T(3), ok: false, code: 'MEMBER_NOT_ACTIVE' }]),
    pause_resume_epoch: () => trace('buyer', [{ type: 'human_control', at: T(1), control: 'pause', byOwner: false }, { type: 'human_control', at: T(2), control: 'resume', byOwner: true }, model(3, { reply: { text: 'old' } }, 1), say('hi', 4, 1), model(4, { reply: { text: 'new' } }, 2)]),
    pause_during_scheduling_resume: () => trace('buyer', [...offerPrefix(0), { type: 'human_control', at: T(2), control: 'pause', byOwner: false }, { type: 'human_control', at: T(3), control: 'resume', byOwner: true }]),
    take_over_undo_finalize: () => trace('buyer', [{ type: 'human_control', at: T(1), control: 'take_over', byOwner: false }, { type: 'human_control', at: T(1), control: 'undo', byOwner: false }, { type: 'human_control', at: T(1), control: 'finalize', byOwner: false }, { type: 'timer', at: T(80), timer: 'pause_expiry' }]),
    end_finalize: () => trace('buyer', [{ type: 'human_control', at: T(1), control: 'end', byOwner: false }, { type: 'human_control', at: T(1), control: 'finalize', byOwner: false }]),
    follow_ups_to_dormant: () => trace('buyer', [model(0, { reply: { text: 'hi' } }), ...[1, 2, 3, 4, 5, 6, 7].flatMap((d) => [{ type: 'timer', at: T(d * 72), timer: 'follow_up' } as IsaEvent, model(d * 72, { reply: { text: 'checking in' } })])]),
    follow_up_in_hold: () => trace('buyer', [say('What rate can we get?', 1, 1), { type: 'timer', at: T(72), timer: 'follow_up' }]),
    delivery_problem: () => trace('buyer', [{ type: 'send_result', at: T(1), messageId: 'a', messageKind: 'conversation', status: 'failed' }, { type: 'send_result', at: T(2), messageId: 'b', messageKind: 'conversation', status: 'undelivered' }]),
    guard_blocks: () => trace('buyer', [model(0, { replyBlocked: { codes: ['VALUATION_TERM'], fallback: 'pricing' } }), say('hm', 1, 1), model(1, { replyBlocked: { codes: ['FAIR_HOUSING'], fallback: 'fair_housing' } })]),
    schema_failures: () => trace('buyer', [say('hello', 1, 1), { type: 'model_failed', at: T(1), epoch: 1, reason: 'schema' }, { type: 'model_failed', at: T(1), epoch: 2, reason: 'schema' }, { type: 'model_failed', at: T(1), epoch: 1, reason: 'provider' }]),
    safety_outside_window: () => trace('buyer', [say('I want to kill myself', 1, 1)], facts({ windowOpenNow: false })),
    flood_unanswered: () => trace('buyer', [say('hello', 1, 1)], facts({ recentInboundCount: 12 })),
    stop_and_late_events: () => trace('buyer', [say('STOP', 1, 1), say('hi', 2, 2), { type: 'stop_signal', at: T(3), reason: 'merged' }]),
    stop_signals: () => (['opted_out', 'suppressed', 'do_not_contact', 'wrong_number', 'owner_change', 'merged'] as const).flatMap((reason) => trace('both', [{ type: 'stop_signal', at: T(1), reason }])),
    authorization: () => [...trace('buyer', [{ type: 'authorization_lost', at: T(1), effect: 'pause', pauseReason: 'reinquiry' }, { type: 'authorization_lost', at: T(2), effect: 'end', endReason: 'owner_inactive' }]), ...trace('buyer', [{ type: 'authorization_lost', at: T(1), effect: 'hold' }])],
    human_contact_and_check_this: () => trace('buyer', [say('my agent is handling it', 1, 1), { type: 'human_contact', at: T(2) }, { type: 'human_control', at: T(3), control: 'resume', byOwner: true }]),
    model_end_and_escalations: () => [...trace('buyer', [model(0, { endProposal: { reason: 'not_a_lead', messageId: 'm' } })]), ...trace('buyer', [model(0, { escalations: ['data_unavailable', 'financial'] })]), ...trace('seller', [model(0, { sendComps: true, followUp: '30d' })]), ...trace('buyer', [model(0, { shareListings: ['L1', 'L2'], proposeSavedSearch: true, followUp: '7d' })])],
    listing_events: () => trace('buyer', [{ type: 'listing_event', at: T(1), factKind: 'listings', handles: ['L1'] }, ...offerPrefix(2), say('2', 4, 1), { type: 'listing_event', at: T(5), factKind: 'competition', handles: ['C1'] }]),
    offer_lifecycle: () => trace('buyer', [model(0, { offerSlots: { kind: 'consult' } }), { type: 'offer_unavailable', at: T(1) }, { type: 'escalation_resolved', at: T(2), class: 'booking_unavailable' }, { type: 'timer', at: T(3), timer: 'offer_expiry' }]),
    offer_expiry: () => trace('buyer', [...offerPrefix(0), { type: 'timer', at: T(10), timer: 'offer_expiry' }, { type: 'timer', at: T(25), timer: 'offer_expiry' }]),
    bot_and_ack: () => trace('buyer', [say('are you a bot?', 1, 1), say('thanks!', 2, 2)]),
    limit_messages: () => trace('buyer', Array.from({ length: 40 }, (_, k) => ({ type: 'send_result', at: T(k), messageId: `s${k}`, messageKind: 'conversation', status: 'sent' }) as IsaEvent)),
    inactivity_and_max_days: () => [...trace('buyer', [{ type: 'timer', at: T(1), timer: 'inactivity_warning' }]), ...trace('buyer', [model(0, { reply: { text: 'x' } }), { type: 'timer', at: T(181 * 24), timer: 'follow_up' }])],
  };
  for (const [name, fn] of Object.entries(journeys)) it(`journey ${name}`, () => expect(fn()).toMatchSnapshot());
});

describe('golden corpora', () => {
  const TEXTS = [...Object.values(MUST_ESCALATE).flat(), ...Object.values(NEGATED).flat(), ...MUST_NOT_ESCALATE];
  it('inboundSignals over every fixture phrase', () => {
    expect(TEXTS.map((t) => [t, inboundSignals({ ownText: t, classification: classify(t) })])).toMatchSnapshot();
    expect(TEXTS.map((t) => [t, requestFrame(t, 'financial'), requestFrame(t, 'pricing_negotiation'), questionClauses(t)])).toMatchSnapshot();
  });
  it('clientOwnText over an email corpus', () => {
    const bodies = [
      'plain',
      'line one\r\nline two',
      'top\n> quoted\n> more',
      '> q\nanswer',
      'a\n\nOn Mon, Nov 16, 2026 at 9:00 AM X <x@example.test> wrote:\n> b',
      'a\n-----Original Message-----\nb',
      'a\n---------- Forwarded message ---------\nb',
      'a\n_________________\nFrom: b',
      'a\nFrom: Team <t@example.test>\nTo: me\nSent: Monday\nb',
      'a\n-- \nsig',
      'a\nSent from my Galaxy',
      'see you then\nwrote:',
      'To: someone',
      ' '.repeat(5),
      'x'.repeat(1700),
      'first\n\nSent from my iPhone\n\nOn Mon, X wrote:\n> y',
    ];
    expect(bodies.map((b) => [b.slice(0, 40), clientOwnText(b, 'email'), clientOwnText(b, 'sms').reliable])).toMatchSnapshot();
  });
  it('qualValueQuoted, timelineDays, isTeamText and intents over a corpus', () => {
    const ctx = (own: string) => ({ ownText: own, saidAt: T0, zone: NY });
    const cases: [Parameters<typeof qualValueQuoted>[0], Parameters<typeof qualValueQuoted>[1], string, string][] = [
      ['financing_status_stated', 'preapproved', 'we are preapproved', 'we are preapproved'],
      ['financing_status_stated', 'preapproved', 'preapproved', "we haven't been preapproved"],
      ['financing_status_stated', 'cash', 'cash', 'no cash, a loan'],
      ['financing_status_stated', 'talking_to_lender', 'our bank', 'talking to our bank'],
      ['financing_status_stated', 'not_started', "haven't talked to a lender", "we haven't talked to a lender"],
      ['seller_owns_stated', false, "we don't own it", "we don't own it"],
      ['seller_owns_stated', true, 'our house', 'we love our house. it is ours'],
      ['seller_listed_elsewhere_stated', true, 'listed with', 'it is listed with another firm'],
      ['wants_agent_contact', true, 'have her call me', 'have her call me'],
      ['wants_agent_contact', false, "don't call me", "please don't call me"],
      ['timeline', 'by March', 'by March', 'not by March'],
      ['timeline', 'asap', 'asap', 'asap please'],
      ['seller_timeline', 'within 3 weeks', 'within 3 weeks', 'within 3 weeks'],
      ['areas', ['62701'], '62701', 'zip 62701'],
      ['areas', ['Springfield'], 'not Springfield', "not Springfield, it's too far"],
      ['budget', 450000, 'up to 450k', 'up to 450k'],
      ['budget', -1, '450k', '450k'],
      ['baths_min', 2.5, '2.5 baths', 'need 2.5 baths'],
      ['must_haves_structured', ['garage', 'yard'], 'a garage and a yard', 'a garage and a yard'],
      ['must_haves_structured', ['garage'], 'no garage', 'no garage needed'],
      ['seller_motivation', 'x', 'x', 'x'],
      ['seller_next_move', 'buying locally', 'buying locally', 'we are buying locally'],
    ];
    expect(cases.map(([f, v, q, own]) => [f, v, q, own, qualValueQuoted(f, v, q, ctx(own))])).toMatchSnapshot();
    const phrases = ['asap', 'not now', 'right now', 'in 10 days', 'within two weeks', 'next 3 months', 'in twelve months', 'this month', 'next month', 'by Jan', 'early february', 'mid June', 'late november', 'around december', 'in 2027', 'tomorrow at 3pm', 'someday'];
    expect(phrases.map((p) => [p, timelineDays(p, T0, NY), timelineDays(p, at('2026-12-20T15:00:00Z'), NY)])).toMatchSnapshot();
    const team = ['Here are times Avery is free:\n1) Tue Nov 17, 3:00–3:30 PM ET', 'Are you preapproved or paying cash?'];
    expect(['2', 'yes please', 'Tue Nov 17', 'free: 1) Tue', 'paying cash', 'are you preapproved', 'we are paying cash now'].map((q) => [q, isTeamText(q, team)])).toMatchSnapshot();
    expect(['we want to make an offer', 'can we see it', 'schedule a showing', 'we want to list', 'we are selling', 'set up a meeting', 'talk to Avery today', "we're not ready to list", 'sit down with you to talk'].map((t) => [t, intentSignals(t, 'm')])).toMatchSnapshot();
  });
  it('matchSlotChoice and the offer over corpora', () => {
    const answers = ['1', '2', '3', '4', '#3', 'option 1', 'number two', 'the third one', '2nd', 'one', 'two!', '3 please', 'tue 10am', 'tue 10:00', 'tuesday 3', 'wed at 10', 'thu at 10', 'Nov 17 3pm', 'nov 18 at 10', '11/17 10', '11/17 3:00 pm', '3pm', '10:30', 'yes', 'ok', 'sure thing', 'neither', 'not good', "can't do those", 'busy then', 'other times?', 'different time please', 'Tuesday', 'mon', 'sat 10am', 'option 2, Wednesday at 10', 'I am 1 of 2 buyers', '12', '0', '2:30', '1 2'];
    expect(answers.map((a) => [a, matchSlotChoice(a, SLOTS, [NY]), matchSlotChoice(a, SLOTS, [NY, LA])])).toMatchSnapshot();
    const base = { now: at('2026-11-12T14:00:00Z'), agentZone: NY, availability: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startSec: 8 * 3600, endSec: 18 * 3600 })), busy: [], clientZones: [NY], inactivityReleaseAt: null };
    const variants = [{}, { clientZones: [NY, LA] }, { durationMinutes: 60, bufferMinutes: 30 }, { minNoticeHours: 24 }, { horizonDays: 2 }, { maxSlots: 2 }, { stepMinutes: 15, minNoticeHours: 0 }, { offerTtlHours: 2 }, { busy: [{ startsAt: at('2026-11-13T13:00:00Z'), endsAt: at('2026-11-13T23:00:00Z') }] }, { availability: [{ weekday: 4, startSec: 8 * 3600, endSec: 8 * 3600 + 1800 }] }, { agentZone: zone('America/Chicago') }, { now: at('2026-03-07T14:00:00Z') }];
    expect(variants.map((v) => computeOffer({ ...base, ...v }))).toMatchSnapshot();
    expect(SLOTS.map((s) => [formatSlot(s, NY), formatSlot(s, LA), formatSlot(s, zone('Pacific/Honolulu'))])).toMatchSnapshot();
    expect(renderOffer({ slots: SLOTS, agentFirstName: ' Avery ', zones: [NY, LA], kindLabel: 'consult' })).toMatchSnapshot();
  });
  it('isaGuard over a corpus', () => {
    const texts = ['Great, thanks!', 'What area?', 'It is hot!', 'The market is slow', 'Inventory is low', 'Strong demand here', 'Your house would sell', 'cheaper than your place', 'compared with yours', 'It is overpriced', 'a steal', "You're all set", 'I will make sure', 'confirmed for Tuesday', "I'll call you tomorrow", 'family friendly', 'top schools', 'quiet neighborhood', 'kind of people', 'up-and-coming', 'diverse area', 'Its equity', 'an estimate', 'list it at', 'comps say', 'price opinion', 'would sell for', 'a dozen homes', 'half of them', 'Visit www.example.test', 'Email avery@example.test', 'twenty percent', '50 bucks', 'Thanks — Avery', 'Hi, Jordan here'];
    expect(texts.map((t) => [t, isaGuard(t, { channel: 'sms', identity: IDENTITY, sources: [] })])).toMatchSnapshot();
  });
  it('readiness, consent, zones, windows, caps and the send plan over corpora', () => {
    const r = (o: Partial<Parameters<typeof readiness>[0]>) => readiness({ side: 'buyer', now: T0, zone: NY, claims: [], intents: [], offerLive: false, appointmentBooked: null, mlsListedElsewhere: false, subjectConfirmed: false, ...o });
    expect([
      r({}),
      r({ side: 'seller' }),
      r({ side: 'both' }),
      r({ appointmentBooked: { appointmentId: 'a', kind: 'consult' } }),
      r({ side: 'seller', appointmentBooked: { appointmentId: 'a', kind: 'consult' } }),
      r({ side: 'both', appointmentBooked: { appointmentId: 'a', kind: 'listing_appointment' } }),
      r({ claims: [claim('timeline', 'asap'), claim('financing_status_stated', 'talking_to_lender'), claim('areas', []), claim('budget', 0), claim('beds_min', 2)] }),
      r({ claims: [claim('timeline', 'asap'), claim('financing_status_stated', 'cash'), claim('areas', ['A']), claim('budget', 1), claim('beds_min', 1)], timelineDaysMax: 0 }),
      r({ side: 'seller', intents: [{ kind: 'meet', messageId: 'm1', quote: 'meet' }, { kind: 'intent_to_sell', messageId: 'm2', quote: 'sell' }] }),
      r({ side: 'seller', intents: [{ kind: 'list', messageId: 'm1', quote: 'list' }] }),
      r({ side: 'seller', claims: [claim('seller_timeline', 'someday'), claim('seller_owns_stated', true), claim('seller_listed_elsewhere_stated', false)], subjectConfirmed: true }),
    ]).toMatchSnapshot();
    const P = 'a'.repeat(64);
    const base: ConsentBasisInput = { now: T0, channel: 'sms', tier: 'initiated', boundHmac: P, personHmacs: [P], consentState: [], lastInbound: null, lastAiOutboundAt: null, grants: [], negatives: [], dnc: [], tenantNames: ['Maple Team'], rules: { d12EffectiveAt: at('2026-11-01T00:00:00Z'), replyWindowHours: 1, dncFreshnessDays: 1 } };
    const g = { consentEventId: 'g', channel: 'sms' as const, purpose: 'all' as const, level: 'express_written' as const, source: 'web_form' as const, addressHmac: P, recordedAt: at('2026-11-05T00:00:00Z'), expiresAt: null, imported: false, needsReview: false, disclosure: { id: 'd', body: 'Maple Team may text you', scopeStated: true, channels: ['sms'], purposes: ['marketing'], origin: 'inquiry' as const }, evidenceObject: false };
    const consents = [
      base,
      { ...base, grants: [g] },
      { ...base, grants: [g], dnc: [{ checkId: 'd', addressHmac: P, result: 'not_listed' as const, checkedAt: instant(T0 - 2 * DAY_MS) }] },
      { ...base, grants: [g], dnc: [{ checkId: 'd', addressHmac: P, result: 'not_listed' as const, checkedAt: instant(T0 - HOUR_MS) }] },
      { ...base, grants: [g], dnc: [{ checkId: 'd', addressHmac: P, result: 'not_listed' as const, checkedAt: instant(T0 + HOUR_MS) }] },
      { ...base, channel: 'email' as const, grants: [{ ...g, channel: 'email' as const, level: 'imported_unverified' as const }] },
      { ...base, grants: [g, { ...g, consentEventId: 'g2', recordedAt: at('2026-11-06T00:00:00Z'), source: 'agent_entry' as const }], dnc: [{ checkId: 'd', addressHmac: P, result: 'not_listed' as const, checkedAt: T0 }] },
      { ...base, tier: 'reply' as const, lastInbound: { messageId: 'i', channel: 'sms' as const, fromHmac: P, at: instant(T0 - 2 * HOUR_MS), dkimAligned: null } },
      { ...base, tier: 'reply' as const, lastInbound: { messageId: 'i', channel: 'sms' as const, fromHmac: P, at: instant(T0 - 30 * 60_000), dkimAligned: null }, lastAiOutboundAt: instant(T0 - 30 * 60_000) },
    ];
    expect(consents.map((c) => { const b = aiIsaConsentBasis(c); return [b, consentBasisSentence(c.channel, b)]; })).toMatchSnapshot();
    expect([
      aiIsaRecipientZones({ contactTz: 'America/Chicago', contactTzSource: 'explicit', phones: ['8085550100'], pointTzs: [], tenantZone: 'America/New_York', inquiryPostalCode: null, addressStates: [] }),
      aiIsaRecipientZones({ contactTz: 'Not/AZone', contactTzSource: 'explicit', phones: ['8085550100', 'junk'], pointTzs: ['Asia/Tokyo'], tenantZone: 'America/New_York', inquiryPostalCode: '00801', addressStates: [null, 'GU'] }),
    ]).toMatchSnapshot();
    const W = { startSec: 9 * 3600, endSec: 20 * 3600, initiatedDays: [2, 3], noInitiatedOnHolidays: true };
    expect([0, 3, 9, 15, 30, 100].map((h) => [aiIsaSendWindow({ ...W, at: T(h), zones: [NY, LA], initiated: true }), aiIsaSendWindow({ ...W, at: T(h), zones: [NY], initiated: false })])).toMatchSnapshot();
    const counts = { ai24h: 1, automated24h: 2, initiated24h: 0, initiated7d: 2, lastAiOutboundAt: instant(T0 - 100_000) };
    expect([capsCheck(counts, 'initiated', T0), capsCheck({ ...counts, initiated7d: 3 }, 'reply', T0), capsCheck({ ...counts, lastAiOutboundAt: null }, 'initiated', T0)]).toMatchSnapshot();
    const inb = { messageId: 'i', channel: 'email' as const, fromHmac: P, at: instant(T0 - HOUR_MS), dkimAligned: true };
    expect([messageKind({ now: T0, channel: 'email', boundHmac: P, content: { kind: 'bot_line', hasFact: false }, inbound: inb, lastAiOutboundAt: instant(T0 - 2 * HOUR_MS), replyWindowHours: 2 }), messageKind({ now: T0, channel: 'email', boundHmac: P, content: { kind: 'offer', hasFact: false }, inbound: inb, lastAiOutboundAt: null, replyWindowHours: 0.5 })]).toMatchSnapshot();
    const ch = { channel: 'email' as const, boundHmac: P, inbound: inb, lastAiOutboundAt: null, consent: { personHmacs: [P], consentState: [], grants: [], negatives: [], dnc: [], tenantNames: ['Maple Team'], lastInbound: null, lastAiOutboundAt: null } };
    expect([
      planSend({ now: T0, preferred: 'email', channels: [ch], content: { kind: 'conversation', hasFact: false }, emailOnly: false, zones: [NY], window: W, initiatedDays: [1, 2, 3, 4, 5, 6], noInitiatedOnHolidays: true, counts: { ...counts, lastAiOutboundAt: null } }),
      planSend({ now: T0, preferred: 'sms', channels: [ch], content: { kind: 'conversation', hasFact: false }, emailOnly: false, zones: [NY], window: W, initiatedDays: [1], noInitiatedOnHolidays: true, counts: { ...counts, lastAiOutboundAt: null } }),
      planSend({ now: T0, preferred: 'email', channels: [ch], content: { kind: 'facts', hasFact: true }, emailOnly: true, zones: [NY], window: W, initiatedDays: [1], noInitiatedOnHolidays: true, counts }),
    ]).toMatchSnapshot();
  });
});
