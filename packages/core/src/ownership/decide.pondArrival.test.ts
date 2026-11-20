// A pond arrival alerts the team leads (b19 team-queue lane, step 2; owner decision 4, 2026-11-19; DATA_MODEL
// R-TEAMQ-12, E938 to E942). Decided in core with the move itself, so the alert and the move commit together.
import { describe, expect, it } from 'vitest';
import { HOUR_MS, MINUTE_MS, type UserId, plusMs } from '../foundation/index.js';
import { decide } from './decide.js';
import { C1, DEFAULT_POND, FALLBACK_POND, Lead, OTHER_POND, T0, U, candidate, ctx, eventsOf, member, ownedLead, pond, pondLead, rule, systemActor, userActor } from './testing/fixtures.js';
import type { Decision, Effect, PeopleFacts } from './types.js';

type Notify = Extract<Effect, { kind: 'notify' }>;
const notifies = (d: Decision): Notify[] => d.effects.filter((e): e is Notify => e.kind === 'notify');
const pondNew = (d: Decision): Notify[] => notifies(d).filter((e) => e.notification.kind === 'pond_new');
const TL2 = 'a0000000-0000-7000-8000-000000000004' as UserId;
/** Two team leads in the tenant; only U.tl leads the agents' team. */
const PEOPLE: PeopleFacts = { admins: [U.admin, U.owner], teamLeads: [U.tl, TL2], teamLeadsOf: { [U.a]: [U.tl], [U.b]: [U.tl] } };
const routing = (over: Parameters<typeof rule>[0] | null, candidates = [candidate(U.a)]) => ({ rule: over === null ? null : rule(over), candidates, cursor: {}, alreadyOffered: [] as UserId[] });

describe('R-TEAMQ-12 a pond arrival alerts the team leads, once', () => {
  it('R-TEAMQ-12 E938: routed there by a rule: every team lead gets one pond_new at high priority, keyed on the ledger event that put the lead in the pond', () => {
    const l = new Lead();
    const d = l.run({ kind: 'create', via: 'intake' }, { actor: systemActor('provider'), people: PEOPLE, routing: routing({ strategy: 'pond', targetPondId: OTHER_POND }, []) });
    const arrival = eventsOf(d).at(-1)!;
    expect(arrival).toMatchObject({ type: 'sent_to_pond', reasonCode: 'RULE_POND', pondId: OTHER_POND, seq: 2 });
    expect(pondNew(d).map((e) => [e.userId, e.notification.priority, e.notification.reasonCode, e.notification.dedupeKey, e.notification.subjectId])).toEqual([
      [U.tl, 'high', 'POND_NEW_RULE_POND', `pond_new:${C1}:2`, C1],
      [TL2, 'high', 'POND_NEW_RULE_POND', `pond_new:${C1}:2`, C1],
    ]);
    // nobody else is told, and nothing here is a message to the client
    expect(notifies(d)).toHaveLength(2);
    expect(d.effects.map((e) => e.kind).filter((k) => k !== 'notify')).toEqual([]);
  });

  it('R-TEAMQ-12 E938: no rule matched: the same alert, with its own reason', () => {
    const l = new Lead();
    const d = l.run({ kind: 'create', via: 'intake' }, { actor: systemActor('provider'), people: PEOPLE, routing: routing(null, []) });
    expect(eventsOf(d).at(-1)).toMatchObject({ type: 'sent_to_pond', reasonCode: 'NO_RULE_MATCH', pondId: DEFAULT_POND });
    expect(pondNew(d).map((e) => [e.userId, e.notification.reasonCode])).toEqual([[U.tl, 'POND_NEW_NO_RULE_MATCH'], [TL2, 'POND_NEW_NO_RULE_MATCH']]);
  });

  it('R-TEAMQ-12 E938: every offer expired: the expiry that sends it to the pond alerts once; the earlier expiries, which re-offer, alert nobody about a pond', () => {
    const l = new Lead();
    const snap = (already: UserId[]) => ({ rule: rule({ maxOffers: 2, fallbackPondId: FALLBACK_POND }), candidates: [candidate(U.a), candidate(U.b)], cursor: {}, alreadyOffered: already });
    l.run({ kind: 'create', via: 'intake' }, { actor: systemActor('provider'), people: PEOPLE, routing: snap([]) });
    expect(l.p.state).toBe('offered');
    const first = l.run({ kind: 'timer', deadline: 'offer_expiry', fence: { offerId: l.p.offerId as string } }, { actor: systemActor('timer'), people: PEOPLE, now: plusMs(T0, 6 * MINUTE_MS), routing: snap([U.a]) });
    expect(l.p.state).toBe('offered');
    expect(pondNew(first)).toEqual([]);
    const last = l.run({ kind: 'timer', deadline: 'offer_expiry', fence: { offerId: l.p.offerId as string } }, { actor: systemActor('timer'), people: PEOPLE, now: plusMs(T0, 12 * MINUTE_MS), routing: snap([U.a, U.b]) });
    expect(eventsOf(last).at(-1)).toMatchObject({ type: 'sent_to_pond', reasonCode: 'MAX_OFFERS_REACHED', pondId: FALLBACK_POND });
    expect(pondNew(last).map((e) => [e.userId, e.notification.reasonCode, e.notification.dedupeKey])).toEqual([
      [U.tl, 'POND_NEW_MAX_OFFERS_REACHED', `pond_new:${C1}:${l.p.seq}`],
      [TL2, 'POND_NEW_MAX_OFFERS_REACHED', `pond_new:${C1}:${l.p.seq}`],
    ]);
  });

  it('R-TEAMQ-12 E938: released by its owner: the team leads are alerted, never the person who released it', () => {
    const l = ownedLead(U.a);
    const d = l.run({ kind: 'release', reason: 'not_a_fit' }, { actor: userActor(U.a), people: PEOPLE, now: plusMs(T0, HOUR_MS) });
    expect(eventsOf(d).at(-1)).toMatchObject({ type: 'released', toState: 'in_pond' });
    expect(pondNew(d).map((e) => [e.userId, e.notification.priority, e.notification.reasonCode])).toEqual([[U.tl, 'high', 'POND_NEW_RELEASED'], [TL2, 'high', 'POND_NEW_RELEASED']]);
    // a team lead who releases their own lead is not alerted about it; the other team lead is
    const own = ownedLead(U.tl);
    const mine = own.run({ kind: 'release', reason: 'not_a_fit' }, { actor: userActor(U.tl), people: PEOPLE, now: plusMs(T0, HOUR_MS) });
    expect(pondNew(mine).map((e) => e.userId)).toEqual([TL2]);
  });

  it('R-TEAMQ-12 E939: replaying the command alerts nobody again, and a second arrival is its own alert (a new key)', () => {
    const l = new Lead();
    const c = ctx({ actor: systemActor('provider'), people: PEOPLE, routing: routing(null, []) });
    const d = decide(null, { kind: 'create', via: 'intake' }, c);
    l.commit(d);
    expect(pondNew(d)).toHaveLength(2);
    // the same command again: a no-op with no effects (R-OWN-7)
    const again = decide(l.p, { kind: 'create', via: 'intake' }, c);
    expect(again.ok && again.events).toEqual([]);
    expect(again.effects).toEqual([]);
    // claimed, then released again: a new arrival, a new ledger event, a new key
    l.run({ kind: 'claim', pondId: DEFAULT_POND }, { actor: userActor(U.a), actorMember: member(U.a), pond: pond(), claimStats: { claimsToday: 0, inCooldown: false, uncontactedOwned: 0 }, people: PEOPLE });
    const back = l.run({ kind: 'release', reason: 'unresponsive' }, { actor: userActor(U.a), people: PEOPLE, now: plusMs(T0, HOUR_MS) });
    expect(pondNew(back).map((e) => e.notification.dedupeKey)).toEqual([`pond_new:${C1}:${l.p.seq}`, `pond_new:${C1}:${l.p.seq}`]);
    expect(pondNew(back)[0]!.notification.dedupeKey).not.toBe(pondNew(d)[0]!.notification.dedupeKey);
  });

  it('R-TEAMQ-12 E940: a tenant with no team lead alerts its Owners and Admins instead', () => {
    const l = new Lead();
    const d = l.run({ kind: 'create', via: 'intake' }, { actor: systemActor('provider'), people: { admins: [U.admin, U.owner], teamLeads: [], teamLeadsOf: {} }, routing: routing(null, []) });
    expect(pondNew(d).map((e) => [e.userId, e.notification.priority])).toEqual([[U.owner, 'high'], [U.admin, 'high']]);
  });

  it('R-TEAMQ-12 E941: nobody is alerted twice for one arrival: a team lead or Admin who already gets the "nobody was available" alert gets no pond_new on top; the others do', () => {
    const l = new Lead();
    const d = l.run({ kind: 'create', via: 'intake' }, { actor: systemActor('provider'), people: PEOPLE, routing: routing({ fallbackPondId: FALLBACK_POND }, [candidate(U.a, { acceptingLeads: false })]) });
    expect(eventsOf(d).at(-1)).toMatchObject({ type: 'sent_to_pond', reasonCode: 'NO_ELIGIBLE_AGENT' });
    const critical = notifies(d).filter((e) => e.notification.reasonCode === 'NO_ELIGIBLE_AGENT').map((e) => e.userId);
    expect(critical).toEqual(expect.arrayContaining([U.tl, U.admin, U.owner]));
    // TL2 leads no candidate's team: the critical alert skipped them, the pond alert reaches them
    expect(pondNew(d).map((e) => [e.userId, e.notification.reasonCode])).toEqual([[TL2, 'POND_NEW_NO_ELIGIBLE_AGENT']]);
    const perUser = new Map<string, number>();
    for (const e of notifies(d)) perUser.set(e.userId, (perUser.get(e.userId) ?? 0) + 1);
    expect([...perUser.values()].every((n) => n === 1)).toBe(true);
  });

  it('R-TEAMQ-12 E942: an import never alerts: not a person imported into a pond, and not a re-run', () => {
    const l = new Lead();
    const d = l.run({ kind: 'import_assign', target: { pondId: DEFAULT_POND } }, { actor: systemActor('import'), people: PEOPLE });
    expect(l.p.state).toBe('in_pond');
    expect(eventsOf(d)[0]).toMatchObject({ type: 'imported', actorKind: 'import' });
    expect(notifies(d)).toEqual([]);
    const again = l.run({ kind: 'import_assign', target: { pondId: DEFAULT_POND } }, { actor: systemActor('import'), people: PEOPLE });
    expect(notifies(again)).toEqual([]);
  });

  it('R-TEAMQ-12 E942: staying in the pond is not an arrival: a re-inquiry that leaves the lead where it is alerts nobody', () => {
    const l = pondLead();
    const d = l.run({ kind: 'reinquiry', inquiryId: 'inq-2' }, { actor: systemActor('provider'), people: PEOPLE, pond: pond({ reinquiry: 'stay' }) });
    expect(eventsOf(d)[0]).toMatchObject({ type: 'reinquiry', reasonCode: 'REINQUIRY_STAY', toState: 'in_pond' });
    expect(pondNew(d)).toEqual([]);
  });

  it('R-TEAMQ-12 E942: a deactivation that moves a member\'s leads to the pond is the Owner\'s own bulk move: no pond alert per lead', () => {
    const l = ownedLead(U.a);
    const d = l.run({ kind: 'deactivate_owner', destination: 'default_pond', deactivationId: 'd0000000-0000-7000-8000-00000000dea1' }, { actor: systemActor('worker'), people: PEOPLE, deactivation: { userId: U.a, teamLeadUserId: U.tl, fallbackUserId: U.owner } });
    expect(eventsOf(d).at(-1)).toMatchObject({ type: 'sent_to_pond', reasonCode: 'OWNER_DEACTIVATED' });
    expect(pondNew(d)).toEqual([]);
  });

  it('R-TEAMQ-12 E941: the 30-minute auto-release: the owner\'s team lead already hears it went back to the pond; the other team leads get the pond alert', () => {
    const l = ownedLead(U.a);
    const due = l.p.releaseDueAt!;
    const d = l.run({ kind: 'timer', deadline: 'auto_release', fence: { periodSeq: l.p.periodSeq as number, dueAt: due } }, { actor: systemActor('timer'), people: PEOPLE, now: due });
    expect(eventsOf(d).at(-1)).toMatchObject({ type: 'auto_released', toState: 'in_pond' });
    expect(notifies(d).filter((e) => e.notification.reasonCode === 'FIRST_TOUCH_MISSED').map((e) => e.userId)).toEqual([U.a, U.tl]);
    expect(pondNew(d).map((e) => [e.userId, e.notification.reasonCode])).toEqual([[TL2, 'POND_NEW_AUTO_RELEASED']]);
  });

  it('R-TEAMQ-12: when the people facts list no team leads explicitly, the leaders of the tenant\'s teams are the team leads', () => {
    const l = new Lead();
    const d = l.run({ kind: 'create', via: 'intake' }, { actor: systemActor('provider'), people: { admins: [U.admin], teamLeadsOf: { [U.a]: [U.tl], [U.b]: [U.tl, TL2] } }, routing: routing(null, []) });
    expect(pondNew(d).map((e) => e.userId)).toEqual([U.tl, TL2]);
  });
});
