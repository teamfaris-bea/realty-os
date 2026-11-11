// The marketing tab and the marketing approval card in jsdom (module 38): one tap approves exactly the
// version shown (its contentSha256), a draft the checks refuse has no Approve button and says why, Copy
// exports first so the label is the server's "Exported: post it yourself", and "Posted" appears only for
// a publication whose server-side posted flag is true.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeFetch, renderApp, sessionFixture, tableWith } from '../../shell/testing/fakeApi.js';
import { AGENT_SURFACES } from '../feed/lib/testing.js';
import { surface as marketingSurface } from './index.js';
import type { ListingMarketingView, PieceView, PublicationView } from './types.js';

const LISTING = '01900000-0000-7000-8000-0000000115a1';
const PAGE = '01900000-0000-7000-8000-0000000c0001';
const SHA = 'a'.repeat(64);
const user = () => userEvent.setup();

let n = 0;
function piece(over: Partial<PieceView> = {}): PieceView {
  n += 1;
  return {
    id: `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`,
    listingId: LISTING,
    kind: 'social_post',
    versionNo: 1,
    status: 'draft',
    statusLabel: 'Draft: not approved yet',
    prose: {},
    contentSha256: SHA,
    preview: {
      text: 'A bright home near the water.',
      blocks: [
        { role: 'caption', origin: 'prose', prominence: 'body', text: 'A bright home near the water.' },
        { role: 'address', origin: 'bound', prominence: 'body', text: '12 Harbor View Rd, Charleston, SC 29401' },
        { role: 'brokerage_name', origin: 'identity', prominence: 'body', text: 'Harbor Realty LLC' },
      ],
    },
    assets: [],
    guard: { approvable: true, reasons: [], checkThis: false, soft: [] },
    publicPath: null,
    publications: [],
    publishOptions: [],
    earlierPostNotice: null,
    exportable: false,
    invitable: false,
    ...over,
  };
}

function pub(over: Partial<PublicationView> = {}): PublicationView {
  return { id: '01900000-0000-7000-8000-0000000b0001', connectionId: PAGE, targetKind: 'facebook_page', targetName: 'Harbor Page', status: 'published', posted: true, label: 'Posted to your Facebook Page', ...over };
}

function marketing(pieces: PieceView[], over: Partial<ListingMarketingView> = {}): ListingMarketingView {
  return { pieces, targets: [{ id: PAGE, kind: 'facebook_page', status: 'connected', displayName: 'Harbor Page' }], publishingCleared: true, fairHousingReviewSentence: 'The fair-housing pack was reviewed by counsel; publishing to connected accounts is on.', ...over };
}

function app(fake: FakeFetch, path = `/listings/${LISTING}/marketing`) {
  const s = sessionFixture();
  fake.on('GET /auth/session', { status: 200, body: s });
  fake.on(`GET /listings/${LISTING}`, { status: 200, body: { listing: { id: LISTING, addressLine1: '12 Harbor View Rd', city: 'Charleston', editable: true } } });
  return renderApp({ fake, path, table: tableWith(...AGENT_SURFACES, marketingSurface) });
}

const onPage = (m: ListingMarketingView) => new FakeFetch().on(`GET /listings/${LISTING}/marketing`, { status: 200, body: m });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Marketing tab', () => {
  it('approving is ONE tap and sends the contentSha256 of the version shown', async () => {
    const p = piece();
    const fake = onPage(marketing([p])).on(`POST /marketing-pieces/${p.id}/approve`, { status: 200, body: { piece: { ...p, status: 'approved' } } });
    app(fake);
    await user().click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(fake.callsTo(`POST /marketing-pieces/${p.id}/approve`)).toHaveLength(1));
    expect(fake.callsTo(`POST /marketing-pieces/${p.id}/approve`)[0]!.body).toEqual({ contentSha256: SHA });
  });

  it('R-FH-1: a draft the checks refuse shows the reasons in words and no Approve button; soft matches say "Check this", never a score', async () => {
    const p = piece({ guard: { approvable: false, reasons: ['"perfect for young families" describes who should live here. Describe the home instead.'], checkThis: true, soft: ['walking distance'] } });
    app(onPage(marketing([p])));
    expect(await screen.findByText(/perfect for young families/)).toBeInTheDocument();
    expect(screen.getByText('Fix this before it can be approved')).toBeInTheDocument();
    expect(screen.getByText('Check this')).toBeInTheDocument();
    expect(screen.getByText('walking distance')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(document.body.textContent).not.toMatch(/\d+\s?%|score|confiden/i);
  });

  it('HONESTY: "Posted" appears only for a publication the server marked posted; a lost answer shows the server words', async () => {
    const lying = pub({ id: '01900000-0000-7000-8000-0000000b0002', status: 'unknown', posted: false, label: 'Posted to your Facebook Page' });
    const unknown = pub({ id: '01900000-0000-7000-8000-0000000b0003', targetKind: 'instagram_business', targetName: 'Harbor Insta', status: 'unknown', posted: false, label: "Check your Instagram account: we didn't hear back whether it went up. We won't post it again" });
    const p = piece({ status: 'published', statusLabel: 'Posted: see each account below', publications: [lying, unknown] });
    app(onPage(marketing([p])));
    const list = await screen.findByRole('list', { name: 'Where it went' });
    expect(within(list).getByText(/we didn't hear back whether it went up/)).toBeInTheDocument();
    expect(within(list).getByText(/Check your Harbor Page/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\bposted\b/i);
  });

  it('a provider-confirmed publication shows its label, "Posted to your Facebook Page"', async () => {
    const p = piece({ status: 'published', statusLabel: 'Posted: see each account below', publications: [pub()] });
    app(onPage(marketing([p])));
    expect(await screen.findByText('Posted to your Facebook Page')).toBeInTheDocument();
  });

  it('Publish to <account> is offered only for a publish option and sends its connectionId; export options show the server sentence', async () => {
    const p = piece({
      status: 'approved',
      statusLabel: 'Approved: not shared anywhere yet',
      exportable: true,
      publishOptions: [
        { kind: 'publish', connectionId: PAGE, target: 'facebook_page', displayName: 'Harbor Page' },
        { kind: 'export', connectionId: '01900000-0000-7000-8000-0000000c0002', reason: 'NEEDS_IMAGE', sentence: 'Instagram needs at least one photo on the post. Add one in a new version, or export it.' },
      ],
    });
    const after = { ...p, status: 'published' as const, statusLabel: 'Posted: see each account below', publications: [pub()] };
    const fake = onPage(marketing([p])).on(`POST /marketing-pieces/${p.id}/publish`, { status: 200, body: { piece: after, publication: pub() } });
    app(fake);
    expect(await screen.findByText(/Instagram needs at least one photo/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Publish to Harbor Insta/ })).toBeNull();
    await user().click(screen.getByRole('button', { name: 'Publish to Harbor Page' }));
    await waitFor(() => expect(fake.callsTo(`POST /marketing-pieces/${p.id}/publish`)).toHaveLength(1));
    expect(fake.callsTo(`POST /marketing-pieces/${p.id}/publish`)[0]!.body).toEqual({ connectionId: PAGE });
    expect((await screen.findAllByText('Posted to your Facebook Page')).length).toBeGreaterThanOrEqual(1);
  });

  it('Copy exports first: the label is the server\'s "Exported: post it yourself" and the export text goes to the clipboard', async () => {
    const p = piece({ kind: 'marketplace_export', status: 'approved', statusLabel: 'Approved: not shared anywhere yet', exportable: true, publishOptions: [{ kind: 'export', connectionId: null, reason: 'NOT_SOCIAL', sentence: 'Only social posts publish to a Page or Instagram account.' }] });
    const fake = onPage(marketing([p])).on(`POST /marketing-pieces/${p.id}/export`, {
      status: 200,
      body: { piece: { ...p, status: 'exported', statusLabel: 'Exported: post it yourself' }, export: { text: 'Bright home. Harbor Realty LLC', label: 'Exported: post it yourself', flags: [], images: [], flyerUrl: null } },
    });
    app(fake);
    const u = user();
    await u.click(await screen.findByRole('button', { name: 'Copy' }));
    expect(await screen.findByText('Copied. Exported: post it yourself')).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toBe('Bright home. Harbor Realty LLC');
    expect(fake.callsTo(`POST /marketing-pieces/${p.id}/export`)).toHaveLength(1);
  });

  it('a draft is never copied or downloaded (nothing leaves unapproved)', async () => {
    app(onPage(marketing([piece({ kind: 'flyer' })])));
    await screen.findByRole('button', { name: 'Approve' });
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Download/ })).toBeNull();
  });

  it('the newest version of a kind comes first; older versions are collapsed under it', async () => {
    const v1 = piece({ versionNo: 1, status: 'superseded', statusLabel: 'Replaced by a newer version', guard: { approvable: false, reasons: [], checkThis: false, soft: [] } });
    const v2 = piece({ versionNo: 2 });
    app(onPage(marketing([v1, v2])));
    expect(await screen.findByText('Version 2')).toBeVisible();
    expect(screen.getByText(/Earlier versions of the social post \(1\)/)).toBeInTheDocument();
  });

  it('the listing page goes live with "Put the page live"; its public link shows only once it is published', async () => {
    const p = piece({ kind: 'website_page', status: 'approved', statusLabel: 'Approved: not shared anywhere yet', exportable: true, publicPath: null });
    const fake = onPage(marketing([p])).on(`POST /marketing-pieces/${p.id}/publish`, { status: 200, body: { piece: { ...p, status: 'published' }, publication: null } });
    app(fake);
    await user().click(await screen.findByRole('button', { name: 'Put the page live' }));
    await waitFor(() => expect(fake.callsTo(`POST /marketing-pieces/${p.id}/publish`)[0]?.body).toEqual({}));
    expect(screen.queryByText(/The page is live at/)).toBeNull();
  });

  it('when counsel has not reviewed the fair-housing pack, the server sentence is shown and the page cannot go live', async () => {
    const p = piece({ kind: 'website_page', status: 'approved', statusLabel: 'Approved: not shared anywhere yet', exportable: true });
    app(onPage(marketing([p], { publishingCleared: false, fairHousingReviewSentence: 'Not reviewed by counsel yet: publishing to Facebook and Instagram stays off, and pieces are exported for you to post yourself.' })));
    expect(await screen.findByText(/Not reviewed by counsel yet/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Put the page live' })).toBeNull();
  });

  it('a listing without marketing offers "Make marketing" (generate, every kind)', async () => {
    const fake = onPage(marketing([])).on(`POST /listings/${LISTING}/marketing/generate`, { status: 200, body: { pieces: [] } });
    app(fake);
    await user().click(await screen.findByRole('button', { name: 'Make marketing' }));
    await waitFor(() => expect(fake.callsTo(`POST /listings/${LISTING}/marketing/generate`)[0]?.body).toEqual({}));
  });

  it('has no axe violations', async () => {
    app(onPage(marketing([piece({ guard: { approvable: false, reasons: ['Add the brokerage licence number in Settings.'], checkThis: true, soft: ['walking distance'] } }), piece({ kind: 'flyer', status: 'approved', exportable: true })])));
    await screen.findAllByRole('article');
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((x) => x.target.join(' ')).join(', ')}`)).toEqual([]);
  });
});

describe('Marketing approval card (approvals inbox)', () => {
  const inbox = (pieces: PieceView[]) => new FakeFetch().on('GET /assistant/inbox', { status: 200, body: { items: [] } }).on('GET /marketing/approvals', { status: 200, body: { pieces } });

  it('shows even when the assistant inbox is empty; approving is ONE tap with the contentSha256', async () => {
    const p = piece({ kind: 'website_page', preview: { text: '', blocks: [{ role: 'headline', origin: 'prose', prominence: 'display', text: 'Room to grow' }, { role: 'address', origin: 'bound', prominence: 'heading', text: '12 Harbor View Rd, Charleston' }] } });
    const fake = inbox([p]).on(`POST /marketing-pieces/${p.id}/approve`, { status: 200, body: { piece: { ...p, status: 'approved' } } });
    app(fake, '/approvals');
    const card = (await screen.findByRole('heading', { name: '12 Harbor View Rd, Charleston' })).closest('article')!;
    expect(within(card).getAllByText('Room to grow')[0]).toBeVisible();
    expect(within(card).getByText(/Listing page/)).toBeInTheDocument();
    expect(screen.queryByText('Nothing to approve')).toBeNull();
    await user().click(within(card).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(fake.callsTo(`POST /marketing-pieces/${p.id}/approve`)).toHaveLength(1));
    expect(fake.callsTo(`POST /marketing-pieces/${p.id}/approve`)[0]!.body).toEqual({ contentSha256: SHA });
  });

  it('a draft that fails the checks shows why and has no Approve button', async () => {
    const p = piece({ guard: { approvable: false, reasons: ['The brokerage name must be on every piece.'], checkThis: false, soft: [] } });
    app(inbox([p]), '/approvals');
    expect(await screen.findByText('The brokerage name must be on every piece.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('with nothing of either kind, the inbox says "Nothing to approve"', async () => {
    app(inbox([]), '/approvals');
    expect(await screen.findByText('Nothing to approve')).toBeInTheDocument();
  });
});
