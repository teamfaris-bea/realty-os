// Test fixtures for core/ownership (used only by *.test.ts; excluded from coverage).
import { expect } from 'vitest';
import {
  type Actor,
  type ContactId,
  type IanaZone,
  type Instant,
  type LeadSourceId,
  type PondId,
  type Role,
  type RuleId,
  type TenantId,
  type UserId,
  at,
  businessCalendar,
  localTime,
  nextWindowStart,
  sequentialIds,
  zone,
} from '../../foundation/index.js';
import { decide } from '../decide.js';
import { fold } from '../fold.js';
import type {
  Candidate,
  Decision,
  DecisionContext,
  EffectiveLeadSettings,
  MemberFacts,
  OwnershipCommand,
  OwnershipEvent,
  OwnershipProjection,
  PondFacts,
  RuleFacts,
} from '../types.js';

export const T = '10000000-0000-7000-8000-000000000001' as TenantId;
export const NY: IanaZone = zone('America/New_York');
export const C1 = 'c0000000-0000-7000-8000-000000000001' as ContactId;
export const C2 = 'c0000000-0000-7000-8000-000000000002' as ContactId;

const uid = (n: number) => `a0000000-0000-7000-8000-${n.toString(16).padStart(12, '0')}` as UserId;
export const U = {
  owner: uid(1),
  admin: uid(2),
  tl: uid(3),
  a: uid(10),
  b: uid(11),
  c: uid(12),
  isa: uid(20),
  tc: uid(30),
} as const;
export const ROLE_OF: Record<string, Role> = {
  [U.owner]: 'owner',
  [U.admin]: 'admin',
  [U.tl]: 'team_lead',
  [U.a]: 'agent',
  [U.b]: 'agent',
  [U.c]: 'agent',
  [U.isa]: 'isa',
  [U.tc]: 'tc',
};

export const DEFAULT_POND = 'b0000000-0000-7000-8000-000000000001' as PondId;
export const OTHER_POND = 'b0000000-0000-7000-8000-000000000002' as PondId;
export const FALLBACK_POND = 'b0000000-0000-7000-8000-000000000003' as PondId;
export const RULE = 'd0000000-0000-7000-8000-000000000001' as RuleId;
export const SRC = 'e0000000-0000-7000-8000-000000000001' as LeadSourceId;

export const SETTINGS: EffectiveLeadSettings = {
  offerWindowSeconds: 300,
  maxOffers: 3,
  firstTouchSlaSeconds: 900,
  firstTouchReleaseSeconds: 1800,
  reinquirySlaAfterDays: 7,
  inactivityReleaseDays: 30,
  inactivityWarningHours: 72,
  autoPauseAfterMisses: 3,
  uncontactedCapacityCap: 5,
  isaAccessAfterHandoffDays: 7,
  softDeletePurgeDays: 30,
  defaultPondId: DEFAULT_POND,
  tenantZone: NY,
};

/** Tenant routing hours 08:00–21:00 America/New_York, every day. */
export const CAL = businessCalendar({ zone: 'America/New_York', open: '08:00', close: '21:00' });

/** Recipient contact window 09:00–20:00 in New York (the strict default, R-CONSENT-13). */
export function nyContactable(from: Instant): Instant {
  return nextWindowStart(from, [NY], localTime('09:00'), localTime('20:00')) ?? from;
}

/** Tuesday 2026-11-10 10:00 New York: inside routing hours and the contact window. */
export const T0 = at('2026-11-10T10:00:00-05:00');

export function userActor(userId: UserId, role: Role = ROLE_OF[userId] ?? 'agent'): Actor {
  return { kind: 'user', userId, tenantId: T, role, sessionId: 'session-1' };
}
export function systemActor(via: Extract<Actor, { kind: 'system' }>['via'] = 'worker'): Actor {
  return { kind: 'system', tenantId: T, via, jobId: 'job-1' };
}

export function member(userId: UserId, over: Partial<MemberFacts> = {}): MemberFacts {
  return { userId, role: ROLE_OF[userId] ?? 'agent', status: 'active', acceptingLeads: (ROLE_OF[userId] ?? 'agent') !== 'tc', ...over };
}

export function candidate(userId: UserId, over: Partial<Candidate> = {}): Candidate {
  return {
    userId,
    weight: 1,
    role: ROLE_OF[userId] ?? 'agent',
    status: 'active',
    acceptingLeads: true,
    hasCriticalChannel: true,
    inReleaseCooldown: false,
    uncontactedOwned: 0,
    ...over,
  };
}

export function rule(over: Partial<RuleFacts> = {}): RuleFacts {
  return {
    id: RULE,
    position: 1,
    enabled: true,
    version: 1,
    strategy: 'round_robin',
    match: {},
    directUserId: null,
    targetPondId: null,
    fallbackPondId: null,
    offerWindowSeconds: null,
    maxOffers: null,
    ...over,
  };
}

export function pond(over: Partial<PondFacts> = {}): PondFacts {
  return {
    pondId: DEFAULT_POND,
    isDefault: true,
    archived: false,
    openToAll: true,
    eligibleRoles: ['agent', 'team_lead', 'isa'],
    actorIsMember: false,
    claimsPerDay: 5,
    claimCooldownHours: 72,
    reinquiry: 'reroute',
    ...over,
  };
}

let commandCounter = 0;
/** A fresh uuid-shaped command id. */
export function newCommandId(): string {
  commandCounter += 1;
  return `f0000000-0000-7000-8000-${commandCounter.toString(16).padStart(12, '0')}`;
}

export const IDS = sequentialIds({ prefix: 0x0e0e0e0e });

export function ctx(over: Partial<DecisionContext> = {}): DecisionContext {
  return {
    now: T0,
    ids: IDS,
    actor: systemActor(),
    commandId: newCommandId(),
    contactId: C1,
    settings: SETTINGS,
    calendar: CAL,
    nextContactableAt: (t) => t,
    people: { admins: [U.admin], teamLeadsOf: { [U.a]: [U.tl], [U.b]: [U.tl], [U.c]: [U.tl], [U.isa]: [U.tl] } },
    contactStage: 'new',
    dealOpen: false,
    lastHumanTouchAt: null,
    inactivity: { warnAt: null, releaseAt: null },
    offereeMissedOffers: 0,
    ...over,
  };
}

/** A contact's ledger + projection, driven through decide() exactly as db/client would. */
export class Lead {
  events: OwnershipEvent[] = [];
  state: OwnershipProjection | null = null;
  inactivity: { warnAt: Instant | null; releaseAt: Instant | null } = { warnAt: null, releaseAt: null };
  constructor(readonly contactId: ContactId = C1) {}

  run(cmd: OwnershipCommand, over: Partial<DecisionContext> = {}): Decision {
    const d = decide(this.state, cmd, ctx({ contactId: this.contactId, inactivity: this.inactivity, ...over }));
    this.commit(d);
    return d;
  }

  commit(d: Decision): void {
    if (!d.ok) return;
    this.events.push(...d.events);
    if (d.events.length > 0) {
      this.state = d.next;
      expect(fold(this.events)).toEqual(d.next);
    }
    for (const e of d.effects) if (e.kind === 'setInactivityDeadlines') this.inactivity = { warnAt: e.warnAt, releaseAt: e.releaseAt };
  }

  get p(): OwnershipProjection {
    if (!this.state) throw new Error('no projection');
    return this.state;
  }
}

/** A lead offered to `to` via intake + system routing at `now`. */
export function offeredLead(to: UserId = U.a, now: Instant = T0): Lead {
  const l = new Lead();
  const d = l.run({ kind: 'create', via: 'intake' }, { now, routing: { rule: rule({ strategy: 'direct', directUserId: to }), candidates: [candidate(to)], cursor: {}, alreadyOffered: [] } });
  expect(d.ok && l.p.state).toBe('offered');
  return l;
}

/** A lead owned by `owner` (accepted offer) at `now`. */
export function ownedLead(owner: UserId = U.a, now: Instant = T0): Lead {
  const l = offeredLead(owner, now);
  const d = l.run({ kind: 'accept', offerId: l.p.offerId as string }, { now, actor: userActor(owner), actorMember: member(owner) });
  expect(d.ok).toBe(true);
  return l;
}

/** A lead sitting in `pondId`. */
export function pondLead(pondId: PondId = DEFAULT_POND, now: Instant = T0): Lead {
  const l = new Lead();
  l.run({ kind: 'create', via: 'intake' }, { now, routing: { rule: rule({ strategy: 'pond', targetPondId: pondId }), candidates: [], cursor: {}, alreadyOffered: [] } });
  expect(l.p.state).toBe('in_pond');
  return l;
}

export function expectRejected(d: Decision, code: string): void {
  expect(d.ok).toBe(false);
  if (!d.ok) {
    expect(d.code).toBe(code);
    expect(d.rejection.code).toBe(code);
    expect(d.effects).toEqual([]);
  }
}

export function eventsOf(d: Decision): OwnershipEvent[] {
  if (!d.ok) throw new Error(`rejected: ${d.code}`);
  return d.events;
}
