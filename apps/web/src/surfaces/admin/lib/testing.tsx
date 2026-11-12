// Fixtures for the web/lead-admin component tests (imported by *.test.tsx only). Shapes follow the API
// response schemas (api/accountability, api/admin, api/comms, api/assistant, api/imports). The whole
// app is mounted (shell providers, routes from a page table holding the agent surfaces and these four)
// on a scripted fetch, so evidence routes, re-auth and error sentences are the real ones.
import { FakeFetch, renderApp, sessionFixture, tableWith } from '../../../shell/testing/fakeApi.js';
import { AGENT_SURFACES } from '../../feed/lib/testing.js';
import { surface as importsSurface } from '../../imports/index.js';
import { surface as settingsSurface } from '../../settings/index.js';
import { surface as teamSurface } from '../../team/index.js';
import { surface as adminSurface } from '../index.js';
import type { ExceptionItem, Member, PolicyValues, Scoreboard, Settings } from './types.js';

export const LEAD_ADMIN_SURFACES = [teamSurface, adminSurface, settingsSurface, importsSurface];
export const leadAdminTable = () => tableWith(...AGENT_SURFACES, ...LEAD_ADMIN_SURFACES);

export type TestRole = 'owner' | 'admin' | 'team_lead' | 'agent' | 'isa' | 'tc';

export const ID = {
  me: '01900000-0000-7000-8000-0000000000aa',
  ava: '01900000-0000-7000-8000-0000000000a1',
  ben: '01900000-0000-7000-8000-0000000000a2',
  owner: '01900000-0000-7000-8000-0000000000a0',
  pat: '01900000-0000-7000-8000-00000000c002',
  call: '01900000-0000-7000-8000-0000000ca111',
  message: '01900000-0000-7000-8000-0000000e5501',
  task: '01900000-0000-7000-8000-0000000ta001',
  item: '01900000-0000-7000-8000-0000000e0001',
} as const;

export function leadAdminApp(fake: FakeFetch, path: string, role: TestRole = 'team_lead', o: { reauthenticatedAt?: string | null; mfa?: boolean } = {}) {
  const s = sessionFixture({ reauthenticatedAt: o.reauthenticatedAt ?? null, mfa: { enabled: o.mfa ?? false, verified: o.mfa ?? false, enrollmentRequired: false } });
  const tenant = { ...s.tenant!, role };
  fake.on('GET /auth/session', { status: 200, body: { ...s, tenant, tenants: [tenant] } });
  return renderApp({ fake, path, table: leadAdminTable() });
}

export function exceptionItem(over: Partial<ExceptionItem> = {}): ExceptionItem {
  return {
    id: ID.item,
    dedupeKey: `untouched:${ID.pat}:3`,
    itemType: 'untouched_lead',
    subjectType: 'contact',
    subjectId: ID.pat,
    contact: { id: ID.pat, name: 'Pat Lead' },
    owner: { userId: ID.ava, name: 'Ava Agent' },
    detectedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    dueAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    ageSeconds: 3 * 3600,
    conditionClearedAt: null,
    live: true,
    evidence: [
      { sourceType: 'ownership_period', sourceId: ID.pat, explanation: 'First human contact was due', at: new Date(Date.now() - 3 * 3_600_000).toISOString(), locator: null, snippet: null, needsReview: false, link: { kind: 'contact', id: ID.pat, contactId: ID.pat, offsetMs: null } },
      { sourceType: 'ownership_period', sourceId: ID.pat, explanation: 'Lead became theirs', at: new Date(Date.now() - 4 * 3_600_000).toISOString(), locator: null, snippet: null, needsReview: false, link: { kind: 'contact', id: ID.pat, contactId: ID.pat, offsetMs: null } },
    ],
    period: { current: true, movedOn: false },
    contactOwnershipSeq: 3,
    latestEvent: null,
    actions: { resolve: true, reassign: true, verify: true, reopen: false },
    ...over,
  };
}

export function queue(items: ExceptionItem[], live = items.filter((i) => i.live).length) {
  const byType = { untouched_lead: 0, overdue_promise: 0, failed_send: 0, missing_outcome: 0, milestone_at_risk: 0 };
  for (const i of items) if (i.live) byType[i.itemType] += 1;
  return { items, counts: { live, byType }, generatedAt: new Date().toISOString() };
}

export function board(over: Partial<Scoreboard> = {}): Scoreboard {
  return {
    userId: ID.ava,
    name: 'Ava Agent',
    speedToLead: { medianSeconds: 240, withinSla: 12, total: 14, responded: 13, pending: 1 },
    touches: { count: 34, calls: 20, textsAndEmails: 14, days: 7 },
    appointmentsSet: { count: 5, days: 7 },
    appointmentsHeld: { count: 3, of: 5 },
    agreementsSigned: { count: 1, days: 7 },
    ...over,
  };
}

export function member(over: Partial<Member> = {}): Member {
  return { userId: ID.ava, displayName: 'Ava Agent', email: 'ava@example.test', role: 'agent', status: 'active', acceptingLeads: true, mfaEnabled: false, joinedAt: '2026-10-01T00:00:00.000Z', version: 3, ...over };
}

export const settings: Settings = {
  version: 7,
  defaultTimezone: 'America/Los_Angeles',
  routingHoursStart: '08:00:00',
  routingHoursEnd: '20:00:00',
  offerWindowSeconds: 300,
  maxOffers: 3,
  firstTouchSlaSeconds: 300,
  firstTouchReleaseSeconds: 1800,
  reinquirySlaAfterDays: 30,
  inactivityReleaseDays: null,
  inactivityWarningHours: 24,
  autoPauseAfterMisses: 3,
  uncontactedCapacityCap: 5,
  isaAccessAfterHandoffDays: 7,
  recordingRetentionDays: 730,
  teamLeadRecordingAccess: false,
  tcRecordingAccess: false,
  notificationDetail: 'none',
  aiEnabled: true,
  activePolicyId: '01900000-0000-7000-8000-0000000000p1',
  identity: { brokerageLegalName: 'Harbor Realty LLC', teamName: 'Harbor Home Team', brokerageLicenseNumber: null, brokeragePostalAddress: null, missing: ['brokerage_postal_address'] },
};

export const POLICY_DEFAULTS: PolicyValues = {
  autonomousCategories: ['speed_to_lead_reply', 'reminder', 'booking_confirmation', 'nurture_step', 'search_alert'],
  optOutConfirmationSender: 'provider',
  recordingEnabled: true,
  recordingMode: 'announce_all',
};

export { FakeFetch };
export { err } from '../../../shell/testing/fakeApi.js';
