// Supplemental R-REASON cases for next/reasons-to-call. Not a second planner and not a second cap.
// Apply on top of the existing reasons work. Do not replace those commits.
// Brief: docs/handoff/briefs/reasons-step1.md on handoff/delegation-1120.
// The step-3 tests already required there (one row, promise plus a price drop, opted-out, restricted source)
// are not repeated. These lock the edges around them.
//
// Selection reads two extra fields on the person planFollowUpToday already takes:
//   cohort: 'lead' | 'past_client' | 'sphere'
//   facts: the same fact objects passed to reasonsToCall
// reasonsToCall(person, facts, now) is the brief's three-argument function.
// If the branch used other names, rename these fixtures. Do not add another function.
import { describe, expect, it } from 'vitest';
import { DAY_MS, HOUR_MS, type Instant, at, zone } from '../foundation/index.js';
import { FOLLOW_UP_TODAY_CAP, type FollowUpPersonFacts, type PromiseTask, planFollowUpToday, reasonsToCall } from './followUp.js';

const NY = zone('America/New_York');
const NOW = at('2026-11-19T15:00:00Z');
const ago = (ms: number) => (NOW - ms) as Instant;
const ahead = (ms: number) => (NOW + ms) as Instant;
const task = (o: Partial<PromiseTask> = {}): PromiseTask => ({ taskId: 't1', title: 'Call them back', kind: 'promise', dueAt: ahead(7 * HOUR_MS), dueAllDay: false, dueTz: null, createdAt: ago(DAY_MS), ...o });
const person = (o: Partial<FollowUpPersonFacts> = {}): FollowUpPersonFacts => ({ contactId: 'c1', stage: 'connected', tasks: [], lastContactAt: ago(2 * DAY_MS), sinceAt: ago(40 * DAY_MS), gate: undefined, ...o });

type Cohort = 'lead' | 'past_client' | 'sphere';
type CallFact = { kind: string; factId: string; at: Instant; listingId?: string; lowCents?: number; highCents?: number; miles?: number | null; sameStreet?: boolean; sameSubdivision?: boolean };
type CallPerson = { contactId: string; cohort: Cohort; homeListingId?: string | null; lastConversationAt?: Instant | null; suppressedFactIds?: readonly string[] };

const quiet = (contactId: string, daysAgo: number) => person({ contactId, stage: 'connected', lastContactAt: ago(daysAgo * DAY_MS) });
const promised = (contactId: string, dueAt: Instant) => person({ contactId, tasks: [task({ taskId: `t-${contactId}`, dueAt })] });
const fact = (kind: string, factId: string, atInstant: Instant, extra: Omit<CallFact, 'kind' | 'factId' | 'at'> = {}): CallFact => ({ kind, factId, at: atInstant, ...extra });
const withFacts = (contactId: string, cohort: Cohort, facts: CallFact[]) => ({ ...person({ contactId, stage: cohort, lastContactAt: ago(DAY_MS) }), cohort, facts });
const talk = (people: ReadonlyArray<FollowUpPersonFacts & Record<string, unknown>>) => planFollowUpToday({ now: NOW, zone: NY, people: people as never });
const ids = (people: ReadonlyArray<FollowUpPersonFacts & Record<string, unknown>>) => talk(people).people.map((p) => p.contactId);
const call = (who: CallPerson, facts: readonly CallFact[]) => reasonsToCall(who as never, facts as never, NOW) as { kind: string; at: Instant; headline: string; say: string; evidence: unknown; expiresAt: Instant }[];
const words = (rows: { headline: string; say: string }[]) => rows.map((r) => `${r.headline} ${r.say}`).join(' ');

describe('R-REASON supplement: the same plan, cap 15, promises then quiet', () => {
  it('the constant follow-up today already uses is 15, not a second cap', () => {
    expect(FOLLOW_UP_TODAY_CAP).toBe(15);
  });
  it('sixteen quiet leads fill 15 seats, most overdue first, and the total counts the rest', () => {
    const people = Array.from({ length: 16 }, (_, i) => quiet(`q${String(i).padStart(2, '0')}`, 40 - i));
    const r = talk(people);
    expect(r.people).toHaveLength(15);
    expect(r.total).toBe(16);
    expect(r.people.map((p) => p.contactId)).toEqual(people.slice(0, 15).map((p) => p.contactId));
  });
  it('a promise due later today comes before a longer quiet stretch, and the older promise comes first', () => {
    const people = [quiet('quiet', 9), promised('promise-new', ahead(7 * HOUR_MS)), promised('promise-old', ago(5 * DAY_MS))];
    expect(ids(people)).toEqual(['promise-old', 'promise-new', 'quiet']);
    expect(ids([...people].reverse())).toEqual(['promise-old', 'promise-new', 'quiet']);
  });
});

describe('R-REASON supplement: the five relationship seats', () => {
  it('fifteen promises take every seat; past clients with a reason do not take one', () => {
    const leads = Array.from({ length: 15 }, (_, i) => promised(`pr-${String(i).padStart(2, '0')}`, ago((15 - i) * DAY_MS)));
    const past = Array.from({ length: 5 }, (_, i) => withFacts(`past-${i}`, 'past_client', [fact('home_anniversary', `ann-${i}`, ago(i * HOUR_MS))]));
    const r = talk([...past, ...leads].reverse());
    expect(r.people.map((p) => p.contactId)).toEqual(leads.map((p) => p.contactId));
    expect(r.total).toBe(20);
  });
  it('two past clients are kept, and the three unused seats go back to quiet leads', () => {
    const leads = Array.from({ length: 20 }, (_, i) => quiet(`q${String(i).padStart(2, '0')}`, 40 - i));
    const past = [0, 1].map((i) => withFacts(`past-${i}`, 'past_client', [fact('nearby_sale', `sale-${i}`, ago(i * HOUR_MS))]));
    const r = talk([...past, ...leads]);
    expect(r.people).toHaveLength(15);
    expect(r.total).toBe(22);
    expect(r.people.map((p) => p.contactId)).toEqual([...leads.slice(0, 13).map((p) => p.contactId), 'past-0', 'past-1']);
  });
  it('past clients and sphere share one pool of five, newest reason first, and a lead fact takes no seat', () => {
    const leads = Array.from({ length: 15 }, (_, i) => quiet(`q${String(i).padStart(2, '0')}`, 40 - i));
    const relationship = ['past-a', 'sphere-a', 'past-b', 'sphere-b', 'past-c', 'sphere-c'].map((contactId, i) =>
      withFacts(contactId, contactId.startsWith('sphere') ? 'sphere' : 'past_client', [fact('home_anniversary', `ann-${contactId}`, ago(i * HOUR_MS))]),
    );
    const leadFact = withFacts('lead-fact', 'lead', [fact('nearby_price_drop', 'drop-lead', NOW)]);
    const r = talk([leadFact, ...relationship, ...leads]);
    expect(r.people.map((p) => p.contactId)).toEqual([...leads.slice(0, 10).map((p) => p.contactId), 'past-a', 'sphere-a', 'past-b', 'sphere-b', 'past-c']);
    expect(r.people.map((p) => p.contactId)).not.toContain('sphere-c');
    expect(r.people.map((p) => p.contactId)).not.toContain('lead-fact');
    expect(ids([leadFact, ...relationship, ...leads].reverse())).toEqual(r.people.map((p) => p.contactId));
  });
});

describe('R-REASON supplement: reasonsToCall keeps only a fresh fact, in a fixed order, worded from that fact', () => {
  const anniversary = (atInstant: Instant, id = 'ann-1') => fact('home_anniversary', id, atInstant);
  it('uses the proposed windows, and drops a fact outside them', () => {
    const who: CallPerson = { contactId: 'c-window', cohort: 'past_client' };
    expect(call(who, [anniversary(ago(6 * DAY_MS))]).map((r) => r.kind)).toEqual(['home_anniversary']);
    expect(call(who, [anniversary(ago(8 * DAY_MS))])).toEqual([]);
    expect(call(who, [anniversary(ahead(6 * DAY_MS))]).map((r) => r.kind)).toEqual(['home_anniversary']);
    expect(call(who, [anniversary(ahead(8 * DAY_MS))])).toEqual([]);
    expect(call(who, [fact('home_value_update', 'val-in', ago(13 * DAY_MS), { lowCents: 38_000_000, highCents: 41_000_000 })])).toHaveLength(1);
    expect(call(who, [fact('home_value_update', 'val-out', ago(15 * DAY_MS), { lowCents: 38_000_000, highCents: 41_000_000 })])).toEqual([]);
    expect(call(who, [fact('nearby_price_drop', 'near-in', ago(9 * DAY_MS), { listingId: 'list-9', sameStreet: true })])).toHaveLength(1);
    expect(call(who, [fact('nearby_sale', 'sale-out', ago(11 * DAY_MS), { listingId: 'list-9' })])).toEqual([]);
    expect(call(who, [fact('saved_search_match', 'match-in', ago(2 * DAY_MS))])).toHaveLength(1);
    expect(call(who, [fact('saved_search_match', 'match-out', ago(4 * DAY_MS))])).toEqual([]);
  });
  it('drops their own home, a deal milestone, a fact already talked about, and a suppressed fact', () => {
    const who: CallPerson = { contactId: 'c-own', cohort: 'sphere', homeListingId: 'home-1' };
    expect(call(who, [fact('nearby_price_drop', 'own', NOW, { listingId: 'home-1', sameStreet: true })])).toEqual([]);
    expect(call(who, [fact('deal_milestone', 'deal-1', ahead(DAY_MS))])).toEqual([]);
    expect(call({ ...who, lastConversationAt: ahead(HOUR_MS) }, [fact('nearby_sale', 'sale-1', NOW, { listingId: 'list-2' })])).toEqual([]);
    expect(call({ ...who, lastConversationAt: ago(2 * HOUR_MS) }, [fact('nearby_sale', 'sale-1', NOW, { listingId: 'list-2' })])).toHaveLength(1);
    expect(call({ ...who, suppressedFactIds: ['sale-1'] }, [fact('nearby_sale', 'sale-1', NOW, { listingId: 'list-2' })])).toEqual([]);
  });
  it('lists the stronger reason first, then the newer one, and says only what the fact supports', () => {
    const who: CallPerson = { contactId: 'c-rank', cohort: 'past_client', homeListingId: 'home-1' };
    const rows = call(who, [
      fact('nearby_price_drop', 'drop-old', ago(2 * HOUR_MS), { listingId: 'list-1', sameStreet: true }),
      fact('nearby_price_drop', 'drop-new', ago(HOUR_MS), { listingId: 'list-2', miles: 0.3 }),
      fact('home_anniversary', 'ann-1', ago(DAY_MS)),
      fact('home_value_update', 'val-1', ago(DAY_MS), { lowCents: 38_000_000, highCents: 41_000_000 }),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['home_anniversary', 'home_value_update', 'nearby_price_drop', 'nearby_price_drop']);
    expect(rows.map((r) => r.evidence && JSON.stringify(r.evidence))).toEqual([expect.stringContaining('ann-1'), expect.stringContaining('val-1'), expect.stringContaining('drop-new'), expect.stringContaining('drop-old')]);
    expect(rows.every((r) => r.expiresAt > NOW)).toBe(true);
    const said = words(rows);
    expect(said).toMatch(/380,000/);
    expect(said).toMatch(/410,000/);
    expect(said).toMatch(/0\.3/);
    expect(said).toMatch(/mile/);
    expect(said).toMatch(/street/);
    expect(said).not.toMatch(/thinking of selling|likely to sell|going to sell/i);
    const value = rows.find((r) => r.kind === 'home_value_update')!;
    expect(value.headline).toMatch(/380,000/);
    expect(value.headline).toMatch(/410,000/);
    expect(`${value.headline} ${value.say}`).toMatch(/18 Nov|Nov 18|November 18/);
    expect(value.say.replace(/\$[\d,]+\s+to\s+\$[\d,]+/g, '')).not.toMatch(/\$\d/);
    for (const r of rows.filter((row) => row.kind !== 'home_anniversary')) expect(`${r.headline} ${r.say}`).toMatch(/Nov/);
  });
});
