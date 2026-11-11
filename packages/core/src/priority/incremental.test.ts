// Property tests of the facts the incremental feed relies on (incremental.ts header):
//   1. groups are independent: scoring each group alone and merging equals scoring everything;
//   2. templated labels rendered for an instant equal the plain labels at that instant;
//   3. between i.now and nextFeedChange(i), a feed scored at i.now and rendered later equals the feed
//      scored later (only wording moves), including the last millisecond before the change.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DAY_MS, HOUR_MS, MINUTE_MS, type Instant, instant, localDate } from '../foundation/index.js';
import { compareFeedItems, renderFeedItem, scoreFeed } from './feed.js';
import { renderFeedLabel, templateLabels, textLabels } from './format.js';
import { feedGroupOfItem, nextFeedChange, splitFeedInputs } from './incremental.js';
import { NOW, NY, ME, OTHER, action, appt, contact, deal, dealDate, inquiry, msg, search, task, call as callId } from './testing/fixtures.js';
import type { FeedInputs, FeedItem, GateSummary, InboundFacts, TouchFacts } from './types.js';

const MARK = '';
const users = fc.constantFrom(ME, ME, ME, OTHER);
const cid = fc.integer({ min: 0, max: 5 }).map((n) => contact(n));
/** Real rows have one contact per id: the contact of row n (shared by several ids, so groups hold several inputs). */
const owns = (n: number) => contact(n % 6);
// instants around NOW, biased to land exactly on the thresholds the scorer uses
const offsets = [0, 1, -1, HOUR_MS, HOUR_MS + 1, 4 * HOUR_MS, 4 * HOUR_MS + 1, DAY_MS, DAY_MS + 1, 2 * HOUR_MS, 2 * DAY_MS, 14 * DAY_MS];
const when = fc.oneof(
  fc.integer({ min: -4 * DAY_MS, max: 4 * DAY_MS }),
  fc.tuple(fc.constantFrom(...offsets), fc.constantFrom(1, -1)).map(([o, s]) => o * s),
  fc.integer({ min: -90, max: 90 }).map((m) => m * MINUTE_MS),
).map((d) => instant(NOW + d));
const text = fc.oneof(fc.constantFrom('They asked about Saturday', `odd ${MARK}a123; text`, `${MARK}${MARK}`, 'x'.repeat(150)), fc.string({ maxLength: 30 }));
const gate: fc.Arbitrary<GateSummary> = fc.record(
  {
    sms: fc.record({ outcome: fc.constantFrom('deny' as const, 'unavailable' as const), explanation: text }),
    voice: fc.record({ outcome: fc.constantFrom('deny' as const, 'unavailable' as const), explanation: text }),
    email: fc.record({ outcome: fc.constantFrom('deny' as const, 'unavailable' as const), explanation: text }),
  },
  { requiredKeys: [] },
);
const touchA: fc.Arbitrary<TouchFacts> = fc.record({
  kind: fc.constantFrom('message' as const, 'call' as const),
  direction: fc.constantFrom('outbound' as const, 'inbound_answered' as const),
  initiator: fc.constantFrom('human' as const, 'assistant' as const, 'system' as const),
  imported: fc.boolean(),
  gateAllowed: fc.boolean(),
  at: when,
  byUserId: fc.constant(ME),
});
const inboundA: fc.Arbitrary<InboundFacts> = fc.oneof(
  fc.record({
    n: fc.integer({ min: 0, max: 9 }),
    kind: fc.constant('message' as const),
    channel: fc.constantFrom('sms' as const, 'mms' as const, 'email' as const),
    ownerUserId: users,
    at: when,
    imported: fc.boolean(),
    isAutoReply: fc.boolean(),
    isKeyword: fc.boolean(),
    laterTouches: fc.array(touchA, { maxLength: 2 }),
  }),
  fc.record({
    n: fc.integer({ min: 0, max: 9 }),
    kind: fc.constant('missed_call' as const),
    channel: fc.constant('voice' as const),
    ownerUserId: users,
    at: when,
    imported: fc.boolean(),
    laterTouches: fc.array(touchA, { maxLength: 2 }),
  }),
).map(({ n, ...m }) => ({ ...m, id: m.kind === 'message' ? msg(n) : callId(n), contactId: owns(n) })) as fc.Arbitrary<InboundFacts>;

const inputsA: fc.Arbitrary<FeedInputs> = fc
  .record({
    offers: fc.array(fc.record({ contactId: cid, offerId: fc.constantFrom('o1', 'o2'), offeredToUserId: users, offeredAt: when, expiresAt: when, sourceName: fc.option(text, { nil: null }) }), { maxLength: 2 }),
    slas: fc.array(fc.record({ contactId: cid, ownerUserId: users, periodSeq: fc.integer({ min: 1, max: 3 }), ownedAt: when, firstTouchDueAt: when, firstTouchAt: fc.constant(null), periodEndedAt: fc.constant(null), nextPeriodAt: fc.constant(null), releaseDueAt: fc.option(when, { nil: null }) }), { maxLength: 3 }),
    unansweredInbound: fc.array(inboundA, { maxLength: 6 }),
    handbacks: fc.array(
      fc.record({
        n: fc.integer({ min: 0, max: 1 }),
        ownerUserId: users,
        inboundMessageId: fc.constant(msg(40)),
        inboundChannel: fc.constantFrom('sms' as const, 'email' as const, 'voice' as const, null),
        receivedAt: when,
        withDraft: fc.boolean(),
        createdAt: when,
      }).map(({ n, withDraft, ...h }) => ({ ...h, actionId: action(n), contactId: owns(n), replyDraftActionId: withDraft ? action(n) : null })),
      { maxLength: 2 },
    ),
    drafts: fc.array(
      fc.record({
        n: fc.integer({ min: 2, max: 7 }),
        ownerUserId: users,
        channel: fc.constantFrom('sms' as const, 'email' as const),
        category: fc.constant('novel_message' as const),
        explanation: text,
        needsReview: fc.boolean(),
        createdAt: when,
      }).map(({ n, ...d }) => ({ ...d, actionId: action(n), contactId: owns(n) })),
      { maxLength: 3 },
    ),
    tasks: fc.array(
      fc.record({
        n: fc.integer({ min: 0, max: 4 }),
        assigneeUserId: users,
        dealId: fc.option(fc.constant(deal(1)), { nil: null }),
        kind: fc.constantFrom('callback' as const, 'promise' as const, 'document' as const),
        dueAt: fc.option(when, { nil: null }),
        dueAllDay: fc.boolean(),
        dueTz: fc.constantFrom(null, NY),
        status: fc.constant('open' as const),
        completedAt: fc.constant(null),
        needsReview: fc.boolean(),
        createdByKind: fc.constant('user' as const),
        createdAt: when,
        evidence: fc.option(fc.array(fc.record({ sourceType: fc.constant('message' as const), sourceId: fc.constant(msg(1)), locator: fc.constant({ kind: 'span', start: 0, end: 3 } as never), snippet: text }), { minLength: 1, maxLength: 1 }), { nil: undefined }),
      }).map(({ n, evidence, ...t }) => ({ ...t, taskId: task(n), contactId: n < 2 ? null : owns(n), ...(evidence === undefined ? {} : { evidence }) })),
      { maxLength: 4 },
    ),
    dealDates: fc.array(
      fc.record({
        dealDateId: fc.integer({ min: 0, max: 3 }).map((n) => dealDate(n)),
        dealId: fc.constant(deal(1)),
        userIds: fc.constantFrom([ME], [OTHER], [ME, OTHER]),
        kind: fc.constantFrom('inspection' as const, 'custom' as const, 'closing' as const),
        label: fc.option(text, { nil: null }),
        dueOn: fc.integer({ min: -4, max: 5 }).map((d) => localDate(new Date(NOW + d * DAY_MS).toISOString().slice(0, 10))),
        zone: fc.constant(NY),
        completedAt: fc.constant(null),
        createdAt: when,
      }),
      { maxLength: 3 },
    ),
    appointments: fc.array(
      fc.record({
        n: fc.integer({ min: 0, max: 3 }),
        userId: users,
        kind: fc.constantFrom('buyer_consult' as const, 'consult' as const),
        startsAt: when,
        endsAt: when,
        status: fc.constantFrom('scheduled' as const, 'held' as const, 'canceled' as const),
        outcomeLoggedAt: fc.constant(null),
        createdByKind: fc.constantFrom('user' as const, 'import' as const),
      }).map(({ n, ...a }) => ({ ...a, appointmentId: appt(n), contactId: n < 2 ? null : owns(n) })),
      { maxLength: 3 },
    ),
    reinquiries: fc.array(fc.record({ contactId: cid, ownerUserId: users, inquiryId: fc.integer({ min: 0, max: 2 }).map((n) => inquiry(n)), at: when, dueAt: fc.option(when, { nil: null }), touchedSince: fc.boolean() }), { maxLength: 3 }),
    inactivityWarnings: fc.array(fc.record({ contactId: cid, ownerUserId: users, periodSeq: fc.integer({ min: 1, max: 3 }), warnAt: when, releaseAt: when }), { maxLength: 2 }),
    pondLeads: fc.array(fc.record({ contactId: cid, pondId: fc.constant('f4000000-0000-7000-8000-000000000001' as never), enteredSeq: fc.integer({ min: 1, max: 3 }), enteredAt: when, userIds: fc.constantFrom([ME], [OTHER], [ME, OTHER]) }), { maxLength: 2 }),
    searchProposals: fc.array(fc.record({ n: fc.integer({ min: 0, max: 2 }), ownerUserId: users, uncheckedCount: fc.integer({ min: 0, max: 3 }), createdAt: when }).map(({ n, ...x }) => ({ ...x, savedSearchId: search(n), contactId: owns(n) })), { maxLength: 2 }),
    gates: fc.array(fc.tuple(cid, gate), { maxLength: 4 }),
  })
  .map(({ gates, ...r }) => ({ now: NOW, userId: ME, ...r, blockedChannels: new Map(gates) }) as unknown as FeedInputs);

const at = (i: FeedInputs, now: Instant): FeedInputs => ({ ...i, now });
/** A card without its wording: what the materialized feed must keep exact between change instants. */
const structure = (items: FeedItem[]) => items.map((x) => ({ ...x, reasons: x.reasons.map((r) => ({ code: r.code, points: r.points })) }));
const RUNS = { numRuns: 400 };

describe('incremental feed: pure facts (lane perf-misses)', () => {
  it('templated labels render to the plain wording, and free text cannot forge a token', () => {
    fc.assert(
      fc.property(inputsA, (i) => {
        expect(scoreFeed(i, { labels: 'template' }).map((x) => renderFeedItem(x, i.now))).toEqual(scoreFeed(i));
      }),
      RUNS,
    );
    const f = textLabels(NOW);
    for (const s of [`${MARK}a1;`, `${MARK}${MARK}`, `a${MARK}`, `${MARK}i;`, `${MARK}zz;`]) expect(renderFeedLabel(templateLabels.text(s, 200), NOW)).toBe(f.text(s, 200));
  });

  it('groups are independent: scoring each group alone and merging equals scoring the whole book', () => {
    fc.assert(
      fc.property(inputsA, (i) => {
        const whole = scoreFeed(i);
        const merged = [...splitFeedInputs(i).values()].flatMap((g) => scoreFeed(g)).sort(compareFeedItems);
        expect(merged).toEqual(whole);
        // and each card lands in the group it was scored from
        for (const [g, gi] of splitFeedInputs(i)) for (const it of scoreFeed(gi)) expect(feedGroupOfItem(it)).toBe(g);
      }),
      RUNS,
    );
  });

  it('until nextFeedChange only wording moves: a card scored earlier and rendered later equals one scored later', () => {
    fc.assert(
      fc.property(inputsA, fc.integer({ min: 0, max: 3 * DAY_MS }), fc.boolean(), (i, dt, edge) => {
        const next = nextFeedChange(i);
        if (next !== null) expect(next).toBeGreaterThan(i.now);
        const later = (edge && next !== null ? next - 1 : next === null ? i.now + dt : Math.min(i.now + dt, next - 1)) as Instant;
        const stored = scoreFeed(i, { labels: 'template' });
        const fresh = scoreFeed(at(i, later));
        expect(structure(stored)).toEqual(structure(fresh));
        expect(stored.map((x) => renderFeedItem(x, later))).toEqual(fresh);
      }),
      RUNS,
    );
  });

  it('nextFeedChange is not late: at the named instant the structure may change, and it is null only for time-free inputs', () => {
    // a first-touch SLA turns overdue exactly at its due instant
    const i = { now: NOW, userId: ME, offers: [], slas: [{ contactId: contact(1), ownerUserId: ME, periodSeq: 1, ownedAt: NOW, firstTouchDueAt: instant(NOW + 600_000), firstTouchAt: null, periodEndedAt: null, nextPeriodAt: null, releaseDueAt: null }], unansweredInbound: [], handbacks: [], drafts: [], tasks: [], dealDates: [], appointments: [], blockedChannels: new Map() } as unknown as FeedInputs;
    const next = nextFeedChange(i)!;
    expect(next).toBe(NOW + 600_000);
    expect(structure(scoreFeed(at(i, instant(next - 1))))).toEqual(structure(scoreFeed(i)));
    expect(structure(scoreFeed(at(i, next)))).not.toEqual(structure(scoreFeed(i)));
    expect(nextFeedChange({ ...i, slas: [] })).toBeNull();
  });
});
