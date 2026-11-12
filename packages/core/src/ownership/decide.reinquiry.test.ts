// Owner decision D8 (2026-11-12; batch 6 review ownership-sla/F4): a new inquiry from an unassigned lead that nothing
// will ever route. R-OWN-20 attached the inquiry of every `unassigned` lead, on the assumption that a route was due.
// An import leaves people unassigned with no route due (a person with no owner in the source, a CSV row, a person whose
// mapped member could not hold leads: owner decision B4, a merge or an undo before the owners came in), and nothing
// routes them until someone assigns them, so their next inquiry reached nobody: no routing, offer, SLA, notification
// or feed card. Such a lead is now routed like a returning lead; every other row of R-OWN-20 is unchanged.
import { describe, expect, it } from 'vitest';
import { type ContactId, MINUTE_MS, type UserId, plusMs } from '../foundation/index.js';
import { decide, decideMerge, reinquiryOutcome } from './decide.js';
import { fold } from './fold.js';
import { C1, C2, DEFAULT_POND, Lead, RULE, T0, U, candidate, ctx, eventsOf, member, offeredLead, ownedLead, pond, pondLead, rule, systemActor, userActor } from './testing/fixtures.js';
import type { Decision, Effect, OwnershipCommand, OwnershipProjection } from './types.js';

const kinds = (d: Decision) => d.effects.map((e) => e.kind);
const effectsOf = <K extends Effect['kind']>(d: Decision, k: K) => d.effects.filter((e): e is Extract<Effect, { kind: K }> => e.kind === k);
const rr = (members: UserId[], over: Parameters<typeof rule>[0] = {}) => ({ rule: rule(over), candidates: members.map((m) => candidate(m)), cursor: {}, alreadyOffered: [] as UserId[] });
const again = (inquiryId = 'inq-back'): OwnershipCommand => ({ kind: 'reinquiry', inquiryId });

/** A lead exactly as an import's contacts stage leaves it: one `imported` event, unassigned, never routed (no route due). */
function importedUnassigned(contactId: ContactId = C1): Lead {
  const l = new Lead(contactId);
  l.run({ kind: 'import_assign', target: 'unassigned' }, { actor: systemActor('import') });
  expect(l.p).toMatchObject({ state: 'unassigned', routeDueAt: null, seq: 1 });
  return l;
}

/** What a decision did, in a form a table can compare: the events (type, from → to, reason) and the effect kinds. */
function summary(d: Decision): { events: string[]; effects: string[] } | string {
  if (!d.ok) return `rejected ${d.code}`;
  return { events: d.events.map((e) => `${e.type} ${e.fromState}→${e.toState} ${e.reasonCode}`), effects: [...new Set(kinds(d))].sort() };
}

describe('owner decision D8: a new inquiry from an unassigned lead no router will reach (R-OWN-20)', () => {
  it('R-OWN-20 E341: an unassigned lead with no route due (imported unassigned, never routed) is routed like a returning lead: a reinquiry event (REINQUIRY_ROUTE, due now), then one offer through the matched rule with its timer, the offer notification and card; the accept starts its own first-touch period', () => {
    const l = importedUnassigned();
    const d = l.run(again(), { actor: systemActor('provider'), routing: rr([U.a]) });
    expect(eventsOf(d).map((e) => [e.type, e.fromState, e.toState, e.reasonCode, e.actorKind])).toEqual([
      ['reinquiry', 'unassigned', 'unassigned', 'REINQUIRY_ROUTE', 'provider'],
      ['offered', 'unassigned', 'offered', 'ROUND_ROBIN', 'provider'],
    ]);
    expect(eventsOf(d)[0]?.payload).toEqual({ inquiryId: 'inq-back', routeDueAt: T0 });
    expect(eventsOf(d)[1]).toMatchObject({ offeredToUserId: U.a, routingRuleId: RULE, deadlineAt: plusMs(T0, 5 * MINUTE_MS) });
    expect(l.p).toMatchObject({ state: 'offered', offeredToUserId: U.a, offerRound: 1, routeDueAt: null, seq: 3 });
    expect(fold(l.events)).toEqual(l.p);
    expect(effectsOf(d, 'enqueueTimer').map((t) => [t.jobKind, t.runAt])).toEqual([['ownership.offer_expiry', plusMs(T0, 5 * MINUTE_MS)]]);
    expect(effectsOf(d, 'notify').map((n) => [n.userId, n.notification.kind, n.notification.priority])).toEqual([[U.a, 'lead_offer', 'critical']]);
    expect(effectsOf(d, 'upsertFeed').map((f) => [f.item.userId, f.item.itemType, f.item.band])).toEqual([[U.a, 'lead_offer', 'pinned']]);
    expect(effectsOf(d, 'routingCursor')).toEqual([{ kind: 'routingCursor', ruleId: RULE, cursor: { lastUserId: U.a } }]);
    expect(kinds(d)).not.toContain('route'); // routed inline: nothing left for the follow-up
    expect(kinds(d)).not.toContain('audit'); // the system actor's routing, like a pond re-route
    // accepting the offer starts the lead's own ownership period, with its first-touch SLA, auto-release and card
    const a = l.run({ kind: 'accept', offerId: l.p.offerId as string }, { actor: userActor(U.a), actorMember: member(U.a) });
    expect(l.p).toMatchObject({ state: 'owned', ownerUserId: U.a, periodSeq: 4, ownedAt: T0, firstTouchDueAt: plusMs(T0, 15 * MINUTE_MS), releaseDueAt: plusMs(T0, 30 * MINUTE_MS) });
    expect(effectsOf(a, 'enqueueTimer').map((t) => t.jobKind)).toEqual(expect.arrayContaining(['ownership.first_touch_breach', 'ownership.auto_release']));
    expect(effectsOf(a, 'upsertFeed').map((f) => [f.item.userId, f.item.itemType])).toEqual([[U.a, 'first_touch_due']]);
  });

  it('R-OWN-20 R-OWN-11 E341: the routing never picks a member who cannot hold leads (B4: the suspended member the person was mapped to): the next eligible member is offered; with nobody eligible the lead goes to the pond (NO_ELIGIBLE_AGENT) and the Team Leads and Admins hear', () => {
    // it is the suspended member's turn in the rotation (the last offer went to U.a)
    const l = importedUnassigned();
    const d = l.run(again(), { routing: { rule: rule(), candidates: [candidate(U.a), candidate(U.b, { status: 'suspended' })], cursor: { lastUserId: U.a }, alreadyOffered: [] } });
    const offered = eventsOf(d)[1];
    expect(offered).toMatchObject({ type: 'offered', offeredToUserId: U.a });
    expect(offered?.payload.candidates).toEqual([
      { userId: U.b, eligible: false, skipReason: 'MEMBERSHIP_INACTIVE' },
      { userId: U.a, eligible: true },
    ]);
    // a rule that names only the suspended member: nobody can take the lead, so the pond does (R-OWN-9), never them
    const solo = importedUnassigned();
    const s = solo.run(again(), { routing: { rule: rule({ strategy: 'direct', directUserId: U.b, fallbackPondId: null }), candidates: [candidate(U.b, { status: 'suspended' })], cursor: {}, alreadyOffered: [] } });
    expect(eventsOf(s).map((e) => [e.type, e.toState, e.reasonCode, e.pondId])).toEqual([
      ['reinquiry', 'unassigned', 'REINQUIRY_ROUTE', null],
      ['sent_to_pond', 'in_pond', 'NO_ELIGIBLE_AGENT', DEFAULT_POND],
    ]);
    expect(solo.events.some((e) => e.offeredToUserId === U.b || e.ownerUserId === U.b)).toBe(false);
    expect(effectsOf(s, 'notify').map((n) => [n.userId, n.notification.priority, n.notification.reasonCode])).toEqual([
      [U.admin, 'critical', 'NO_ELIGIBLE_AGENT'],
      [U.tl, 'critical', 'NO_ELIGIBLE_AGENT'],
    ]);
    // no rule matches the inquiry: the default pond (R-OWN-10)
    const none = importedUnassigned();
    const n = none.run(again(), { routing: { rule: null, candidates: [], cursor: {}, alreadyOffered: [] } });
    expect(eventsOf(n).map((e) => [e.type, e.reasonCode])).toEqual([['reinquiry', 'REINQUIRY_ROUTE'], ['sent_to_pond', 'NO_RULE_MATCH']]);
  });

  it('R-OWN-20 E343: every other way a lead is left unassigned with no route due is routed too (an imported person merged with another before their owner was imported; an ownership-stage undo); without a routing snapshot the engine asks for a route, which the follow-up runs', () => {
    // two imported people merged by an Admin before the ownership stage: the survivor keeps its state (unassigned, no
    // route due) at seq 2 (batch 6 review F3)
    const s = importedUnassigned(C1);
    const lo = importedUnassigned(C2);
    const m = decideMerge(s.p, lo.p, { kind: 'merge', survivorId: C1, loserId: C2, ownerChoice: null }, ctx({ actor: userActor(U.admin) }));
    if (!m.ok) throw new Error(m.code);
    expect(m.survivor.next).toMatchObject({ state: 'unassigned', routeDueAt: null, seq: 2 });
    const merged = decide(m.survivor.next, again(), ctx({ routing: rr([U.a]) }));
    expect(summary(merged)).toMatchObject({ events: ['reinquiry unassigned→unassigned REINQUIRY_ROUTE', 'offered unassigned→offered ROUND_ROBIN'] });
    // an ownership-stage undo puts an imported assignment back to where the contacts stage left it (R-IMPORT-10)
    const undone = new Lead();
    undone.run({ kind: 'import_assign', target: { userId: U.a } }, { actor: systemActor('import'), targetMember: member(U.a) });
    undone.run({ kind: 'import_unassign', importSeq: 1 }, { actor: systemActor('import') });
    expect(undone.p).toMatchObject({ state: 'unassigned', routeDueAt: null, seq: 2 });
    expect(summary(decide(undone.p, again(), ctx({ routing: rr([U.b]) })))).toMatchObject({ events: ['reinquiry unassigned→unassigned REINQUIRY_ROUTE', 'offered unassigned→offered ROUND_ROBIN'] });
    // no routing snapshot (a caller that is not the router): the route is due now and the follow-up routes it
    const later = importedUnassigned();
    const d = later.run(again(), { actor: systemActor('worker') });
    expect(eventsOf(d).map((e) => e.type)).toEqual(['reinquiry']);
    expect(later.p).toMatchObject({ state: 'unassigned', routeDueAt: T0, seq: 2 });
    expect(kinds(d)).toEqual(['route']);
    // and a re-inquiry on the routed lead is an ordinary R-OWN-20 row again: it is on offer, so it only attaches
    const routed = importedUnassigned();
    routed.run(again('inq-1'), { routing: rr([U.a]) });
    expect(decide(routed.p, again('inq-2'), ctx({ routing: rr([U.b]) }))).toEqual({ ok: true, events: [], next: routed.p, effects: [] });
  });

  it('R-OWN-20 R-OWN-10 E342: only the system actor routes: a person cannot issue the re-inquiry, and replaying the one that routed is a no-op (one routing)', () => {
    const l = importedUnassigned();
    const refused = decide(l.p, again(), ctx({ actor: userActor(U.admin), routing: rr([U.a]) }));
    expect(refused).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    const c = ctx({ routing: rr([U.a]) });
    const first = decide(l.p, again(), c);
    if (!first.ok) throw new Error(first.code);
    expect(first.events.map((e) => e.type)).toEqual(['reinquiry', 'offered']);
    expect(decide(first.next, again(), { ...c })).toEqual({ ok: true, events: [], next: first.next, effects: [] });
  });

  // Every row of R-OWN-20, side by side: only "unassigned with no route due" changed (owner decision D8).
  it('R-OWN-20 E342: the other rows are unchanged: owned (the owner hears; no new owner), in a pond (its setting), on offer and unassigned awaiting the router (attach only: the router routes it once), closed (stays closed; merged redirects)', () => {
    const owned = ownedLead(U.a);
    const declined = offeredLead(U.a);
    declined.run({ kind: 'decline', offerId: declined.p.offerId as string }, { actor: userActor(U.a) });
    expect(declined.p).toMatchObject({ state: 'unassigned', routeDueAt: T0 });
    const spam = ownedLead(U.a);
    spam.run({ kind: 'close', reason: 'spam' }, { actor: userActor(U.a) });
    const later = plusMs(T0, MINUTE_MS);
    const rows: [string, OwnershipProjection, Decision][] = [
      ['owned', owned.p, decide(owned.p, again(), ctx({ now: later, lastHumanTouchAt: T0 }))],
      ['in_pond reroute', pondLead().p, decide(pondLead().p, again(), ctx({ routing: rr([U.b]), pond: pond({ reinquiry: 'reroute' }) }))],
      ['in_pond stay', pondLead().p, decide(pondLead().p, again(), ctx({ pond: pond({ reinquiry: 'stay' }) }))],
      ['offered', offeredLead(U.a).p, decide(offeredLead(U.a).p, again(), ctx({ routing: rr([U.b]) }))],
      ['unassigned, route due', declined.p, decide(declined.p, again(), ctx({ routing: rr([U.b]) }))],
      ['unassigned, no route due', importedUnassigned().p, decide(importedUnassigned().p, again(), ctx({ routing: rr([U.b]) }))],
      ['closed spam', spam.p, decide(spam.p, again(), ctx())],
    ];
    expect(rows.map(([name, , d]) => [name, summary(d)])).toEqual([
      ['owned', { events: ['reinquiry owned→owned REINQUIRY'], effects: ['notify', 'upsertFeed'] }],
      ['in_pond reroute', { events: ['reinquiry in_pond→unassigned REINQUIRY_REROUTE', 'offered unassigned→offered ROUND_ROBIN'], effects: ['enqueueTimer', 'notify', 'routingCursor', 'upsertFeed'] }],
      ['in_pond stay', { events: ['reinquiry in_pond→in_pond REINQUIRY_STAY'], effects: [] }],
      ['offered', { events: [], effects: [] }],
      ['unassigned, route due', { events: [], effects: [] }],
      ['unassigned, no route due', { events: ['reinquiry unassigned→unassigned REINQUIRY_ROUTE', 'offered unassigned→offered ROUND_ROBIN'], effects: ['enqueueTimer', 'notify', 'routingCursor', 'upsertFeed'] }],
      ['closed spam', { events: [], effects: ['notify'] }],
    ]);
    // the owned lead keeps its owner and its period (E18)
    const o = rows[0]![2];
    expect(o.ok && [o.next.ownerUserId, o.next.periodSeq]).toEqual([U.a, owned.p.periodSeq]);
    // what intake records for each (lead_inquiries.outcome): `reinquiry` exactly where the engine acts on it
    expect(rows.map(([name, p]) => [name, reinquiryOutcome(p)])).toEqual([
      ['owned', 'reinquiry'],
      ['in_pond reroute', 'reinquiry'],
      ['in_pond stay', 'reinquiry'],
      ['offered', 'attached'],
      ['unassigned, route due', 'attached'],
      ['unassigned, no route due', 'reinquiry'],
      ['closed spam', 'reinquiry'],
    ]);
  });
});
