// "Make a Google post" on a listing's Marketing tab (module 55 item 12, owner question 8) and verify 10: a gbp_post
// piece renders in PieceCard with its preview blocks and the server's gbp_location publish option. The generate route
// is on the staff contract (StaffFake checks {kinds: ['gbp_post']} and the answer); the marketing reads are not.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { err, renderApp, sessionFixture, tableWith } from '../../shell/testing/fakeApi.js';
import { StaffFake } from '../../test/staffContract.js';
import { AGENT_SURFACES } from '../feed/lib/testing.js';
import { surface as marketingSurface } from '../marketing/index.js';
import type { ListingMarketingView, PieceView } from '../marketing/types.js';

const RAW = /\b[A-Z]{2,}_[A-Z_]+\b|platform:[a-z_]+|\(N\d+\)|\d{4}-\d\d-\d\dT/;
const LISTING = '01900000-0000-7000-8000-0000000115a1';
const LOC = '01900000-0000-7000-8000-00000000a001';
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
    contentSha256: 'a'.repeat(64),
    timezone: 'America/New_York',
    preview: { text: 'A bright home near the water.', blocks: [{ role: 'caption', origin: 'prose', prominence: 'body', text: 'A bright home near the water.' }] },
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

/** A piece exactly as the API's PieceSchema sends it (api/marketing/routes.ts), for the contract-checked generate answer. */
const apiPiece = (p: PieceView) => ({
  ...p,
  openHouse: null,
  templateKey: 'gbp_post_v1',
  boundFields: ['price', 'status', 'address'],
  guard: { ...p.guard, fairHousingReviewed: true },
  approvedAt: null,
  publishedAt: null,
  exportedAt: null,
  retractedAt: null,
});

const gbpPiece = (over: Partial<PieceView> = {}) =>
  piece({
    kind: 'gbp_post',
    preview: {
      text: 'A home in Charleston. Contact the team to set up a showing.',
      blocks: [
        { role: 'body', origin: 'prose', prominence: 'body', text: 'A home in Charleston. Contact the team to set up a showing.' },
        { role: 'address', origin: 'bound', prominence: 'small', text: '12 Harbor View Rd, Charleston, SC 29401' },
      ],
    },
    ...over,
  });

const marketing = (pieces: PieceView[], over: Partial<ListingMarketingView> = {}): ListingMarketingView => ({
  pieces,
  targets: [{ id: LOC, kind: 'gbp_location', status: 'connected', displayName: 'Harbor Office' }],
  publishingCleared: true,
  fairHousingReviewSentence: 'The fair-housing pack was reviewed by counsel; publishing to connected accounts is on.',
  ...over,
});

function app(fake: StaffFake, editable = true) {
  const s = sessionFixture();
  fake.on('GET /auth/session', { status: 200, body: s });
  fake.on(`GET /listings/${LISTING}`, { status: 200, body: { listing: { id: LISTING, addressLine1: '12 Harbor View Rd', city: 'Charleston', editable } } });
  return renderApp({ fake, path: `/listings/${LISTING}/marketing`, table: tableWith(...AGENT_SURFACES, marketingSurface) });
}

const GENERATE = `POST /listings/${LISTING}/marketing/generate`;

describe('Make a Google post (owner question 8)', () => {
  it('in the empty state, "Make a Google post" sends exactly {kinds: [gbp_post]}; "Make marketing" still sends {}', async () => {
    const made = gbpPiece();
    let generated = false;
    const fake = new StaffFake()
      .on(`GET /listings/${LISTING}/marketing`, () => ({ status: 200, body: marketing(generated ? [made] : []) }))
      .on(GENERATE, () => {
        generated = true;
        return { status: 200, body: { pieces: [apiPiece(made)] } };
      });
    app(fake);
    expect(await screen.findByRole('button', { name: 'Make marketing' })).toBeInTheDocument();
    await user().click(screen.getByRole('button', { name: 'Make a Google post' }));
    await waitFor(() => expect(fake.callsTo(GENERATE)).toHaveLength(1));
    expect(fake.callsTo(GENERATE)[0]!.body).toEqual({ kinds: ['gbp_post'] });
    expect(await screen.findByRole('heading', { name: 'Business Profile post' })).toBeInTheDocument();
    // a gbp_post piece exists now: no second button
    expect(screen.queryByRole('button', { name: 'Make a Google post' })).toBeNull();
  });

  it('with pieces but no Google post, the button shows above the pieces', async () => {
    const fake = new StaffFake().on(`GET /listings/${LISTING}/marketing`, { status: 200, body: marketing([piece()]) });
    app(fake);
    const btn = await screen.findByRole('button', { name: 'Make a Google post' });
    const firstCard = screen.getAllByRole('article')[0]!;
    // DOCUMENT_POSITION_FOLLOWING: the card comes after the button
    expect(btn.compareDocumentPosition(firstCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('with a Google post already made, or for someone who cannot edit the listing, there is no button', async () => {
    const fake = new StaffFake().on(`GET /listings/${LISTING}/marketing`, { status: 200, body: marketing([piece(), gbpPiece()]) });
    const { view } = app(fake);
    expect(await screen.findByRole('heading', { name: 'Business Profile post' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Make a Google post' })).toBeNull();
    view.unmount();
    const fake2 = new StaffFake().on(`GET /listings/${LISTING}/marketing`, { status: 200, body: marketing([]) });
    app(fake2, false);
    expect(await screen.findByText('The listing agent can make marketing for this listing.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Make a Google post' })).toBeNull();
  });
});

describe('verify 10: a Business Profile post in PieceCard', () => {
  it('R-STAFF-1: an approved gbp_post shows its preview blocks and "Publish to <location>" from the server option, sending its connectionId', async () => {
    const p = gbpPiece({ status: 'approved', statusLabel: 'Approved: not shared anywhere yet', exportable: true, publishOptions: [{ kind: 'publish', connectionId: LOC, target: 'gbp_location', displayName: 'Harbor Office' }] });
    const fake = new StaffFake()
      .on(`GET /listings/${LISTING}/marketing`, { status: 200, body: marketing([p]) })
      .on(`POST /marketing-pieces/${p.id}/publish`, {
        status: 200,
        body: { piece: { ...p, status: 'published', statusLabel: 'Posted: see each account below' }, publication: { id: '01900000-0000-7000-8000-0000000b0001', connectionId: LOC, targetKind: 'gbp_location', targetName: 'Harbor Office', status: 'published', posted: true, label: 'Posted to your Google Business Profile' } },
      });
    app(fake);
    const card = (await screen.findByRole('heading', { name: 'Business Profile post' })).closest('article') as HTMLElement;
    const preview = within(card).getByRole('group', { name: 'Business Profile post, version 1' });
    expect(within(preview).getByText('A home in Charleston. Contact the team to set up a showing.')).toBeInTheDocument();
    expect(within(preview).getByText('12 Harbor View Rd, Charleston, SC 29401')).toBeInTheDocument();
    // the server publishes this one: no "post it yourself" line
    expect(within(card).queryByText(/We don't post this for you/)).toBeNull();
    await user().click(within(card).getByRole('button', { name: 'Publish to Harbor Office' }));
    await waitFor(() => expect(fake.callsTo(`POST /marketing-pieces/${p.id}/publish`)).toHaveLength(1));
    expect(fake.callsTo(`POST /marketing-pieces/${p.id}/publish`)[0]!.body).toEqual({ connectionId: LOC });
  });

  it('R-STAFF-1: an export option (platform:gbp uncleared) shows the server sentence and no Publish; a refusal names Google Business Profile, not a pack key', async () => {
    const p = gbpPiece({
      status: 'approved',
      statusLabel: 'Approved: not shared anywhere yet',
      exportable: true,
      publishOptions: [{ kind: 'export', connectionId: LOC, reason: 'PLATFORM_NOT_CLEARED', sentence: 'Google Business Profile posts stay off until counsel reviews them. Export it and copy it to your Business Profile yourself.' }],
    });
    const fake = new StaffFake().on(`GET /listings/${LISTING}/marketing`, { status: 200, body: marketing([p]) });
    app(fake);
    const card = (await screen.findByRole('heading', { name: 'Business Profile post' })).closest('article') as HTMLElement;
    expect(within(card).getByText(/posts stay off until counsel reviews them/)).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /Publish to/ })).toBeNull();
    expect(screen.getByRole('main').textContent).not.toMatch(RAW);
  });

  it('a publish refused PLATFORM_NOT_CLEARED for platform:gbp says Google Business Profile', async () => {
    const p = gbpPiece({ status: 'approved', statusLabel: 'Approved: not shared anywhere yet', publishOptions: [{ kind: 'publish', connectionId: LOC, target: 'gbp_location', displayName: 'Harbor Office' }] });
    const fake = new StaffFake().on(`GET /listings/${LISTING}/marketing`, { status: 200, body: marketing([p]) }).on(`POST /marketing-pieces/${p.id}/publish`, err(409, 'PLATFORM_NOT_CLEARED', { pack: 'platform:gbp' }));
    app(fake);
    await user().click(await screen.findByRole('button', { name: 'Publish to Harbor Office' }));
    expect(await screen.findByText(/Google Business Profile posts stay off until counsel reviews them/)).toBeInTheDocument();
    expect(screen.getByRole('main').textContent).not.toMatch(RAW);
  });
});
