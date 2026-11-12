// Property tests on the decision functions (BUILD_PLAN ground rules for critical modules).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { VoiceTool } from '../assistant/index.js';
import type { Instant } from '../foundation/index.js';
import {
  type VoiceAction,
  type VoiceEvent,
  type VoiceFacts,
  type VoiceState,
  VOICE_LEDGER_TOOLS,
  VOICE_OUTCOMES,
  callerTurnSignals,
  decideToolCall,
  shouldAnswer,
  startSession,
  step,
  voiceTurnGuard,
} from './index.js';
import {
  AFTER_HOURS,
  CALLER_TURNS,
  CLEAN_TURNS,
  CONTENT,
  HOT_CLAIMS,
  IDENTITY,
  IN_HOURS,
  KEYWORDS,
  MODEL_OUTPUTS,
  OTHER_MEMBER_ID,
  OWNER,
  OWNER_ID,
  ROUTING_HOURS,
  SESSION_START,
  SLOT_3AM,
  SLOT_A,
  SLOT_ARGS,
  SLOT_B,
  TOPIC_FIXTURES,
  callFacts,
  contact,
  dbArgsOkMirror,
  openSession,
  reach,
  revokedRow,
  H_PHONE,
  voiceFacts,
  voiceSettings,
} from './testing/index.js';

const NUM_RUNS = 300;

// ---- arbitraries ------------------------------------------------------------------------------

const callerText = fc.constantFrom<string>(
  ...Object.values(CALLER_TURNS),
  ...CLEAN_TURNS,
  ...Object.values(TOPIC_FIXTURES).flat(),
  'stop',
  'Stop.',
  'STOP STOP',
  'hello there',
  'good morning',
  'yes',
  'no thanks',
);
const modelText = fc.constantFrom<string>(...Object.values(MODEL_OUTPUTS), 'Sure.', 'One moment.', 'Let me check that for you.');
const argsArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant({}),
  fc.constant({ target_user_id: OWNER_ID }),
  fc.constant({ target_user_id: OTHER_MEMBER_ID }),
  fc.uuid().map((u) => ({ target_user_id: u })),
  fc.constant({ target_user_id: '+15550100199' }),
  fc.constant(SLOT_ARGS(SLOT_A)),
  fc.constant(SLOT_ARGS(SLOT_B, 'listing_appointment')),
  fc.constant(SLOT_ARGS(SLOT_3AM)),
  fc.constant({ ...SLOT_ARGS(SLOT_A), note: 'x' }),
  fc.constant({ topic: 'PRICE' }),
  fc.constant({ topic: 'free text' }),
  fc.constant({ channel: 'all' }),
  fc.constant({ channel: 'sms' }),
  fc.constant({ reason_code: 'GOODBYE' }),
  fc.constant({ from: '2026-11-14T00:00:00Z', to: '2026-11-15T00:00:00Z' }),
  fc.constant(null),
  fc.constant([1, 2]),
  fc.dictionary(fc.string({ maxLength: 12 }), fc.oneof(fc.string({ maxLength: 20 }), fc.integer()), { maxKeys: 3 }),
);
const toolName = fc.oneof(fc.constantFrom<string>(...VOICE_LEDGER_TOOLS), fc.constantFrom('dial_number', 'send_sms', 'transfer_to_owner', 'book', ''));

type EventMaker = (at: Instant) => VoiceEvent;
const eventArb: fc.Arbitrary<EventMaker> = fc.oneof(
  { weight: 2, arbitrary: fc.constantFrom<EventMaker>((at) => ({ type: 'disclosure_played', at }), (at) => ({ type: 'announcement_played', at })) },
  {
    weight: 1,
    arbitrary: fc.constantFrom<EventMaker>(
      (at) => ({ type: 'disclosure_failed', at }),
      (at) => ({ type: 'announcement_failed', at }),
      (at) => ({ type: 'announcement_declined', at }),
      (at) => ({ type: 'vendor_error', at }),
      (at) => ({ type: 'hangup', at }),
      (at) => ({ type: 'enablement_changed', at }),
    ),
  },
  { weight: 4, arbitrary: fc.tuple(callerText, fc.constantFrom<string | null>('en', 'en-US', null, 'es')).map(([text, language]): EventMaker => (at) => ({ type: 'caller_turn', at, text, language })) },
  { weight: 3, arbitrary: fc.tuple(modelText, fc.option(fc.integer({ min: 0, max: 3000 }), { nil: undefined })).map(([text, latencyMs]): EventMaker => (at) => ({ type: 'model_turn', at, text, ...(latencyMs !== undefined ? { latencyMs } : {}) })) },
  { weight: 4, arbitrary: fc.tuple(toolName, argsArb).map(([tool, args]): EventMaker => (at) => ({ type: 'tool_request', at, request: { tool, args, at } })) },
  { weight: 2, arbitrary: fc.boolean().map((ok): EventMaker => (at) => ({ type: 'booking_result', at, ok })) },
  { weight: 2, arbitrary: fc.constantFrom('connected', 'no_answer', 'declined' as const).map((outcome): EventMaker => (at) => ({ type: 'transfer_result', at, outcome })) },
  { weight: 1, arbitrary: fc.constantFrom<EventMaker>((at) => ({ type: 'claims', at, claims: HOT_CLAIMS }), (at) => ({ type: 'claims', at, claims: [] })) },
  { weight: 2, arbitrary: fc.constantFrom<EventMaker>((at) => ({ type: 'silence', at }), (at) => ({ type: 'tick', at })) },
  { weight: 1, arbitrary: fc.integer({ min: 0, max: 3000 }).map((ms): EventMaker => (at) => ({ type: 'turn_latency', at, ms })) },
);
const timedEvents = fc.array(fc.tuple(fc.integer({ min: 0, max: 4000 }), eventArb), { maxLength: 30 });

const factsArb: fc.Arbitrary<VoiceFacts> = fc
  .record({
    owner: fc.constantFrom(OWNER, { ...OWNER, acceptingLeads: false }, null),
    hot: fc.boolean(),
    dnc: fc.boolean(),
    voiceRevoked: fc.boolean(),
    tools: fc.subarray<VoiceTool>(['share_listing_facts', 'book_appointment', 'take_message', 'transfer_to_owner'], { minLength: 1 }),
  })
  .map((r) =>
    voiceFacts({
      contact: contact({ owner: r.owner }),
      claims: r.hot ? HOT_CLAIMS : [],
      content: { ...CONTENT, tools: r.tools },
      optOuts: { reach: reach(r.voiceRevoked ? { consent: [revokedRow('voice', H_PHONE)] } : {}), personDoNotContact: r.dnc },
    }),
  );

function play(facts: VoiceFacts, events: readonly [number, EventMaker][], from?: VoiceState): { state: VoiceState; actions: { at: Instant; a: VoiceAction }[] } {
  const start = from === undefined ? startSession(facts, SESSION_START) : { state: from, actions: [] };
  let s = start.state;
  let t = s.waiting.since as number;
  const actions = start.actions.map((a) => ({ at: SESSION_START, a }));
  for (const [dt, mk] of events) {
    t += dt;
    const r = step(s, mk(t as Instant), facts);
    s = r.state;
    for (const a of r.actions) actions.push({ at: t as Instant, a });
  }
  return { state: s, actions };
}

// ---- properties ----------------------------------------------------------------------------------

describe('determinism', () => {
  it('step, decideToolCall and shouldAnswer are pure functions of their inputs', () => {
    fc.assert(
      fc.property(factsArb, timedEvents, (facts, events) => {
        expect(play(facts, events)).toEqual(play(facts, events));
      }),
      { numRuns: NUM_RUNS },
    );
    fc.assert(
      fc.property(factsArb, toolName, argsArb, (facts, tool, args) => {
        const s = openSession(facts);
        const req = { tool, args, at: (SESSION_START + 10_000) as Instant };
        expect(decideToolCall(s, req, facts)).toEqual(decideToolCall(s, req, facts));
      }),
      { numRuns: NUM_RUNS },
    );
    expect(shouldAnswer(callFacts(), voiceSettings(), ROUTING_HOURS, IN_HOURS)).toEqual(shouldAnswer(callFacts(), voiceSettings(), ROUTING_HOURS, IN_HOURS));
  });
});

describe('monotonic denial', () => {
  type Weaken = (f: VoiceFacts) => VoiceFacts;
  const weakenings: Weaken[] = [
    (f) => ({ ...f, offeredSlots: [] }),
    (f) => ({ ...f, offeredSlots: f.offeredSlots.slice(1) }),
    (f) => ({ ...f, claims: [] }),
    (f) => ({ ...f, hotRule: null }),
    (f) => ({ ...f, contact: { ...f.contact, owner: null } }),
    (f) => ({ ...f, contact: { ...f.contact, owner: f.contact.owner && { ...f.contact.owner, acceptingLeads: false } } }),
    (f) => ({ ...f, contact: { ...f.contact, owner: f.contact.owner && { ...f.contact.owner, status: 'suspended' } } }),
    (f) => ({ ...f, content: { ...f.content, tools: f.content.tools.slice(1) } }),
    // adding opt-out facts
    (f) => ({ ...f, optOuts: { ...f.optOuts, personDoNotContact: true } }),
    (f) => ({ ...f, optOuts: { ...f.optOuts, reach: reach({ consent: [revokedRow('voice', H_PHONE), revokedRow('sms', H_PHONE)] }) } }),
  ];

  it('removing an enabling fact or adding an opt-out never turns a deny into an allow (decideToolCall)', () => {
    fc.assert(
      fc.property(factsArb, toolName, argsArb, fc.integer({ min: 0, max: weakenings.length - 1 }), fc.boolean(), (facts, tool, args, w, heard) => {
        let s = openSession(facts);
        if (heard) s = { ...s, optOut: { kind: 'stop', scope: 'channel', channel: 'voice', classification: { kind: 'stop', needsReview: false, scope: 'channel' } } };
        const req = { tool, args, at: (SESSION_START + 10_000) as Instant };
        const before = decideToolCall(s, req, facts).decision;
        const after = decideToolCall(s, req, (weakenings[w] as Weaken)(facts)).decision;
        if (before === 'deny') expect(after).toBe('deny');
        // a heard opt-out never enables anything but record_opt_out itself
        if (tool !== 'record_opt_out') {
          const withOpt = { ...openSession(facts), optOut: { kind: 'stop' as const, scope: 'channel' as const, channel: 'voice' as const, classification: { kind: 'stop' as const, needsReview: false } } };
          if (decideToolCall(openSession(facts), req, facts).decision === 'deny') expect(decideToolCall(withOpt, req, facts).decision).toBe('deny');
        }
      }),
      { numRuns: NUM_RUNS * 2 },
    );
  });

  it('removing an enabling fact never turns a refusal into an answer (shouldAnswer)', () => {
    const removals = [
      (c: ReturnType<typeof callFacts>, s: ReturnType<typeof voiceSettings>) => [{ ...c, playbook: null }, s] as const,
      (c: ReturnType<typeof callFacts>, s: ReturnType<typeof voiceSettings>) => [{ ...c, playbook: c.playbook && { ...c.playbook, status: 'revoked' as const } }, s] as const,
      (c: ReturnType<typeof callFacts>, s: ReturnType<typeof voiceSettings>) => [c, { ...s, answeringEnabled: false }] as const,
      (c: ReturnType<typeof callFacts>, s: ReturnType<typeof voiceSettings>) => [c, { ...s, attestation: null }] as const,
      (c: ReturnType<typeof callFacts>, s: ReturnType<typeof voiceSettings>) => [c, { ...s, platform: { ...s.platform, vendorReadyAt: null } }] as const,
      (c: ReturnType<typeof callFacts>, s: ReturnType<typeof voiceSettings>) => [c, { ...s, platform: { ...s.platform, reviewedByCounselAt: null } }] as const,
      (c: ReturnType<typeof callFacts>, s: ReturnType<typeof voiceSettings>) => [{ ...c, direction: 'outbound' as const }, s] as const,
      (c: ReturnType<typeof callFacts>, s: ReturnType<typeof voiceSettings>) => [c, { ...s, answerWhen: 'after_hours_only' as const }] as const,
    ];
    fc.assert(
      fc.property(fc.subarray(removals.map((_, i) => i)), fc.integer({ min: 0, max: removals.length - 1 }), fc.constantFrom(IN_HOURS, AFTER_HOURS), (applied, extra, t) => {
        let c = callFacts();
        let s = voiceSettings();
        for (const i of applied) [c, s] = (removals[i] as (typeof removals)[number])(c, s);
        const before = shouldAnswer(c, s, ROUTING_HOURS, t);
        const [c2, s2] = (removals[extra] as (typeof removals)[number])(c, s);
        if (before === null) expect(shouldAnswer(c2, s2, ROUTING_HOURS, t)).toBeNull();
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('random event sequences', () => {
  it('R-VOICE-7 exactly one terminal outcome from the CHECK set; nothing but late ledger rows after it; every ledger row the DB accepts', () => {
    fc.assert(
      fc.property(factsArb, timedEvents, (facts, events) => {
        const r = play(facts, [...events, [100, (at) => ({ type: 'hangup', at })]]);
        const ends = r.actions.filter((x) => x.a.kind === 'end');
        expect(ends).toHaveLength(1);
        expect(VOICE_OUTCOMES).toContain(r.state.outcome);
        const endIdx = r.actions.findIndex((x) => x.a.kind === 'end');
        for (const x of r.actions.slice(endIdx + 1)) expect(x.a.kind).toBe('ledger');
        for (const x of r.actions) {
          if (x.a.kind === 'ledger' && x.a.entry.row !== null) expect(dbArgsOkMirror(x.a.entry.row.tool, x.a.entry.row.args)).toBe(true);
          if (x.a.kind === 'ledger' && x.a.entry.decision === 'allow') {
            expect(r.state.disclosedAt).not.toBeNull();
            expect(x.at).toBeGreaterThanOrEqual(r.state.announcedAt as number);
          }
          if (x.a.kind === 'say') expect(voiceTurnGuard(x.a.text, IDENTITY).pass).toBe(true);
        }
        // the handback is critical for every caller not transferred live
        const h = (ends[0]?.a as Extract<VoiceAction, { kind: 'end' }>).handback;
        expect(h.critical).toBe(h.outcome !== 'transferred');
      }),
      { numRuns: NUM_RUNS * 2 },
    );
  });

  it('R-VOICE-10 never silent: from every non-terminal state, clock ticks alone reach a spoken line or an end within 120 s', () => {
    fc.assert(
      fc.property(factsArb, timedEvents, (facts, events) => {
        const r = play(facts, events);
        if (r.state.phase === 'ended') return;
        const ticks: [number, EventMaker][] = Array.from({ length: 240 }, () => [500, (at: Instant): VoiceEvent => ({ type: 'tick', at })]);
        const after = play(facts, ticks, r.state);
        expect(after.actions.some((x) => x.a.kind === 'say' || x.a.kind === 'end')).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('what the caller\'s and the model\'s words can reach', () => {
  const sig = (text: string, language: string | null) => callerTurnSignals(text, { keywords: KEYWORDS, language, coveredLanguages: ['en'] });

  it('the caller\'s words reach a decision only through callerTurnSignals: equal signals ⇒ identical transitions, in any state', () => {
    let pairs = 0;
    fc.assert(
      fc.property(factsArb, timedEvents, callerText, callerText, fc.constantFrom<string | null>('en', null, 'es'), (facts, prefix, a, b, lang) => {
        fc.pre(JSON.stringify(sig(a, lang)) === JSON.stringify(sig(b, lang)));
        pairs += 1;
        const s = play(facts, prefix).state;
        const at = (s.waiting.since + 1000) as Instant;
        expect(step(s, { type: 'caller_turn', at, text: a, language: lang }, facts)).toEqual(step(s, { type: 'caller_turn', at, text: b, language: lang }, facts));
      }),
      { numRuns: NUM_RUNS },
    );
    expect(pairs).toBeGreaterThan(20);
  });

  it('the model\'s free text reaches only voiceTurnGuard: equal pass results ⇒ identical state and decisions; only the spoken words differ', () => {
    fc.assert(
      fc.property(factsArb, timedEvents, modelText, modelText, timedEvents, (facts, prefix, a, b, suffix) => {
        fc.pre(voiceTurnGuard(a, IDENTITY).pass === voiceTurnGuard(b, IDENTITY).pass);
        const s = play(facts, prefix).state;
        const at = (s.waiting.since + 200) as Instant;
        const ra = step(s, { type: 'model_turn', at, text: a }, facts);
        const rb = step(s, { type: 'model_turn', at, text: b }, facts);
        expect(ra.state).toEqual(rb.state);
        const mask = (xs: VoiceAction[]) => xs.map((x) => (x.kind === 'say' && x.source === 'model' ? { ...x, text: '<model>' } : x));
        expect(mask(ra.actions)).toEqual(mask(rb.actions));
        // and nothing downstream (tools, transfer, slot, opt-out effect, outcome) depends on it
        expect(play(facts, suffix, ra.state).state).toEqual(play(facts, suffix, rb.state).state);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('no output carries an id that is absent from the call\'s facts (the core analogue of tenant isolation)', () => {
    const UUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
    fc.assert(
      fc.property(factsArb, timedEvents, (facts, events) => {
        // the call's facts, plus the in-call claims module 48 hands in (claims events); never a model argument
        const allowed = new Set(JSON.stringify({ facts, inCall: HOT_CLAIMS }).match(UUID) ?? []);
        const r = play(facts, [...events, [100, (at) => ({ type: 'hangup', at })]]);
        const out = JSON.stringify({ actions: r.actions, state: r.state });
        for (const id of out.match(UUID) ?? []) expect(allowed.has(id)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('every tool decision over random requests', () => {
  it('R-VOICE-4 an allow is always a closed-set tool, args valid in the DB allowlist, after both disclosures, and enabled', () => {
    fc.assert(
      fc.property(factsArb, timedEvents, toolName, argsArb, (facts, prefix, tool, args) => {
        const s = play(facts, prefix).state;
        const at = (s.waiting.since + 100) as Instant;
        const d = decideToolCall(s, { tool, args, at }, facts);
        if (d.decision === 'allow') {
          expect(VOICE_LEDGER_TOOLS).toContain(tool);
          expect(dbArgsOkMirror(tool, args)).toBe(true);
          expect(d.ledger).not.toBeNull();
          expect(s.phase === 'conversing').toBe(true);
          if (tool === 'warm_transfer') expect((args as { target_user_id: string }).target_user_id).toBe(facts.contact.owner?.userId);
          if (tool === 'book_appointment') expect([SLOT_A, SLOT_B].some((x) => SLOT_ARGS(x).slot_start === (args as Record<string, string>).slot_start)).toBe(true);
          if (tool === 'record_opt_out') expect(s.optOut).not.toBeNull();
        }
        // whatever the decision, a deny changes nothing: the decision function returns, never mutates
        expect(s).toEqual(play(facts, prefix).state);
      }),
      { numRuns: NUM_RUNS * 2 },
    );
  });
});
