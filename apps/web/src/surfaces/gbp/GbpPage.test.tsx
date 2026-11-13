// The Google Business Profile page in jsdom on the staff contract (module 55 item 12; module 53's API). StaffFake checks
// every request body (strict: no commandId) and every scripted answer against the API's schemas.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { renderApp, sessionFixture, tableWith } from '../../shell/testing/fakeApi.js';
import { StaffFake, staffError } from '../../test/staffContract.js';
import { surface } from './index.js';
import type { GbpStatusView, ReviewView, ReviewsView } from './types.js';
import { GBP_ERROR_MESSAGES, GUARD_WORDS, REPLY_UNKNOWN } from './words.js';

type Role = 'owner' | 'admin' | 'team_lead' | 'agent' | 'isa' | 'tc';
const RAW = /\b[A-Z]{2,}_[A-Z_]+\b|platform:[a-z_]+|\(N\d+\)|\d{4}-\d\d-\d\dT/;
const LOC1 = '01900000-0000-7000-8000-00000000a001';
const LOC2 = '01900000-0000-7000-8000-00000000a002';
const R1 = '01900000-0000-7000-8000-00000000b001';
const R2 = '01900000-0000-7000-8000-00000000b002';
const R3 = '01900000-0000-7000-8000-00000000b003';
const ACT = '01900000-0000-7000-8000-00000000c001';
const ACT2 = '01900000-0000-7000-8000-00000000c002';
const user = () => userEvent.setup();

// apps/api/src/gbp/sync.test.ts:59
const NOT_CLEARED = 'Google Business Profile stays off until counsel reviews it (pack platform:gbp 2026.11.0). Nothing is read from or posted to Google.';

const connected = (over: Partial<GbpStatusView> = {}): { status: GbpStatusView } => ({
  status: {
    state: 'connected',
    sentence: '2 Business Profile locations are connected.',
    locations: [
      { connectionId: LOC1, displayName: 'Harbor Office', sentence: 'Reviews last checked Nov 12, 9:05 AM' },
      // apps/api/src/gbp/sync.test.ts:177
      { connectionId: LOC2, displayName: 'Bayside Office', sentence: 'Last check failed (LIST_TIMEOUT); we will try again.' },
    ],
    ...over,
  },
});

function review(over: Partial<ReviewView> = {}): ReviewView {
  return {
    id: R1,
    connectionId: LOC1,
    rating: 4,
    body: 'Quick answers and a calm closing week.',
    reviewerDisplay: 'Morgan P.',
    reviewedAt: '2026-11-10T15:00:00.000Z',
    state: 'needs_reply',
    stateLabel: 'Needs a reply',
    draft: null,
    ...over,
  };
}

const drafted = (over: Partial<ReviewView> = {}) =>
  review({ state: 'draft_waiting', stateLabel: 'Draft waiting', draft: { actionId: ACT, text: 'Thank you for the kind words!', guard: [], byAssistant: true }, ...over });

const list = (reviews: ReviewView[], sentence = `${reviews.length} review${reviews.length === 1 ? '' : 's'}.`): { reviews: ReviewsView } => ({ reviews: { state: 'ready', sentence, reviews } });

function app(fake: StaffFake, role: Role = 'owner', path = '/gbp') {
  const s = sessionFixture();
  const tenant = { ...s.tenant!, role };
  fake.on('GET /auth/session', { status: 200, body: { ...s, tenant, tenants: [tenant], reauthenticatedAt: new Date().toISOString() } });
  return renderApp({ fake, path, table: tableWith(surface) });
}

const NEEDS = 'GET /gbp/reviews?filter=needs_reply';
const ALL = 'GET /gbp/reviews?filter=all';
const replyRoutes = (fake: StaffFake) => fake.calls.filter((c) => /^\/gbp\/reviews\/[^/]+\/(draft|reply|discard)$/.test(c.path));
const reviewCalls = (fake: StaffFake) => fake.calls.filter((c) => c.path.startsWith('/gbp/reviews'));
const card = async (id = R1) => {
  await screen.findAllByRole('article');
  return document.getElementById(`review-${id}`) as HTMLElement;
};

describe('GBP page: dark and status (R-STAFF-1)', () => {
  it('R-STAFF-1 E678: while platform:gbp is not cleared the page shows the sentence without the pack key, requests no reviews and has no reply control', async () => {
    const fake = new StaffFake().on('GET /gbp/status', { status: 200, body: { status: { state: 'not_cleared', sentence: NOT_CLEARED, locations: [] } } });
    app(fake);
    expect(await screen.findByText('Google Business Profile stays off until counsel reviews it. Nothing is read from or posted to Google.')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(reviewCalls(fake)).toHaveLength(0);
    expect(screen.queryByRole('heading', { name: 'Reviews' })).toBeNull();
    expect(screen.queryByRole('button', { name: /reply|draft/i })).toBeNull();
    expect(screen.getByRole('main').textContent).not.toMatch(RAW);
    expect(screen.getByRole('main').textContent).not.toMatch(/2026\.11\.0/);
  });

  it('R-STAFF-1: not set up: the API sentence, and stored reviews still read', async () => {
    const fake = new StaffFake()
      .on('GET /gbp/status', { status: 200, body: { status: { state: 'not_set_up', sentence: 'Google Business Profile is not set up on this platform yet. Export posts and copy them to your Business Profile yourself.', locations: [] } } })
      .on(NEEDS, { status: 200, body: list([review()]) });
    app(fake);
    expect(await screen.findByText(/is not set up on this platform yet/)).toBeInTheDocument();
    expect(await screen.findByText('Quick answers and a calm closing week.')).toBeInTheDocument();
    // one location or none: no location filter
    expect(screen.queryByLabelText('Location')).toBeNull();
  });

  it('R-STAFF-1: not connected: the sentence and the empty list in the API words', async () => {
    const fake = new StaffFake()
      .on('GET /gbp/status', { status: 200, body: { status: { state: 'not_connected', sentence: 'No Business Profile location is connected.', locations: [] } } })
      .on(NEEDS, { status: 200, body: list([], 'No review needs a reply.') });
    app(fake);
    expect(await screen.findByText('No Business Profile location is connected.')).toBeInTheDocument();
    expect(await screen.findByText('No review needs a reply.')).toBeInTheDocument();
  });

  it('R-STAFF-1: connected: each location with its sentence, an error code taken out; reviews say "not cleared" when the API does', async () => {
    const fake = new StaffFake().on('GET /gbp/status', { status: 200, body: connected() }).on(NEEDS, { status: 200, body: { reviews: { state: 'not_cleared', sentence: NOT_CLEARED, reviews: [] } } });
    app(fake);
    const locs = await screen.findByRole('list', { name: 'Locations' });
    expect(within(locs).getByText(/Last check failed; we will try again\./)).toBeInTheDocument();
    expect(within(locs).getByText(/Reviews last checked Nov 12/)).toBeInTheDocument();
    expect(await screen.findByText(/stays off until counsel reviews it\. Nothing is read/)).toBeInTheDocument();
    expect(screen.getByRole('main').textContent).not.toMatch(RAW);
  });
});

describe('GBP page: reviews (R-STAFF-3, R-STAFF-5)', () => {
  it('R-STAFF-3 R-STAFF-5: stars as "n of 5", text as React text, "No text", the reviewer, date, state, "Showing up to 200", ids review-{id}; axe clean', async () => {
    const evil = '<img src=x onerror=alert(1)> great team';
    const fake = new StaffFake()
      .on('GET /gbp/status', { status: 200, body: connected() })
      .on(NEEDS, {
        status: 200,
        body: list([
          review({ body: evil, rating: 5 }),
          review({ id: R2, connectionId: LOC2, body: null, rating: 1, reviewerDisplay: null }),
          review({ id: R3, rating: null, body: null, reviewerDisplay: null, state: 'removed', stateLabel: 'Removed at Google' }),
        ]),
      });
    app(fake);
    const a = await card(R1);
    expect(within(a).getByText(evil)).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    expect(within(a).getByText(/5 of 5 stars/)).toBeInTheDocument();
    expect(within(a).getByRole('heading', { name: 'Morgan P.' })).toBeInTheDocument();
    expect(within(a).getByText(/Nov 10, 2026/)).toBeInTheDocument();
    expect(within(a).getByText('Needs a reply')).toBeInTheDocument();
    const b = document.getElementById(`review-${R2}`)!;
    expect(within(b).getByText('No text')).toBeInTheDocument();
    expect(within(b).getByText(/1 of 5 stars/)).toBeInTheDocument();
    expect(within(b).getByText(/Bayside Office/)).toBeInTheDocument();
    expect(within(b).getByRole('heading', { name: 'A Google reviewer' })).toBeInTheDocument();
    const c = document.getElementById(`review-${R3}`)!;
    expect(within(c).getByText(/No star rating/)).toBeInTheDocument();
    expect(within(c).getByText('Removed at Google')).toBeInTheDocument();
    expect(within(c).queryByRole('button')).toBeNull();
    expect(screen.getByText(/Showing up to 200/)).toBeInTheDocument();
    const main = screen.getByRole('main').textContent ?? '';
    expect(main).not.toMatch(RAW);
    expect(main).not.toMatch(/\d+\s?%|score|confiden|probab|rank|grade|points/i);
    // every star figure carries its denominator
    expect(main.match(/\d of 5 stars/g)).toHaveLength(2);
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });

  it('the needs-reply/all filter and the location filter ask the API with filter and connectionId', async () => {
    const fake = new StaffFake()
      .on('GET /gbp/status', { status: 200, body: connected() })
      .on(NEEDS, { status: 200, body: list([review()]) })
      .on(ALL, { status: 200, body: list([review(), review({ id: R2, state: 'replied', stateLabel: 'Replied' })]) })
      .on(`GET /gbp/reviews?filter=all&connectionId=${LOC2}`, { status: 200, body: list([], 'No reviews yet.') });
    app(fake);
    await card(R1);
    expect(screen.getByRole('button', { name: 'Needs a reply' })).toHaveAttribute('aria-pressed', 'true');
    await user().click(screen.getByRole('button', { name: 'All reviews' }));
    expect(await screen.findByText('Replied')).toBeInTheDocument();
    await user().selectOptions(screen.getByLabelText('Location'), LOC2);
    expect(await screen.findByText('No reviews yet.')).toBeInTheDocument();
    expect(fake.callsTo(`GET /gbp/reviews?filter=all&connectionId=${LOC2}`)).toHaveLength(1);
  });

  it('Approvals links to /gbp#review-{id}: that review is brought into view and focused', async () => {
    const fake = new StaffFake().on('GET /gbp/status', { status: 200, body: connected() }).on(NEEDS, { status: 200, body: list([review(), drafted({ id: R2 })]) });
    app(fake, 'owner', `/gbp#review-${R2}`);
    await card(R2);
    await waitFor(() => expect(document.activeElement?.id).toBe(`review-${R2}`));
  });
});

describe('GBP page: replies (R-STAFF-2, R-STAFF-4, R-STAFF-6)', () => {
  it('R-STAFF-2 R-STAFF-4: Post reply on a drafted review is ONE tap: {actionId, text} with no commandId, and the API sentence shown without a code', async () => {
    const fake = new StaffFake()
      .on('GET /gbp/status', { status: 200, body: connected() })
      .on(NEEDS, { status: 200, body: list([drafted()]) })
      .on(`POST /gbp/reviews/${R1}/reply`, { status: 200, body: { review: review({ state: 'replied', stateLabel: 'Replied' }), outcome: 'replied', sentence: 'Replied on Google' } });
    app(fake, 'admin');
    const a = await card();
    expect(within(a).getByLabelText(/Reply drafted by the assistant/)).toHaveValue('Thank you for the kind words!');
    await user().click(within(a).getByRole('button', { name: 'Post reply' }));
    expect((await screen.findAllByText('Replied on Google')).length).toBeGreaterThan(0);
    expect(fake.callsTo(`POST /gbp/reviews/${R1}/reply`).map((c) => c.body)).toEqual([{ actionId: ACT, text: 'Thank you for the kind words!' }]);
  });

  it('R-STAFF-4: an edited draft posts the edited text; a "failed" outcome shows the API sentence without its code', async () => {
    const fake = new StaffFake()
      .on('GET /gbp/status', { status: 200, body: connected() })
      .on(NEEDS, { status: 200, body: list([drafted()]) })
      // apps/api/src/gbp/replies.test.ts:174
      .on(`POST /gbp/reviews/${R1}/reply`, { status: 200, body: { review: drafted(), outcome: 'failed', sentence: 'Google did not take the reply (REPLY_REJECTED). Edit it or try again.' } });
    app(fake);
    const a = await card();
    const box = within(a).getByLabelText(/Reply drafted by the assistant/);
    await user().clear(box);
    await user().type(box, 'Thanks for choosing us.');
    await user().click(within(a).getByRole('button', { name: 'Post reply' }));
    expect((await screen.findAllByText('Google did not take the reply. Edit it or try again.')).length).toBeGreaterThan(0);
    expect(fake.callsTo(`POST /gbp/reviews/${R1}/reply`)[0]!.body).toEqual({ actionId: ACT, text: 'Thanks for choosing us.' });
    expect(screen.getByRole('main').textContent).not.toMatch(RAW);
  });

  it('R-STAFF-2: "Draft with the assistant" sends {mode: assistant} and the draft can then be posted', async () => {
    let n = 0;
    const fake = new StaffFake()
      .on('GET /gbp/status', { status: 200, body: connected() })
      .on(NEEDS, () => ({ status: 200, body: list([n === 0 ? review() : drafted()]) }))
      .on(`POST /gbp/reviews/${R1}/draft`, () => {
        n += 1;
        return { status: 200, body: { review: drafted() } };
      })
      .on(`POST /gbp/reviews/${R2}/draft`, { status: 200, body: { review: drafted({ id: R2 }) } });
    app(fake);
    const a = await card();
    await user().click(within(a).getByRole('button', { name: 'Draft with the assistant' }));
    await waitFor(() => expect(fake.callsTo(`POST /gbp/reviews/${R1}/draft`)).toHaveLength(1));
    expect(fake.callsTo(`POST /gbp/reviews/${R1}/draft`)[0]!.body).toEqual({ mode: 'assistant' });
    expect((await screen.findAllByText(/Draft saved/)).length).toBeGreaterThan(0);
    expect(await within(await card()).findByRole('button', { name: 'Post reply' })).toBeEnabled();
  });

  it('R-STAFF-2: writing a reply by hand saves it as a manual draft', async () => {
    const fake = new StaffFake()
      .on('GET /gbp/status', { status: 200, body: connected() })
      .on(NEEDS, { status: 200, body: list([review()]) })
      .on(`POST /gbp/reviews/${R1}/draft`, { status: 200, body: { review: drafted({ draft: { actionId: ACT, text: 'Thank you!', guard: [], byAssistant: false } }) } });
    app(fake);
    const a = await card();
    await user().click(within(a).getByRole('button', { name: 'Write a reply' }));
    expect(within(a).getByRole('button', { name: 'Save draft' })).toBeDisabled();
    await user().type(within(a).getByLabelText('Your reply'), '  Thank you!  ');
    await user().click(within(a).getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(fake.callsTo(`POST /gbp/reviews/${R1}/draft`)).toHaveLength(1));
    expect(fake.callsTo(`POST /gbp/reviews/${R1}/draft`)[0]!.body).toEqual({ mode: 'manual', text: 'Thank you!' });
  });

  it('R-STAFF-2: Discard sends {actionId} only', async () => {
    const fake = new StaffFake()
      .on('GET /gbp/status', { status: 200, body: connected() })
      .on(NEEDS, { status: 200, body: list([drafted()]) })
      .on(`POST /gbp/reviews/${R1}/discard`, { status: 200, body: { review: review() } });
    app(fake);
    await user().click(within(await card()).getByRole('button', { name: 'Discard' }));
    expect((await screen.findAllByText('Draft discarded. Nothing was posted.')).length).toBeGreaterThan(0);
    expect(fake.callsTo(`POST /gbp/reviews/${R1}/discard`).map((c) => c.body)).toEqual([{ actionId: ACT }]);
  });

  it('R-STAFF-6: an agent, Team Lead, ISA or TC reads reviews only: "Only an Owner or Admin can reply.", no reply control, no draft/reply/discard request', async () => {
    for (const role of ['agent', 'team_lead', 'isa', 'tc'] as const) {
      const fake = new StaffFake().on('GET /gbp/status', { status: 200, body: connected() }).on(NEEDS, { status: 200, body: list([review(), review({ id: R2, state: 'draft_waiting', stateLabel: 'Draft waiting' })]) });
      const { view } = app(fake, role);
      await card(R2);
      expect(screen.getByText('Only an Owner or Admin can reply.'), role).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Post reply|Draft|Write a reply|Discard/ }), role).toBeNull();
      expect(screen.queryByRole('textbox'), role).toBeNull();
      expect(replyRoutes(fake), role).toHaveLength(0);
      view.unmount();
    }
  });

  it('R-STAFF-4: after a 502 the reply is not re-sent by itself; each tap is one request; the words never say it failed', async () => {
    const fake = new StaffFake()
      .on('GET /gbp/status', { status: 200, body: connected() })
      .on(NEEDS, { status: 200, body: list([drafted()]) })
      .on(`POST /gbp/reviews/${R1}/reply`, { status: 502, body: { error: { code: 'INTERNAL_ERROR', requestId: 'r' } } });
    app(fake);
    const a = await card();
    await user().click(within(a).getByRole('button', { name: 'Post reply' }));
    expect(await screen.findByText(REPLY_UNKNOWN)).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.callsTo(`POST /gbp/reviews/${R1}/reply`)).toHaveLength(1);
    await user().click(within(await card()).getByRole('button', { name: 'Post reply' }));
    await waitFor(() => expect(fake.callsTo(`POST /gbp/reviews/${R1}/reply`)).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.callsTo(`POST /gbp/reviews/${R1}/reply`)).toHaveLength(2);
  });

  it('E663 R-STAFF-2: REPLY_PRIVACY: each code in words with the words found; Post stays off until the text is edited; nothing else sent', async () => {
    const text = 'Thanks Morgan! Enjoy the new place.';
    const fake = new StaffFake()
      .on('GET /gbp/status', { status: 200, body: connected() })
      .on(NEEDS, { status: 200, body: list([drafted({ draft: { actionId: ACT, text, guard: [], byAssistant: false } })]) })
      .on(`POST /gbp/reviews/${R1}/reply`, staffError('REPLY_PRIVACY', { codes: ['REVIEWER_NAME'], spans: [{ code: 'REVIEWER_NAME', start: 7, end: 13 }] }));
    app(fake);
    const a = await card();
    await user().click(within(a).getByRole('button', { name: 'Post reply' }));
    expect(await within(a).findByText(GBP_ERROR_MESSAGES.REPLY_PRIVACY!)).toBeInTheDocument();
    expect(within(a).getByText(`${GUARD_WORDS.REVIEWER_NAME} (“Morgan”)`)).toBeInTheDocument();
    const post = within(a).getByRole('button', { name: 'Post reply' });
    expect(post).toBeDisabled();
    await user().type(within(a).getByLabelText(/Your reply/), ' See you');
    expect(post).toBeEnabled();
    expect(fake.callsTo(`POST /gbp/reviews/${R1}/reply`)).toHaveLength(1);
    expect(screen.getByRole('main').textContent).not.toMatch(RAW);
  });

  it('E663: a stored draft the checks flagged says why and cannot be posted until edited', async () => {
    const fake = new StaffFake().on('GET /gbp/status', { status: 200, body: connected() }).on(NEEDS, { status: 200, body: list([drafted({ draft: { actionId: ACT, text: 'Call me at the office', guard: ['CONTACT'], byAssistant: false } })]) });
    app(fake);
    const a = await card();
    expect(within(a).getByText(GUARD_WORDS.CONTACT)).toBeInTheDocument();
    expect(within(a).getByRole('button', { name: 'Post reply' })).toBeDisabled();
    await user().type(within(a).getByLabelText(/Your reply/), '!');
    expect(within(a).getByRole('button', { name: 'Post reply' })).toBeEnabled();
  });

  it('E663: REPLY_STALE keeps Post off even after an edit, until the reply is drafted again', async () => {
    let drafts = 0;
    const fake = new StaffFake()
      .on('GET /gbp/status', { status: 200, body: connected() })
      .on(NEEDS, () => ({ status: 200, body: list([drafts === 0 ? drafted() : drafted({ draft: { actionId: ACT2, text: 'A fresh thank you.', guard: [], byAssistant: true } })]) }))
      .on(`POST /gbp/reviews/${R1}/reply`, staffError('REPLY_STALE'))
      .on(`POST /gbp/reviews/${R1}/draft`, () => {
        drafts += 1;
        return { status: 200, body: { review: drafted({ draft: { actionId: ACT2, text: 'A fresh thank you.', guard: [], byAssistant: true } }) } };
      });
    app(fake);
    const a = await card();
    await user().click(within(a).getByRole('button', { name: 'Post reply' }));
    expect(await within(a).findByText(GBP_ERROR_MESSAGES.REPLY_STALE!)).toBeInTheDocument();
    await user().type(within(a).getByLabelText(/Reply drafted/), ' Thanks again');
    expect(within(a).getByRole('button', { name: 'Post reply' })).toBeDisabled();
    await user().click(within(a).getByRole('button', { name: 'Draft again with the assistant' }));
    await waitFor(() => expect(within(document.getElementById(`review-${R1}`)!).getByLabelText(/Reply drafted/)).toHaveValue('A fresh thank you.'));
    expect(within(document.getElementById(`review-${R1}`)!).getByRole('button', { name: 'Post reply' })).toBeEnabled();
  });

  it('E663: PLATFORM_NOT_CLEARED (fair housing), CHANNEL_NOT_CONNECTED, GBP_NOT_CONFIGURED, GBP_NOT_CLEARED and REPLY_IN_PROGRESS each in words; nothing posted', async () => {
    const cases: [ReturnType<typeof staffError>, string][] = [
      [staffError('PLATFORM_NOT_CLEARED', { pack: 'platform:fair_housing' }), "Replies wait for counsel's review of Publishing marketing (fair-housing rules). Nothing was posted."],
      [staffError('CHANNEL_NOT_CONNECTED'), GBP_ERROR_MESSAGES.CHANNEL_NOT_CONNECTED!],
      [staffError('GBP_NOT_CONFIGURED'), GBP_ERROR_MESSAGES.GBP_NOT_CONFIGURED!],
      [staffError('GBP_NOT_CLEARED'), GBP_ERROR_MESSAGES.GBP_NOT_CLEARED!],
      [staffError('REPLY_IN_PROGRESS'), GBP_ERROR_MESSAGES.REPLY_IN_PROGRESS!],
    ];
    for (const [reply, words] of cases) {
      const fake = new StaffFake().on('GET /gbp/status', { status: 200, body: connected() }).on(NEEDS, { status: 200, body: list([drafted()]) }).on(`POST /gbp/reviews/${R1}/reply`, reply);
      const { view } = app(fake);
      const a = await card();
      await user().click(within(a).getByRole('button', { name: 'Post reply' }));
      expect(await within(a).findByText(words)).toBeInTheDocument();
      expect(within(a).getByRole('button', { name: 'Post reply' })).toBeDisabled();
      expect(screen.getByRole('main').textContent).not.toMatch(RAW);
      expect(fake.callsTo(`POST /gbp/reviews/${R1}/reply`)).toHaveLength(1);
      view.unmount();
    }
  });

  it('E663: ASSISTANT_UNAVAILABLE on a draft says why in words; nothing is drafted', async () => {
    const fake = new StaffFake()
      .on('GET /gbp/status', { status: 200, body: connected() })
      .on(NEEDS, { status: 200, body: list([review()]) })
      .on(`POST /gbp/reviews/${R1}/draft`, staffError('ASSISTANT_UNAVAILABLE', { reason: 'AI_OFF' }));
    app(fake);
    const a = await card();
    await user().click(within(a).getByRole('button', { name: 'Draft with the assistant' }));
    expect(await within(a).findByText('The assistant is turned off for your team. Write a reply yourself.')).toBeInTheDocument();
    expect(within(a).queryByRole('button', { name: 'Post reply' })).toBeNull();
    expect(screen.getByRole('main').textContent).not.toMatch(RAW);
  });

  it('R-STAFF-4: a reply being posted or checked has no controls', async () => {
    const fake = new StaffFake()
      .on('GET /gbp/status', { status: 200, body: connected() })
      .on(NEEDS, { status: 200, body: list([drafted({ state: 'posting', stateLabel: 'Posting…' }), drafted({ id: R2, state: 'checking', stateLabel: 'Checking with Google' })]) });
    app(fake);
    await card(R2);
    expect(screen.getByText('Checking with Google')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Post reply|Discard|Draft/ })).toBeNull();
  });
});
