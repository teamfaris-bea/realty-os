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
import { AI_ISA_POLICY_FIELDS, AI_ISA_POLICY_TEXT_VERSION, type AiIsaContent, DEFAULT_AI_ISA_CONTENT, aiIsaPolicyApprovalText, aiIsaPolicyRevokeText, policyDiff, policySections } from '@realty/core/isa';
import type { AdminView, HandoffView, ListRow, MeView, PanelResponse, PolicyDraft, PolicyVersion, PolicyView, SellerPanelView, TurnRow } from './api.js';
import { surface as aiCareSurface } from './index.js';
import { resetUndoStore } from './undoStore.js';

export { FakeFetch, IDS, fullContact, iso };
export { DEFAULT_AI_ISA_CONTENT };

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
    canContinue: false,
    continueRefusal: null,
    chain: state === 'none' ? [] : CHAIN_OK,
    capabilities: state === 'none' ? [] : ['converse', 'share_listings', 'propose_saved_search', 'seller_competition', 'seller_sold_comps', 'book_appointments'].map((c) => ({ capability: c, allowed: c === 'converse', built: true, sentence: 'x' })),
    consent: state === 'none' ? [] : [{ channel: 'sms', sentence: 'Texts: OK for replies within 24 h of their text.' }],
    zones: { zones: state === 'none' ? [] : ['America/Chicago'], source: 'explicit', sentence: 'Their time zone was set on the person.' },
    nextAllowedSendAt: null,
    capsSentence: state === 'none' ? '' : '2 of 6 today',
    lastDecision: null,
    factsSent: [],
    openOffer: null,
    heldTopics: [],
    handoff: null,
    earlierHandoff: null,
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
    policy: { versionId: ISA_IDS.version, versionSha: SHA, capabilities: ['converse', 'share_listings', 'book_appointments'], channels: ['sms', 'email'], versionNo: 1, sections: policySections(DEFAULT_AI_ISA_CONTENT) },
    policyChange: null,
    attestationText: `I opt in to the team's AI assistant policy version ${SHA}. I'm responsible for leads I put in AI care.`,
    needsReattest: false,
    calendarLive: false,
    builtCapabilities: ['converse', 'share_listings', 'propose_saved_search', 'seller_competition', 'seller_sold_comps', 'book_appointments'],
    underCare: 0,
    sentence: 'You have not opted in. Nothing is sent for your leads.',
    ...over,
  };
}

// ---- the seller side of the panel (R-ISA-35) ----
export const SELLER_IDS = { address: '01900000-0000-7000-8000-0000000d0001', record: '01900000-0000-7000-8000-0000000d0002', near: '01900000-0000-7000-8000-0000000d0003' } as const;
const NO = (reason: string) => ({ available: false, reason });
/** An unconfirmed home of a seller lead, as its owner sees it: Confirm is the one action offered. */
export function sellerPanel(over: Partial<SellerPanelView> = {}): SellerPanelView {
  return {
    actions: { confirmSubject: { available: true, reason: null }, subjectDisputed: NO('The owner has not confirmed the home yet.'), nearMatchDifferent: { ...NO('No live listing may be this home.'), listingIds: [] }, resumeComps: NO('Recent sales are not paused.') },
    contactId: IDS.jane, assignmentId: ISA_IDS.assignment, side: 'seller',
    subject: { state: 'ok', code: null, sentence: 'The home’s MLS record was found.', nextStep: null, contactAddressId: SELLER_IDS.address, addressLine: '12 Sample Ct, Oakland, CA 94110', recordListingId: SELLER_IDS.record, recordDate: iso(-86_400_000 * 400),
      facts: { type: 'single_family', beds: 3, baths_x10: 20, sqft: 1500 }, factsSha256: SHA, confirmed: false, confirmedAt: null, disputed: false, clearedReason: null, codes: ['SUBJECT_UNCONFIRMED'] },
    blockers: [], lastCompsCheck: null,
    capabilities: { comps: { available: false, sentence: 'Can share recent sales: no — SUBJECT_UNCONFIRMED.' }, competition: { available: false, sentence: 'Can share competing listings: no — confirm the home first.' } },
    link: { effect: 'ok', code: null, sentence: 'No live listing at this home.', listingIds: [] },
    suspension: { suspended: false, sentence: null }, watch: { lastRunAt: null, sentence: 'Competition updates are not sent yet (not built yet).' }, counts: null, factsSent: [],
    ...over,
  };
}

// ---- the team AI policy (R-ISA-33, R-ISA-34): built with core's own words, as the server builds it ----
export const POLICY_IDS = { v1: '01900000-0000-7000-8000-0000000c0001', v2: '01900000-0000-7000-8000-0000000c0002' } as const;
const fieldsView = (): PolicyView['fields'] => AI_ISA_POLICY_FIELDS.map((f) => ({ ...f, path: [...f.path], ...(f.options ? { options: [...f.options] } : {}), ...(f.locked ? { locked: [...f.locked] } : {}) })) as PolicyView['fields'];
export function policyVersion(content: AiIsaContent, over: Partial<PolicyVersion> = {}): PolicyVersion {
  return { versionId: POLICY_IDS.v1, versionNo: 1, contentSha256: SHA, content: content as unknown as Record<string, unknown>, sections: policySections(content), decidedAt: iso(-86_400_000), decidedBy: 'Olive Owner', decidedByRole: 'Owner', ...over };
}
/** A draft against `approved` (null: nothing approved): the diff, the effect and the texts are core's. */
export function policyDraft(content: AiIsaContent, approved: AiIsaContent | null, over: Partial<PolicyDraft> = {}): PolicyDraft {
  const diff = approved ? policyDiff(approved, content) : null;
  const effect = over.effect !== undefined ? over.effect : approved === null ? 'first' : diff!.wider ? 'wider' : 'narrower';
  const versionNo = over.versionNo ?? (approved ? 2 : 1);
  const sha = over.contentSha256 ?? 'b'.repeat(64);
  return {
    versionId: approved ? POLICY_IDS.v2 : POLICY_IDS.v1, versionNo, contentSha256: sha, content: content as unknown as Record<string, unknown>, sections: policySections(content), savedAt: iso(-3_600_000), savedBy: 'Olive Owner', issues: [],
    effect,
    effectSentence: effect === 'wider' ? `This version lets the assistant do more than the approved one: it ${diff!.adds.join('; ').replace(/^may /, 'may now ')}. Approving it pauses AI care for every lead until each agent re-confirms.`
      : effect === 'narrower' ? 'This version lets the assistant do no more than the approved one. AI care continues under it at once.'
      : effect === 'first' ? 'Nothing is approved yet, so approving this pauses nothing. Agents can opt in once it is approved.'
      : effect === 'after_revoke' ? 'The last approved version was revoked. AI care stays paused for every lead until each agent re-confirms on this version.' : 'This draft cannot be approved until the marked values are fixed.',
    diff, approvalText: effect === null ? null : aiIsaPolicyApprovalText({ versionNo, contentSha256: sha, effect }),
    ...over,
  };
}
export function policyView(over: Partial<PolicyView> = {}): PolicyView {
  const approved = over.approved === undefined ? policyVersion(DEFAULT_AI_ISA_CONTENT) : over.approved;
  return {
    state: 'approved', sentence: 'Version 1 is approved and in use.', fields: fieldsView(), textVersion: AI_ISA_POLICY_TEXT_VERSION, underCare: 2, optedIn: 3, approved, revoked: null, draft: null,
    revokeText: approved ? aiIsaPolicyRevokeText({ versionNo: approved.versionNo, contentSha256: approved.contentSha256 }) : null,
    can: { create: false, saveDraft: true, approve: false, revoke: approved !== null }, approveOwnerOnly: false,
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
    closedReason: null,
    createdAt: iso(-60_000),
    acknowledgedAt: null,
    acknowledgedByUserId: null,
    recipientUserId: IDS.me,
    canAcknowledge: true,
    confirmationStatus: 'none',
    confirmationNotSent: null,
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
