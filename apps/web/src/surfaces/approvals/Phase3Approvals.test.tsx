// The module 55 approval cards (item 11) in the real approvals inbox, on the staff contract: the ad shift through the
// Ads page's ProposalCard (Owner/Admin), Google review replies (Owner/Admin), contract extraction pointers (every role),
// the "Nothing to approve" chain, role-gated reads (R-STAFF-6) and one decision path per kind (R-STAFF-2).
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { StaffFake, staffError } from '../../test/staffContract.js';
import { ADS_IDS, RAW, darkOverview, overview, run } from '../ads/testing.js';
import { IDS, agentApp, draftAction } from '../feed/lib/testing.js';
import type { ActionView } from '../feed/lib/types.js';
import type { PieceView } from '../marketing/types.js';
import type { OpenExtraction } from './ExtractionPointers.js';
import type { ReviewView } from './ReviewReplyApproval.js';

type Role = 'owner' | 'admin' | 'team_lead' | 'agent' | 'isa' | 'tc';
const user = () => userEvent.setup();
const settle = () => new Promise((r) => setTimeout(r, 40));
const mainText = () => screen.getByRole('main').textContent ?? '';

const REVIEW = '01900000-0000-7000-8000-0000000ab001';
const ACTION = '01900000-0000-7000-8000-0000000ab0a1';
const LOCATION = '01900000-0000-7000-8000-0000000ab0c1';
const DOC = '01900000-0000-7000-8000-0000000ab0d1';
const DEAL = '01900000-0000-7000-8000-0000000ab0d2';

const review = (over: Partial<ReviewView> = {}): ReviewView => ({
  id: REVIEW,
  connectionId: LOCATION,
  rating: 4,
  body: 'Great help finding our first home. <b>Thanks!</b>',
  reviewerDisplay: 'Robin Q.',
  reviewedAt: '2026-11-10T12:00:00.000Z',
  state: 'draft_waiting',
  stateLabel: 'Draft waiting',
  draft: { actionId: ACTION, text: 'Thank you for the kind words. It was a pleasure working with you.', guard: [], byAssistant: true },
  ...over,
});

const extraction = (over: Partial<OpenExtraction> = {}): OpenExtraction => ({
  documentId: DOC,
  dealId: DEAL,
  displayName: 'Purchase agreement.pdf',
  versionNo: 2,
  outcome: 'dates',
  unreviewedClaims: 3,
  createdAt: '2026-11-12T09:00:00.000Z',
  ...over,
});

const piece = (): PieceView =>
  ({
    id: '01900000-0000-7000-8000-0000000ab0e1', listingId: '01900000-0000-7000-8000-0000000ab0e2', kind: 'social_post', versionNo: 1, status: 'draft', statusLabel: 'Draft: not approved yet',
    prose: {}, contentSha256: 'a'.repeat(64), timezone: 'America/New_York', preview: { text: 'A bright home.', blocks: [] }, assets: [],
    guard: { approvable: true, reasons: [], checkThis: false, soft: [] }, publicPath: null, publications: [], publishOptions: [], earlierPostNotice: null, exportable: false, invitable: false,
  }) as unknown as PieceView;

interface World {
  items?: ActionView[];
  pieces?: PieceView[];
  ads?: ReturnType<typeof overview>;
  gbp?: 'not_cleared' | 'connected';
  reviews?: ReviewView[];
  extractions?: OpenExtraction[];
}

function world(w: World = {}): StaffFake {
  return new StaffFake()
    .on('GET /assistant/inbox', { status: 200, body: { items: w.items ?? [] } })
    .on('GET /marketing/approvals', { status: 200, body: { pieces: w.pieces ?? [] } })
    .on('GET /ads', { status: 200, body: w.ads ?? overview({ pendingProposal: null }) })
    .on('GET /gbp/status', {
      status: 200,
      body: { status: w.gbp === 'not_cleared' ? { state: 'not_cleared', sentence: 'Google Business Profile stays off until counsel reviews it (pack platform:gbp 1.0.0). Nothing is read from or posted to Google.', locations: [] } : { state: 'connected', sentence: 'One Business Profile location is connected.', locations: [{ connectionId: LOCATION, displayName: 'Harbor office', sentence: 'Reviews last checked Nov 13, 10:00 AM' }] } },
    })
    .on('GET /gbp/reviews?filter=needs_reply', { status: 200, body: { reviews: { state: 'ready', sentence: 'Reviews.', reviews: w.reviews ?? [] } } })
    .on('GET /documents/extractions', { status: 200, body: { extractions: w.extractions ?? [] } });
}

const open = (fake: StaffFake, role: Role = 'owner') => agentApp(fake, '/approvals', role);
const ownerAdminPaths = (fake: StaffFake) => fake.calls.filter((c) => c.path.startsWith('/ads') || c.path.startsWith('/gbp')).map((c) => `${c.method} ${c.path}`);

describe('the "Nothing to approve" chain', () => {
  it('shows only when every source is empty: inbox, marketing, ad shift, review replies and contract dates', async () => {
    open(world());
    expect(await screen.findByText('Nothing to approve', {}, { timeout: 4000 })).toBeInTheDocument();
  });

  const one: [string, World, RegExp][] = [
    ['an assistant card', { items: [draftAction()] }, /She asked whether Saturday works/],
    ['a marketing draft', { pieces: [piece()] }, /Marketing to approve/],
    ['an ad shift', { ads: overview() }, /Google Ads budget to approve/],
    ['a review reply', { reviews: [review()] }, /Review replies to approve/],
    ['a contract extraction', { extractions: [extraction()] }, /Contract dates to review/],
  ];
  for (const [what, w, shown] of one) {
    it(`is not said when only ${what} waits, and the others still render beside it`, async () => {
      open(world(w));
      expect(await screen.findByText(shown)).toBeInTheDocument();
      await settle();
      expect(screen.queryByText('Nothing to approve')).toBeNull();
    });
  }

  it('an assistant card and a module 55 card show together', async () => {
    open(world({ items: [draftAction()], extractions: [extraction()], reviews: [review()] }));
    expect(await screen.findByText(/She asked whether Saturday works/)).toBeInTheDocument();
    expect(await screen.findByText('Purchase agreement.pdf')).toBeInTheDocument();
    expect(screen.getByText('Review from Robin Q.')).toBeInTheDocument();
  });
});

describe('role gating', () => {
  for (const role of ['team_lead', 'agent', 'isa', 'tc'] as const) {
    it(`R-STAFF-6: ${role} never requests GET /ads or the Google reviews; contract dates still show`, async () => {
      const fake = world({ ads: overview(), reviews: [review()], extractions: [extraction()] });
      open(fake, role);
      expect(await screen.findByText('Purchase agreement.pdf')).toBeInTheDocument();
      await settle();
      expect(ownerAdminPaths(fake)).toEqual([]);
      expect(screen.queryByText(/Budget proposal|Review from/)).toBeNull();
    });
  }

  it('R-STAFF-6: an Admin sees the ad shift and the review replies', async () => {
    open(world({ ads: overview(), reviews: [review()] }), 'admin');
    expect(await screen.findByRole('article', { name: 'Budget proposal' })).toBeInTheDocument();
    expect(await screen.findByRole('article', { name: 'Review from Robin Q.' })).toBeInTheDocument();
  });
});

describe('ad shift card', () => {
  it('R-STAFF-2 R-STAFF-4: Approvals → Approve is one tap and one request to /ads/proposals/:id/approve, never an /assistant route', async () => {
    const fake = world({ ads: overview() }).on(`POST /ads/proposals/${ADS_IDS.proposal}/approve`, { status: 200, body: run('pending') });
    open(fake);
    const c = await screen.findByRole('article', { name: 'Budget proposal' });
    expect(within(c).getByTestId('proposal-total')).toHaveTextContent('against your $120.00 daily ceiling');
    await user().click(within(c).getByRole('button', { name: 'Approve' }));
    expect(await within(c).findByText('Approved. Waiting for Google Ads to confirm; checked hourly.')).toBeInTheDocument();
    await settle();
    expect(fake.callsTo(`POST /ads/proposals/${ADS_IDS.proposal}/approve`)).toHaveLength(1);
    expect(fake.callsTo(`POST /ads/proposals/${ADS_IDS.proposal}/approve`)[0]!.body).toEqual({});
    expect(fake.calls.filter((x) => x.method !== 'GET' && x.path.startsWith('/assistant'))).toEqual([]);
    expect(within(c).queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('E667 R-STAFF-1: while platform:ads is not cleared no ad shift shows (and Nothing to approve can)', async () => {
    open(world({ ads: darkOverview() }));
    expect(await screen.findByText('Nothing to approve', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByRole('article', { name: 'Budget proposal' })).toBeNull();
  });
});

describe('review reply card', () => {
  it('R-STAFF-3 R-STAFF-5: "n of 5 stars", the review and the draft as text; Post reply sends {actionId, text} once', async () => {
    const fake = world({ reviews: [review()] }).on(`POST /gbp/reviews/${REVIEW}/reply`, { status: 200, body: { review: review({ state: 'posting', stateLabel: 'Posting', draft: null }), outcome: 'replied', sentence: 'Reply posted to Google.' } });
    open(fake);
    const c = await screen.findByRole('article', { name: 'Review from Robin Q.' });
    expect(c.textContent).toContain('4 of 5 stars');
    expect(within(c).getByText('Great help finding our first home. <b>Thanks!</b>')).toBeInTheDocument();
    expect(c.querySelector('b')).toBeNull();
    expect(within(c).getByText(review().draft!.text)).toBeInTheDocument();
    expect(within(c).getByRole('link', { name: 'Edit' })).toHaveAttribute('href', `/gbp#review-${REVIEW}`);
    await user().click(within(c).getByRole('button', { name: 'Post reply' }));
    expect(await within(c).findByText('Reply posted to Google.')).toBeInTheDocument();
    await settle();
    const calls = fake.callsTo(`POST /gbp/reviews/${REVIEW}/reply`);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ actionId: ACTION, text: review().draft!.text });
    expect(fake.calls.filter((x) => x.method !== 'GET' && x.path.startsWith('/assistant'))).toEqual([]);
  });

  it('E663 R-STAFF-2: a draft the guard flagged shows its words and no Post reply', async () => {
    open(world({ reviews: [review({ draft: { ...review().draft!, guard: ['REVIEWER_NAME', 'DATE'] } })] }));
    const c = await screen.findByRole('article', { name: 'Review from Robin Q.' });
    expect(within(c).getByText("Can't post yet: it names the reviewer; it mentions a date. Edit the reply first.")).toBeInTheDocument();
    expect(within(c).queryByRole('button', { name: 'Post reply' })).toBeNull();
    expect(within(c).getByRole('button', { name: 'Discard' })).toBeInTheDocument();
    expect(c.textContent).not.toMatch(RAW);
  });

  const refusals: [string, Record<string, unknown> | undefined, string][] = [
    ['REPLY_PRIVACY', { codes: ['MONEY'], spans: [] }, "Can't post yet: it mentions a price or an amount. Edit the reply first."],
    ['REPLY_STALE', undefined, 'The review changed at Google after this reply was drafted. Draft the reply again.'],
    ['PLATFORM_NOT_CLEARED', { pack: 'platform:fair_housing' }, 'Posting waits for counsel review of publishing marketing (fair-housing rules). Nothing was posted.'],
    ['CHANNEL_NOT_CONNECTED', undefined, 'This Business Profile location is not connected. Nothing was posted.'],
  ];
  for (const [code, details, words] of refusals) {
    it(`E663: ${code} is said in words, Post stays off until the reply is edited or drafted again, nothing re-sent`, async () => {
      const fake = world({ reviews: [review()] }).on(`POST /gbp/reviews/${REVIEW}/reply`, staffError(code, details));
      open(fake);
      const c = await screen.findByRole('article', { name: 'Review from Robin Q.' });
      await user().click(within(c).getByRole('button', { name: 'Post reply' }));
      expect(await within(c).findByText(words)).toBeInTheDocument();
      expect(within(c).queryByRole('button', { name: 'Post reply' })).toBeNull();
      expect(within(c).getByRole('link', { name: 'Edit' })).toBeInTheDocument();
      await settle();
      expect(fake.callsTo(`POST /gbp/reviews/${REVIEW}/reply`)).toHaveLength(1);
      expect(mainText()).not.toMatch(RAW);
    });
  }

  it('R-STAFF-2 R-STAFF-4: Discard sends {actionId} once', async () => {
    const fake = world({ reviews: [review()] }).on(`POST /gbp/reviews/${REVIEW}/discard`, { status: 200, body: { review: review({ state: 'needs_reply', stateLabel: 'Needs a reply', draft: null }) } });
    open(fake);
    const c = await screen.findByRole('article', { name: 'Review from Robin Q.' });
    await user().click(within(c).getByRole('button', { name: 'Discard' }));
    expect(await within(c).findByText('Draft discarded. The review still needs a reply.')).toBeInTheDocument();
    expect(fake.callsTo(`POST /gbp/reviews/${REVIEW}/discard`)).toHaveLength(1);
    expect(fake.callsTo(`POST /gbp/reviews/${REVIEW}/discard`)[0]!.body).toEqual({ actionId: ACTION });
  });

  it('E678 R-STAFF-1: while GET /gbp/status says not cleared, the reviews are never requested and no reply card shows', async () => {
    const fake = world({ gbp: 'not_cleared', reviews: [review()] });
    open(fake);
    expect(await screen.findByText('Nothing to approve', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(fake.callsTo('GET /gbp/reviews?filter=needs_reply')).toHaveLength(0);
    expect(mainText()).not.toMatch(RAW);
  });

  it('R-STAFF-2: only reviews waiting with a draft are cards', async () => {
    open(world({ reviews: [review({ id: '01900000-0000-7000-8000-0000000ab002', state: 'needs_reply', stateLabel: 'Needs a reply', draft: null, reviewerDisplay: 'Sam P.' }), review()] }));
    expect(await screen.findByRole('article', { name: 'Review from Robin Q.' })).toBeInTheDocument();
    expect(screen.queryByText('Review from Sam P.')).toBeNull();
  });
});

describe('contract extraction pointers', () => {
  it('R-STAFF-2 E674: each open extraction is a pointer whose only action is "Review dates"; no /assistant request', async () => {
    const fake = world({ extractions: [extraction(), extraction({ documentId: '01900000-0000-7000-8000-0000000ab0d3', displayName: 'Scan.pdf', outcome: 'no_text' })] });
    open(fake, 'tc');
    const a = await screen.findByRole('article', { name: 'Purchase agreement.pdf' });
    expect(within(a).getByRole('link', { name: 'Review dates' })).toHaveAttribute('href', `/documents/${DOC}/dates`);
    expect(within(a).queryByRole('button')).toBeNull();
    expect(within(a).getByText(/Version 2/)).toBeInTheDocument();
    expect(screen.getByText('No text found in this PDF; enter the dates by hand.')).toBeInTheDocument();
    await settle();
    expect(fake.calls.filter((x) => x.path.startsWith('/assistant') && x.path !== '/assistant/inbox')).toEqual([]);
    expect(mainText()).not.toMatch(RAW);
  });

  it('R-STAFF-2 E674: a contract_extraction arriving as an assistant card renders as a pointer, never with Approve, Got it or Dismiss', async () => {
    const x = draftAction({
      id: '01900000-0000-7000-8000-0000000ab0f1', kind: 'contract_extraction', category: 'contract', contactId: null, contactName: null, primaryAction: 'acknowledge', draft: null,
      explanation: 'Dates found in this contract. Confirm each one; nothing is added to the timeline until you do.',
      claims: [{ id: IDS.claim, kind: 'date_time', text: 'Closing: 2027-02-12 (page 3)', needsReview: false, reviewStatus: 'unreviewed', due: null, evidence: [{ sourceType: 'document', sourceId: DOC, locator: { kind: 'char_range', start: 0, end: 5 }, snippet: 'Closing Date', verified: true, sourceAvailable: true, label: '“Closing Date” in the document' } as never] }],
    });
    const fake = world({ items: [x] });
    open(fake, 'agent');
    const card = await screen.findByRole('article', { name: 'Contract dates to review' });
    expect(within(card).getByRole('link', { name: 'Review dates' })).toHaveAttribute('href', `/documents/${DOC}/dates`);
    expect(within(card).queryByRole('button')).toBeNull();
    expect(screen.queryByRole('button', { name: /Approve|Got it|Dismiss/ })).toBeNull();
    await settle();
    expect(fake.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('E674: EXTRACTION_USE_DOCUMENT from a stale generic Dismiss is said in words with a link to its document', async () => {
    const fake = world({ items: [draftAction({ kind: 'call_summary', primaryAction: 'acknowledge', draft: null })] }).on(`POST /assistant/actions/${IDS.draft}/reject`, staffError('EXTRACTION_USE_DOCUMENT', { documentId: DOC }));
    open(fake, 'agent');
    await user().click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(await screen.findByText('A contract’s dates are confirmed or rejected one at a time on the document, not here.')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Review dates' }).some((l) => l.getAttribute('href') === `/documents/${DOC}/dates`)).toBe(true);
    expect(mainText()).not.toMatch(RAW);
  });

  it('R-STAFF-2: module 55 adds no branch for other kinds: an unknown kind keeps the generic card', async () => {
    open(world({ items: [draftAction({ kind: 'ai_isa_something_new', primaryAction: 'acknowledge', draft: null })] }), 'agent');
    expect(await screen.findByText('From the assistant', { exact: false })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Got it' })).toBeInTheDocument());
  });
});
