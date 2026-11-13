/// <reference types="node" />
// Fixtures for module 76's component tests (imported by *.test.tsx only). Every fixture is checked against the API's
// own response schemas (apps/api/src/isaWeb/webContract.json) in api.contract.test.tsx, so a fake can never say what
// the API cannot. The app is mounted whole on a scripted fetch with every agent surface plus this one and settings.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeFetch, renderApp, sessionFixture, tableWith } from '../../shell/testing/fakeApi.js';
import { type Schema, violations } from '../../test/contract.js';
import { AGENT_SURFACES, IDS, fullContact, iso } from '../feed/lib/testing.js';
import { surface as settingsSurface } from '../settings/index.js';
import { surface as bulkSurface } from '../bulk/index.js';
import type { AdminView, HandoffView, ListRow, MeView, PanelResponse, TurnRow } from './api.js';
import { surface as aiCareSurface } from './index.js';
import { resetUndoStore } from './undoStore.js';

export { FakeFetch, IDS, fullContact, iso };

export const ISA_IDS = {
  assignment: '01900000-0000-7000-8000-0000000a5501',
  assignment2: '01900000-0000-7000-8000-0000000a5502',
  handoff: '01900000-0000-7000-8000-0000000b0f01',
  version: '01900000-0000-7000-8000-0000000be001',
  optin: '01900000-0000-7000-8000-00000000b701',
  turn: '01900000-0000-7000-8000-0000000c0001',
  aiMessage: '01900000-0000-7000-8000-0000000a1001',
  other: '01900000-0000-7000-8000-0000000000bb',
  tl: '01900000-0000-7000-8000-0000000000cc',
  pending: '01900000-0000-7000-8000-0000000e5599',
} as const;

// ---- the contract -----------------------------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
export const ISA_CONTRACT_FILE = resolve(here, '../../../../api/src/isaWeb/webContract.json');
export const isaContract = JSON.parse(readFileSync(ISA_CONTRACT_FILE, 'utf8')) as { routes: Record<string, { inputKeys: string[]; body: Schema | null; query: Schema | null; response: Schema }>; errors: Record<string, number> };

/** z.record's `propertyNames` (any string key) is the one keyword the shared checker does not know: dropped. */
function strip(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(strip);
  if (s && typeof s === 'object') return Object.fromEntries(Object.entries(s as Record<string, unknown>).filter(([k]) => k !== 'propertyNames').map(([k, v]) => [k, strip(v)]));
  return s;
}
export function isaResponseViolations(key: string, body: unknown): string[] {
  const r = isaContract.routes[key];
  return r ? violations(strip(r.response) as Schema, body) : [`${key}: not a contract route`];
}
export function isaRequestViolations(key: string, body: unknown): string[] {
  const r = isaContract.routes[key];
  if (!r) return [`${key}: not a contract route`];
  if (!r.body) return body === undefined ? [] : ['body: this route takes none'];
  return violations(strip(r.body) as Schema, body);
}
export function isaError(code: string, details?: Record<string, unknown>) {
  const status = isaContract.errors[code];
  if (status === undefined) throw new Error(`${code} is not an error code of the AI ISA contract`);
  return { status, body: { error: details ? { code, requestId: 'req-1', details } : { code, requestId: 'req-1' } } };
}

// ---- fixtures -----------------------------------------------------------------------------------------------------

const CHAIN_OK = [1, 2, 3, 4, 5, 6, 7, 8].map((link) => ({ link, name: `Link ${link}`, effect: 'ok' as const, code: null, sentence: 'ok' }));

export function panel(over: Partial<PanelResponse> & { state?: 'live' | 'paused' | 'ended' | 'none'; owner?: string } = {}): PanelResponse {
  const { state = 'live', owner = IDS.me, ...rest } = over;
  const assignment =
    state === 'none'
      ? null
      : {
          id: ISA_IDS.assignment,
          side: 'buyer' as const,
          state: state === 'live' ? ('engaged' as const) : state === 'paused' ? ('paused' as const) : ('ended' as const),
          chip: state === 'live' ? { kind: 'active' as const, sentence: 'Active' } : state === 'paused' ? { kind: 'paused' as const, sentence: 'Paused: user (nobody is following up)' } : { kind: 'ended' as const, sentence: 'Ended: opted out' },
          epoch: 1,
          startedAt: iso(-86_400_000),
          pausedAt: state === 'paused' ? iso(-600_000) : null,
          pauseReason: state === 'paused' ? 'user' : null,
          pausedSentence: state === 'paused' ? 'Paused: nobody is following up automatically.' : null,
          endedAt: state === 'ended' ? iso(-60_000) : null,
          endReason: state === 'ended' ? 'opted_out' : null,
          undoUntil: null,
          ownerUserId: owner,
        };
  return {
    contactId: IDS.jane,
    assignment,
    canStart: false,
    startRefusal: null,
    canResume: state === 'paused' && owner === IDS.me,
    chain: state === 'none' ? [] : CHAIN_OK,
    capabilities: state === 'none' ? [] : ['converse', 'share_listings', 'propose_saved_search', 'seller_competition', 'seller_sold_comps', 'book_appointments'].map((c) => ({ capability: c, allowed: c === 'converse', sentence: 'x' })),
    consent: state === 'none' ? [] : [{ channel: 'sms', sentence: 'Texts: OK for replies within 24 h of their text.' }],
    zones: { zones: state === 'none' ? [] : ['America/Chicago'], source: 'explicit', sentence: 'Their time zone was set on the person.' },
    nextAllowedSendAt: null,
    capsSentence: state === 'none' ? '' : '2 of 6 today',
    lastDecision: null,
    factsSent: [],
    openOffer: null,
    heldTopics: [],
    handoff: null,
    inactivityReleaseAt: null,
    inactivitySentence: null,
    block: null,
    ...rest,
  };
}

export function row(over: Partial<ListRow> = {}): ListRow {
  return {
    assignmentId: ISA_IDS.assignment,
    contactId: IDS.jane,
    name: 'Jane Doe',
    side: 'buyer',
    chip: { kind: 'active', sentence: 'Active' },
    lastAction: null,
    nextTouchAt: null,
    capsSentence: '',
    inactivityReleaseAt: null,
    ownerUserId: IDS.me,
    ownerName: 'Ava Agent',
    handoffOverdue: false,
    ...over,
  };
}

export function turn(over: Partial<TurnRow> = {}): TurnRow {
  return {
    id: ISA_IDS.turn,
    seq: 1,
    epoch: 1,
    attempt: 1,
    triggerKind: 'inbound',
    status: 'sent',
    stateBefore: 'engaged',
    stateAfter: 'engaged',
    channel: 'sms',
    messageKind: 'reply',
    messageId: ISA_IDS.aiMessage,
    notBefore: null,
    zones: ['America/Chicago'],
    decision: { reply: true, escalations: [] },
    denied: [],
    versions: { rules: 'r1', policy: 'p1', prompt: 'q1' },
    createdAt: iso(-300_000),
    ...over,
  };
}

export function adminView(over: Partial<AdminView> = {}): AdminView {
  return {
    enabled: true,
    aiEnabled: true,
    dailyCap: 100,
    sentToday: 3,
    packCleared: true,
    liveSends: true,
    holdSentence: null,
    enabledByUserId: IDS.me,
    enabledAt: iso(-86_400_000),
    overdueHandoffs: 0,
    underCare: 2,
    noticeSentence: 'The AI assistant (ISA) uses engineering defaults for consent evidence, quiet hours and frequency limits on its own messages. These are not legal advice and have not been reviewed by counsel.',
    ...over,
  };
}

export const SHA = 'a'.repeat(64);
export function meView(over: Partial<MeView> = {}): MeView {
  return {
    optIn: null,
    policy: { versionId: ISA_IDS.version, versionSha: SHA, capabilities: ['converse', 'share_listings', 'book_appointments'], channels: ['sms', 'email'] },
    attestationText: `I opt in to the team's AI assistant policy version ${SHA}. I'm responsible for leads I put in AI care.`,
    needsReattest: false,
    calendarLive: false,
    underCare: 0,
    sentence: 'You have not opted in. Nothing is sent for your leads.',
    ...over,
  };
}

export function optIn(over: Partial<NonNullable<MeView['optIn']>> = {}): NonNullable<MeView['optIn']> {
  return { id: ISA_IDS.optin, versionId: ISA_IDS.version, capabilities: ['converse'], channels: ['sms', 'email'], timezone: 'America/New_York', availability: [], bookingKinds: [], createdAt: iso(-86_400_000 * 3), ...over };
}

export function handoffView(over: Partial<HandoffView> = {}): HandoffView {
  return {
    id: ISA_IDS.handoff,
    assignmentId: ISA_IDS.assignment,
    contactId: IDS.jane,
    reason: 'escalated',
    slaClass: 'critical',
    slaDueAt: iso(15 * 60_000),
    slaMetAt: null,
    overdue: false,
    createdAt: iso(-60_000),
    acknowledgedAt: null,
    acknowledgedByUserId: null,
    recipientUserId: IDS.me,
    canAcknowledge: true,
    confirmationStatus: 'none',
    pendingMessage: null,
    package: {
      v: 1,
      reason: 'escalated',
      escalation: 'human_request',
      priority: 'critical',
      basis: null,
      appointment: null,
      openOffer: null,
      commitments: ['human_request'],
      claims: [{ claimId: 'c1', field: 'financing_status_stated', value: 'cash', quote: 'we have cash ready', messageId: IDS.message }],
      conversation: [{ seq: 1, status: 'sent', messageId: ISA_IDS.aiMessage }],
      factsSent: [],
      unansweredInbound: [IDS.message],
      nextSteps: ['call_now'],
      notes: ['IN_FLIGHT:01900000-0000-7000-8000-000000000001'],
      startedAt: iso(-86_400_000),
      epoch: 1,
    },
    ...over,
  };
}

// ---- the app ------------------------------------------------------------------------------------------------------

export type TestRole = 'owner' | 'admin' | 'team_lead' | 'agent' | 'isa' | 'tc';
export const isaTable = () => tableWith(...AGENT_SURFACES, settingsSurface, bulkSurface, aiCareSurface);

/** Mounts the whole app as `role`, with the shared live query answered empty unless the test says otherwise. */
export function isaApp(fake: FakeFetch, path: string, role: TestRole = 'agent', o: { userId?: string; reauthenticatedAt?: string | null } = {}) {
  resetUndoStore();
  const s = sessionFixture({ reauthenticatedAt: o.reauthenticatedAt ?? null });
  const tenant = { ...s.tenant!, role };
  const user = { ...s.user, id: o.userId ?? s.user.id };
  fake.on('GET /auth/session', { status: 200, body: { ...s, user, tenant, tenants: [tenant] } });
  if (!hasHandler(fake, 'GET /ai-isa/assignments?scope=all&state=live')) fake.on('GET /ai-isa/assignments?scope=all&state=live', { status: 200, body: { rows: [], holdSentence: null } });
  return renderApp({ fake, path, table: isaTable() });
}

function hasHandler(fake: FakeFetch, key: string): boolean {
  return (fake as unknown as { handlers: Map<string, unknown> }).handlers.has(key);
}

/** The person-page and thread reads every test needs (reachability open, an empty timeline). */
export function contactReads(fake: FakeFetch, contact = fullContact()): FakeFetch {
  return fake
    .on(`GET /contacts/${contact.id}`, { status: 200, body: { contact } })
    .on(`GET /contacts/${contact.id}/timeline?limit=100`, { status: 200, body: { items: [], nextCursor: null } })
    .on('GET /assistant/inbox', { status: 200, body: { items: [] } })
    .on(`GET /tasks?contactId=${contact.id}&scope=visible&status=open`, { status: 200, body: { tasks: [] } })
    .on(`GET /deals?contactId=${contact.id}`, { status: 200, body: { deals: [] } });
}
