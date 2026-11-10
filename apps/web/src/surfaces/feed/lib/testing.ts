// Fixtures for the web/agent component tests (imported by *.test.tsx only). Shapes follow the API
// response schemas (api/workspace, api/leads, api/comms, api/assistant). The app is mounted whole
// (shell providers, routes from a page table holding every agent surface) on a scripted fetch.
import { FakeFetch, renderApp, sessionFixture, tableWith } from '../../../shell/testing/fakeApi.js';
import { surface as approvalsSurface } from '../../approvals/index.js';
import { surface as composeSurface } from '../../compose/index.js';
import { surface as contactSurface } from '../../contact/index.js';
import { surface as dealsSurface } from '../../deals/index.js';
import { surface as listingsSurface } from '../../listings/index.js';
import { surface as pondSurface } from '../../pond/index.js';
import { surface as searchSurface } from '../../search/index.js';
import { surface as tasksSurface } from '../../tasks/index.js';
import { surface as threadSurface } from '../../thread/index.js';
import { surface as feedSurface } from '../index.js';
import type { ActionView, ContactCardView, ContactFullView, DecisionView, FeedCard, FeedResponse, TimelineItem } from './types.js';

export const AGENT_SURFACES = [feedSurface, approvalsSurface, searchSurface, tasksSurface, pondSurface, dealsSurface, listingsSurface, contactSurface, threadSurface, composeSurface];
export const agentTable = () => tableWith(...AGENT_SURFACES);

export const IDS = {
  jane: '01900000-0000-7000-8000-00000000c001',
  pat: '01900000-0000-7000-8000-00000000c002',
  offer: '01900000-0000-7000-8000-00000000f001',
  pond: '01900000-0000-7000-8000-00000000d001',
  draft: '01900000-0000-7000-8000-00000000a001',
  handback: '01900000-0000-7000-8000-00000000a002',
  proposal: '01900000-0000-7000-8000-00000000a003',
  call: '01900000-0000-7000-8000-0000000ca111',
  message: '01900000-0000-7000-8000-0000000e5501',
  task: '01900000-0000-7000-8000-0000000ta001',
  appt: '01900000-0000-7000-8000-0000000ap001',
  deal: '01900000-0000-7000-8000-0000000de001',
  search: '01900000-0000-7000-8000-0000000ss001',
  claim: '01900000-0000-7000-8000-0000000c1a1',
  claim2: '01900000-0000-7000-8000-0000000c1a2',
  decision: '01900000-0000-7000-8000-0000000dec1',
  me: '01900000-0000-7000-8000-0000000000aa',
} as const;

export const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();

let seq = 0;
export function card(over: Partial<FeedCard> & Pick<FeedCard, 'primaryAction'>): FeedCard {
  return {
    id: `01900000-0000-7000-8000-${String(++seq).padStart(12, '0')}`,
    itemType: 'unanswered_inbound',
    band: 'scored',
    dueAt: null,
    contact: { id: IDS.jane, name: 'Jane Doe' },
    reasons: [{ code: 'CLIENT_WAITING', label: 'Waiting for your reply' }],
    alternatives: [],
    subjectType: 'contact',
    subjectId: IDS.jane,
    assistantActionId: null,
    createdAt: iso(-60_000),
    ...over,
  };
}

export function offerCard(msLeft = 299_000): FeedCard {
  return card({
    itemType: 'lead_offer',
    band: 'pinned',
    dueAt: iso(msLeft),
    contact: { id: IDS.pat, name: 'Pat L.' },
    reasons: [
      { code: 'LEAD_OFFER', label: 'New lead offered to you' },
      { code: 'LEAD_SOURCE', label: 'From Zillow' },
    ],
    primaryAction: { kind: 'accept_offer', label: 'Accept', contactId: IDS.pat, offerId: IDS.offer },
    alternatives: [{ kind: 'decline_offer', label: 'Decline', contactId: IDS.pat, offerId: IDS.offer }],
    subjectId: IDS.pat,
  });
}

export function feed(pinned: FeedCard[] = [], scored: FeedCard[] = [], total?: number): FeedResponse {
  return { pinned, scored, total: total ?? pinned.length + scored.length, generatedAt: new Date().toISOString() };
}

export const allow: DecisionView = { id: null, outcome: 'allow', reasons: [], explanation: '', deferUntil: null, canConfirm: false, phase: 'preview' };

export function decision(over: Partial<DecisionView>): DecisionView {
  return { ...allow, id: IDS.decision, phase: 'send', ...over };
}

export function fullContact(over: Partial<ContactFullView> = {}): ContactFullView {
  return {
    id: IDS.jane,
    view: 'full',
    displayName: 'Jane Doe',
    firstName: 'Jane',
    lastName: 'Doe',
    intent: 'buyer',
    stage: 'new',
    contactType: 'lead',
    timezone: 'America/Los_Angeles',
    tags: [],
    createdAt: iso(-86_400_000),
    lastHumanTouchAt: null,
    pondSummary: null,
    source: { id: '01900000-0000-7000-8000-0000000500c1', name: 'Zillow', kind: 'portal' },
    attribution: { leadSourceId: null, campaignRef: null, adRef: null, sourceDetail: {} },
    owner: { userId: IDS.me, displayName: 'Ava Agent' },
    ownership: {
      state: 'owned',
      ownerUserId: IDS.me,
      pondId: null,
      offerId: null,
      offeredToUserId: null,
      offerExpiresAt: null,
      offerRound: 1,
      ownedAt: iso(-3_600_000),
      firstTouchDueAt: null,
      firstTouchAt: iso(-3_000_000),
      firstTouchBreachedAt: null,
      releaseDueAt: null,
      closedReason: null,
      seq: 4,
      pondName: null,
      offeredToMe: false,
      ownedByMe: true,
    },
    phones: [{ id: '01900000-0000-7000-8000-0000000p0001', address: '+14155550123', label: 'mobile', lineType: 'mobile', status: 'valid', isPrimary: true }],
    emails: [{ id: '01900000-0000-7000-8000-0000000p0002', address: 'jane@example.test', label: 'personal', lineType: 'email', status: 'valid', isPrimary: true }],
    inquiries: [],
    mergedIntoContactId: null,
    ...over,
  };
}

export function pondCard(over: Partial<ContactCardView> = {}): ContactCardView {
  return {
    id: IDS.pat,
    view: 'card',
    displayName: 'Pat L.',
    intent: 'buyer',
    source: { id: '01900000-0000-7000-8000-0000000500c1', name: 'Zillow', kind: 'portal' },
    createdAt: iso(-7_200_000),
    pondSummary: 'Buyer · 94110 · $600k–$800k',
    ownership: { state: 'in_pond', pondId: IDS.pond, pondName: 'Team pond', offerId: null, offerExpiresAt: null, offeredToMe: false, seq: 6 },
    ...over,
  };
}

export function draftAction(over: Partial<ActionView> = {}): ActionView {
  return {
    id: IDS.draft,
    kind: 'message_draft',
    category: 'novel_message',
    status: 'proposed',
    contactId: IDS.jane,
    contactName: 'Jane Doe',
    explanation: 'She asked whether Saturday works for a showing.',
    primaryAction: 'send',
    draft: { channel: 'sms', subject: null, body: 'Hi Jane, Saturday at 11 works. Want me to book it?' },
    claims: [
      {
        id: IDS.claim,
        kind: 'client_request',
        text: 'Wants a Saturday showing',
        needsReview: false,
        reviewStatus: 'unreviewed',
        due: null,
        evidence: [{ sourceType: 'message', sourceId: IDS.message, locator: { kind: 'message' }, snippet: 'does saturday work?', verified: true, sourceAvailable: true, label: '“does saturday work?” in the text' }],
      },
    ],
    createdAt: iso(-120_000),
    ...over,
  };
}

export function timelineItem(over: Partial<TimelineItem> = {}): TimelineItem {
  return { id: IDS.message, type: 'message', occurredAt: iso(-600_000), actor: null, detail: 'sms:inbound', preview: 'does saturday work?', note: null, provenance: 'native', ...over };
}

export function agentApp(fake: FakeFetch, path = '/', role: 'agent' | 'owner' | 'team_lead' | 'tc' | 'isa' | 'admin' = 'agent') {
  const s = sessionFixture();
  const tenant = { ...s.tenant!, role };
  fake.on('GET /auth/session', { status: 200, body: { ...s, tenant, tenants: [tenant] } });
  return renderApp({ fake, path, table: agentTable() });
}

export { FakeFetch };
export { err } from '../../../shell/testing/fakeApi.js';
