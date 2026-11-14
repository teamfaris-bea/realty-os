// module 46 (R-PORTALWEB-3, R-PORTALWEB-4, R-PORTALWEB-6, R-PORTALWEB-9; E700-E707, E711, E712, E719): the screens
// on a contract-checked fake of module 45.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_SENTENCES, COPY } from './copy.js';
import { resetLinkForTests, readLink } from './link.js';
import * as F from './test/fixtures.js';
import { portalApiError } from './test/portalContract.js';
import { CODE_IN_TEXT, renderPortal, signedIn, signedOutRoutes } from './test/render.js';
import { VIEW_WORDS } from './view/index.js';

beforeEach(() => resetLinkForTests());
afterEach(() => resetLinkForTests());

const live = () => screen.getByTestId('portal-live');
/** On screen, outside the live region (which repeats a sentence for screen readers). */
const IGN = { ignore: '[data-testid="portal-live"], script, style' };
const h1 = () => screen.getByRole('heading', { level: 1 });
const withToken = () => readLink({ pathname: '/portal.html', search: '', hash: `#token=${F.TOKEN}` }, { state: null, replaceState: () => undefined }, null);

describe('LinkLanding (R-PORTALWEB-3)', () => {
  it('E700, E685: nothing is posted on load, focus, visibility or pageshow; the Sign in tap posts the token once, even on a double tap', async () => {
    withToken();
    const r = renderPortal({ link: { link: 'token' }, routes: { ...signedIn, 'POST /portal/session': () => ({ status: 200, body: F.session() }) } });
    expect(h1()).toHaveTextContent('Sign in');
    expect(h1()).toHaveFocus();
    expect(screen.getByText(COPY.landingBody)).toBeInTheDocument();
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    await act(async () => undefined);
    expect(r.seen).toEqual([]);
    const button = screen.getByRole('button', { name: 'Sign in' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(await screen.findByRole('heading', { level: 1, name: 'Your home purchase' })).toBeInTheDocument();
    expect(r.keys().filter((k) => k === 'POST /portal/session')).toHaveLength(1);
    expect(r.seen.find((x) => x.key === 'POST /portal/session')!.body).toEqual({ token: F.TOKEN });
    expect(r.problems).toEqual([]);
  });

  it('E701: a used link says so, then /me decides: signed in opens home with the sentence announced', async () => {
    withToken();
    renderPortal({ link: { link: 'token' }, routes: { ...signedIn, 'POST /portal/session': () => portalApiError('PORTAL_LINK_INVALID') } });
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Your home purchase' })).toBeInTheDocument();
    await waitFor(() => expect(live()).toHaveTextContent(API_SENTENCES.PORTAL_LINK_INVALID));
  });

  it('E701: a used link while signed out shows the sentence and the form (with no team: the next test)', async () => {
    withToken();
    renderPortal({ link: { link: 'token' }, routes: { ...signedOutRoutes, 'POST /portal/session': () => portalApiError('PORTAL_LINK_INVALID') } });
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { level: 1, name: COPY.signInTitle })).toBeInTheDocument();
    expect(screen.getByText(API_SENTENCES.PORTAL_LINK_INVALID)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: COPY.sendLink })).toBeInTheDocument();
  });

  it('E701 (b15 audit F8): a used link while signed out with no team: the sentence and the no-team state, no form', async () => {
    withToken();
    const r = renderPortal({ link: { link: 'token', team: null }, routes: { ...signedOutRoutes, 'POST /portal/session': () => portalApiError('PORTAL_LINK_INVALID') } });
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { level: 1, name: COPY.noTeamTitle })).toBeInTheDocument();
    expect(screen.getByText(API_SENTENCES.PORTAL_LINK_INVALID, IGN)).toBeInTheDocument();
    expect(screen.getByText(COPY.noTeamBody)).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: COPY.sendLink })).toBeNull();
    expect(r.keys()).toEqual(['POST /portal/session', 'GET /portal/me']);
  });

  it('E704 (b15 audit F11): uncleared at the tap: not available, with no claim about sending (the client holds a link that was sent)', async () => {
    withToken();
    renderPortal({ link: { link: 'token' }, routes: { 'POST /portal/session': () => portalApiError('PORTAL_NOT_AVAILABLE') } });
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { level: 1, name: COPY.unavailableTitle })).toBeInTheDocument();
    expect(screen.getByText(API_SENTENCES.PORTAL_NOT_AVAILABLE)).toBeInTheDocument();
    expect(screen.queryByText(COPY.nothingSent)).toBeNull();
    expect(document.body.textContent).not.toMatch(/sent/i);
  });

  it('a rate limit or a network error: the sentence, and the tap may be tried again', async () => {
    withToken();
    let n = 0;
    const r = renderPortal({ link: { link: 'token' }, routes: { ...signedIn, 'POST /portal/session': () => (n++ === 0 ? portalApiError('RATE_LIMITED') : { status: 200, body: F.session() }) } });
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(API_SENTENCES.RATE_LIMITED, IGN)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Your home purchase' })).toBeInTheDocument();
    expect(r.keys().filter((k) => k === 'POST /portal/session')).toHaveLength(2);
  });

  it('E702: an incomplete link has no button, says so, and posts nothing', async () => {
    const r = renderPortal({ link: { link: 'incomplete' }, routes: {} });
    expect(screen.getByText(COPY.incomplete)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(screen.getByRole('button', { name: COPY.sendLink })).toBeInTheDocument();
    await act(async () => undefined);
    expect(r.seen).toEqual([]);
  });
});

describe('SignIn (R-PORTALWEB-4)', () => {
  it('R-PORTALWEB-4: the 202 sentence is 45\'s, verbatim; the field is cleared; "Use a different email or number" brings the form back', async () => {
    const r = renderPortal({ routes: { ...signedOutRoutes, 'POST /portal/login': () => ({ status: 202, body: F.accepted() }) } });
    expect(await screen.findByRole('heading', { level: 1, name: COPY.signInTitle })).toHaveFocus();
    await userEvent.type(screen.getByLabelText(COPY.emailLabel), 'jane@example.test');
    await userEvent.click(screen.getByRole('button', { name: COPY.sendLink }));
    expect(await screen.findByText(API_SENTENCES.SIGNIN_ACCEPTED, IGN)).toBeInTheDocument();
    await waitFor(() => expect(live()).toHaveTextContent(API_SENTENCES.SIGNIN_ACCEPTED));
    expect(r.seen.find((x) => x.key === 'POST /portal/login')!.body).toEqual({ team: 'harbor', address: 'jane@example.test' });
    expect(document.body.textContent).not.toMatch(/link (was|has been) sent|we sent you/i);
    await userEvent.click(screen.getByRole('button', { name: COPY.useDifferent }));
    expect(screen.getByLabelText(COPY.emailLabel)).toHaveValue('');
  });

  it('a text-message request sends the number as typed (tel, autocomplete tel)', async () => {
    const r = renderPortal({ routes: { ...signedOutRoutes, 'POST /portal/login': () => ({ status: 202, body: F.accepted() }) } });
    await screen.findByRole('heading', { level: 1, name: COPY.signInTitle });
    await userEvent.click(screen.getByRole('radio', { name: COPY.byText }));
    const field = screen.getByLabelText(COPY.phoneLabel);
    expect(field).toHaveAttribute('type', 'tel');
    expect(field).toHaveAttribute('autocomplete', 'tel');
    await userEvent.type(field, '(555) 555-0123');
    await userEvent.click(screen.getByRole('button', { name: COPY.sendLink }));
    await screen.findByText(API_SENTENCES.SIGNIN_ACCEPTED, IGN);
    expect(r.seen.find((x) => x.key === 'POST /portal/login')!.body).toEqual({ team: 'harbor', address: '(555) 555-0123' });
  });

  it('E706: a channel that cannot send: its sentence, nothing sent, Email still offered, the field kept', async () => {
    renderPortal({ routes: { ...signedOutRoutes, 'POST /portal/login': () => portalApiError('PORTAL_NOT_AVAILABLE', { channel: 'sms' }) } });
    await screen.findByRole('heading', { level: 1, name: COPY.signInTitle });
    await userEvent.click(screen.getByRole('radio', { name: COPY.byText }));
    await userEvent.type(screen.getByLabelText(COPY.phoneLabel), '5555550123');
    await userEvent.click(screen.getByRole('button', { name: COPY.sendLink }));
    expect(await screen.findByText(COPY.smsOff, IGN)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: COPY.byEmail })).toBeEnabled();
    expect(screen.getByLabelText(COPY.phoneLabel)).toHaveValue('5555550123');
  });

  it('b15 audit P46-UI-1: the chosen channel is the one 45 uses: Email with a number, or Text message with an email, is refused before any request with 45\'s sentence, the address kept', async () => {
    const r = renderPortal({ routes: { ...signedOutRoutes, 'POST /portal/login': () => ({ status: 202, body: F.accepted() }) } });
    await screen.findByRole('heading', { level: 1, name: COPY.signInTitle });
    await userEvent.type(screen.getByLabelText(COPY.emailLabel), '555-555-0123');
    await userEvent.click(screen.getByRole('button', { name: COPY.sendLink }));
    expect(await screen.findByText(API_SENTENCES.EMAIL_INVALID, IGN)).toBeInTheDocument();
    expect(screen.getByLabelText(COPY.emailLabel)).toHaveValue('555-555-0123');
    await userEvent.click(screen.getByRole('radio', { name: COPY.byText }));
    await userEvent.type(screen.getByLabelText(COPY.phoneLabel), 'jane@example.test');
    await userEvent.click(screen.getByRole('button', { name: COPY.sendLink }));
    expect(await screen.findByText(API_SENTENCES.PHONE_INVALID, IGN)).toBeInTheDocument();
    expect(screen.getByLabelText(COPY.phoneLabel)).toHaveValue('jane@example.test');
    expect(r.keys()).not.toContain('POST /portal/login');
    // the matching address is sent as before
    await userEvent.clear(screen.getByLabelText(COPY.phoneLabel));
    await userEvent.type(screen.getByLabelText(COPY.phoneLabel), '(555) 555-0123');
    await userEvent.click(screen.getByRole('button', { name: COPY.sendLink }));
    await screen.findByText(API_SENTENCES.SIGNIN_ACCEPTED, IGN);
    expect(r.seen.filter((x) => x.key === 'POST /portal/login').map((x) => x.body)).toEqual([{ team: 'harbor', address: '(555) 555-0123' }]);
  });

  it('b15 audit F11: email off: its sentence says nothing was sent and does not promise text messages (which may be off too)', async () => {
    renderPortal({ routes: { ...signedOutRoutes, 'POST /portal/login': () => portalApiError('PORTAL_NOT_AVAILABLE', { channel: 'email' }) } });
    await screen.findByRole('heading', { level: 1, name: COPY.signInTitle });
    await userEvent.type(screen.getByLabelText(COPY.emailLabel), 'jane@example.test');
    await userEvent.click(screen.getByRole('button', { name: COPY.sendLink }));
    expect(await screen.findByText(COPY.emailOff, IGN)).toBeInTheDocument();
    expect(COPY.emailOff).toMatch(/nothing was sent/);
    expect(COPY.emailOff).not.toMatch(/Text message|by text/i);
    expect(screen.getByLabelText(COPY.emailLabel)).toHaveValue('jane@example.test');
  });

  it('E704: uncleared at the request: the not-available screen, nothing sent', async () => {
    renderPortal({ routes: { ...signedOutRoutes, 'POST /portal/login': () => portalApiError('PORTAL_NOT_AVAILABLE') } });
    await screen.findByRole('heading', { level: 1, name: COPY.signInTitle });
    await userEvent.type(screen.getByLabelText(COPY.emailLabel), 'jane@example.test');
    await userEvent.click(screen.getByRole('button', { name: COPY.sendLink }));
    expect(await screen.findByRole('heading', { level: 1, name: COPY.unavailableTitle })).toHaveFocus();
    expect(screen.getByText(COPY.nothingSent)).toBeInTheDocument();
  });

  it('E707: 429, 413 and 422 show their own sentences and keep the address', async () => {
    for (const code of ['RATE_LIMITED', 'PAYLOAD_TOO_LARGE', 'EMAIL_INVALID', 'VALIDATION_FAILED'] as const) {
      const v = renderPortal({ routes: { ...signedOutRoutes, 'POST /portal/login': () => portalApiError(code) } });
      await screen.findByRole('heading', { level: 1, name: COPY.signInTitle });
      await userEvent.type(screen.getByLabelText(COPY.emailLabel), 'jane@example.test');
      await userEvent.click(screen.getByRole('button', { name: COPY.sendLink }));
      expect(await screen.findByText(API_SENTENCES[code], IGN), code).toBeInTheDocument();
      expect(screen.getByLabelText(COPY.emailLabel)).toHaveValue('jane@example.test');
      expect(document.body.textContent).not.toMatch(CODE_IN_TEXT);
      v.unmount();
    }
  });

  it('E719: no team: "Open your invitation link", no form, nothing guessed', async () => {
    const r = renderPortal({ link: { team: null }, routes: signedOutRoutes });
    expect(await screen.findByRole('heading', { level: 1, name: COPY.noTeamTitle })).toBeInTheDocument();
    expect(screen.getByText(COPY.noTeamBody)).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(r.keys()).toEqual(['GET /portal/me']);
  });
});

describe('Home and Grant (R-PORTALWEB-5, R-PORTALWEB-6)', () => {
  it('one grant opens directly: title, next steps, the agent card, dated items, no done mark; focus on the h1', async () => {
    renderPortal({ routes: signedIn });
    const title = await screen.findByRole('heading', { level: 1, name: 'Your home purchase' });
    await waitFor(() => expect(title).toHaveFocus());
    expect(await screen.findByText('Inspection')).toBeInTheDocument();
    expect(screen.getByText('Dec 18, 2026')).toBeInTheDocument();
    expect(screen.getAllByText(/^Shared /).length).toBeGreaterThan(0);
    expect(screen.getByText('By Jan 10, 2027')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Text Sam Agent' })).toHaveAttribute('href', 'sms:+15555550123');
    expect(screen.getByRole('link', { name: 'Email Sam Agent' })).toHaveAttribute('href', 'mailto:replies@example.test');
    expect(document.body.textContent).not.toMatch(/✓|✔|done|completed|complete\b/i);
    expect(screen.queryByRole('link', { name: /call/i })).toBeNull();
  });

  it('phone: Documents is one tap (a tab); arrow keys move between the tabs; the URL keeps the view', async () => {
    renderPortal({ routes: signedIn });
    await screen.findByText('Inspection');
    const tab = screen.getByRole('tab', { name: 'Documents' });
    await userEvent.click(tab);
    expect(await screen.findByText('Purchase contract.pdf')).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get('view')).toBe('documents');
    expect(new URLSearchParams(window.location.search).get('grant')).toBe(F.GRANT_ID);
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Documents' }), { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: 'Timeline' })).toHaveAttribute('aria-selected', 'true');
    window.history.replaceState(null, '', '/');
  });

  it('desktop: two columns, documents in view with no tap and no tablist', async () => {
    renderPortal({ routes: signedIn, wide: true });
    expect(await screen.findByText('Purchase contract.pdf')).toBeInTheDocument();
    expect(screen.getByText('Inspection')).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('E711: zero grants: one "nothing is shared" sentence', async () => {
    renderPortal({ routes: { ...signedIn, 'GET /portal/me': () => ({ status: 200, body: F.me([]) }) } });
    expect(await screen.findByText(VIEW_WORDS.nothingShared)).toBeInTheDocument();
    expect(h1()).toHaveTextContent(VIEW_WORDS.portalTitle);
  });

  it('several grants: a one-tap list; "You can see this until {date}" for an ending grant', async () => {
    renderPortal({ routes: { ...signedIn, 'GET /portal/me': () => ({ status: 200, body: F.me([F.grant(), F.grant({ id: F.GRANT_2, title: 'Your home sale', scope: 'sale', expiresOn: '2027-03-01' })]) }) } });
    const nav = await screen.findByRole('navigation', { name: COPY.chooseHome });
    await userEvent.click(within(nav).getByRole('button', { name: 'Your home sale' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Your home sale' })).toBeInTheDocument();
    expect(screen.getByText('You can see this until Mar 1, 2027.')).toBeInTheDocument();
    window.history.replaceState(null, '', '/');
  });

  it('E712, E125: a grant revoked between /me and the timeline: "no longer shared", /me refetched, no stale item', async () => {
    let revoked = false;
    const r = renderPortal({
      routes: {
        ...signedIn,
        'GET /portal/me': () => ({ status: 200, body: F.me(revoked ? [] : [F.grant()]) }),
        'GET /portal/timeline': () => {
          revoked = true;
          return portalApiError('NOT_FOUND');
        },
      },
    });
    expect(await screen.findByText(VIEW_WORDS.noLongerShared)).toBeInTheDocument();
    expect(await screen.findByText(VIEW_WORDS.nothingShared)).toBeInTheDocument();
    expect(screen.queryByText('Inspection')).toBeNull();
    expect(r.keys().filter((k) => k === 'GET /portal/me').length).toBeGreaterThanOrEqual(2);
  });

  it('R-PORTALWEB-9: sign out posts /logout with the CSRF token, clears the cache, shows "You\'re signed out" and keeps the team', async () => {
    const r = renderPortal({ routes: signedIn });
    await screen.findByText('Inspection');
    await userEvent.click(screen.getByRole('button', { name: COPY.signOut }));
    expect(await screen.findByRole('heading', { level: 1, name: COPY.signedOutTitle })).toHaveFocus();
    expect(r.seen.find((x) => x.key === 'POST /portal/logout')!.headers['x-csrf-token']).toBe(F.CSRF);
    expect(screen.getByText(COPY.signedOutBody)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: COPY.sendLink })).toBeInTheDocument();
    await waitFor(() => expect(r.queryClient.getQueryCache().getAll()).toEqual([]));
    expect(r.api.hasCsrf()).toBe(false);
  });

  // b15 review B15R-PORTAL-1: only a 204 clears the HttpOnly portal cookie (45's POST /logout), so only a 204 (or a 401:
  // already signed out) may say "You're signed out". Any other answer keeps Home, the CSRF token and the cache, shows
  // the sentence (on screen and in the live region) and keeps Sign out; CSRF_INVALID refetches /me and retries once (E716).
  const proxy502 = () => ({ status: 502, raw: new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }) });
  const offline = () => {
    throw new TypeError('Failed to fetch');
  };
  for (const [what, answer, sentence] of [
    ['a network error', offline, COPY.network],
    ['a 502 from the proxy (an API deploy)', proxy502, COPY.generic],
    ['429 RATE_LIMITED', () => portalApiError('RATE_LIMITED'), API_SENTENCES.RATE_LIMITED],
  ] as const) {
    it(`B15R-PORTAL-1: sign out that fails with ${what}: still signed in, the sentence shown and announced, Sign out kept, tokens and cache kept`, async () => {
      let n = 0;
      const r = renderPortal({ routes: { ...signedIn, 'POST /portal/logout': () => (n++ === 0 ? answer() : { status: 204 }) } });
      await screen.findByText('Inspection');
      await userEvent.click(screen.getByRole('button', { name: COPY.signOut }));
      expect(await screen.findByText(sentence, IGN)).toBeInTheDocument();
      await waitFor(() => expect(live()).toHaveTextContent(sentence));
      expect(screen.queryByRole('heading', { level: 1, name: COPY.signedOutTitle })).toBeNull();
      expect(screen.queryByText(COPY.signedOutBody)).toBeNull();
      expect(h1()).toHaveTextContent('Your home purchase');
      expect(screen.getByText('Inspection')).toBeInTheDocument();
      expect(r.api.hasCsrf()).toBe(true);
      expect(r.queryClient.getQueryData(['portal', 'me'])).toBeDefined();
      expect(r.keys().filter((k) => k === 'POST /portal/logout')).toHaveLength(1);
      // Sign out is still there, and a tap the API answers 204 signs out
      await userEvent.click(screen.getByRole('button', { name: COPY.signOut }));
      expect(await screen.findByRole('heading', { level: 1, name: COPY.signedOutTitle })).toBeInTheDocument();
      expect(r.keys().filter((k) => k === 'POST /portal/logout')).toHaveLength(2);
      expect(r.api.hasCsrf()).toBe(false);
    });
  }

  it('B15R-PORTAL-1, E716: sign out answered CSRF_INVALID (a sign-in in another tab): /me refetched, one retry with the fresh token, then signed out', async () => {
    let rotated = false;
    const r = renderPortal({
      routes: {
        ...signedIn,
        'GET /portal/me': () => ({ status: 200, body: F.me([F.grant()], rotated ? 'portal-csrf-token-2' : F.CSRF) }),
        'POST /portal/logout': (x) => {
          if (x.headers['x-csrf-token'] !== 'portal-csrf-token-2') {
            rotated = true;
            return portalApiError('CSRF_INVALID');
          }
          return { status: 204 };
        },
      },
    });
    await screen.findByText('Inspection');
    const mesBefore = r.keys().filter((k) => k === 'GET /portal/me').length;
    await userEvent.click(screen.getByRole('button', { name: COPY.signOut }));
    expect(await screen.findByRole('heading', { level: 1, name: COPY.signedOutTitle })).toBeInTheDocument();
    expect(r.seen.filter((x) => x.key === 'POST /portal/logout').map((x) => x.headers['x-csrf-token'])).toEqual([F.CSRF, 'portal-csrf-token-2']);
    expect(r.keys().filter((k) => k === 'GET /portal/me').length).toBe(mesBefore + 1);
  });

  it('B15R-PORTAL-1, E716: CSRF_INVALID again after the retry: the generic sentence, still signed in, Sign out kept (no third post)', async () => {
    const r = renderPortal({ routes: { ...signedIn, 'POST /portal/logout': () => portalApiError('CSRF_INVALID') } });
    await screen.findByText('Inspection');
    await userEvent.click(screen.getByRole('button', { name: COPY.signOut }));
    expect(await screen.findByText(COPY.generic, IGN)).toBeInTheDocument();
    await waitFor(() => expect(live()).toHaveTextContent(COPY.generic));
    expect(screen.queryByRole('heading', { level: 1, name: COPY.signedOutTitle })).toBeNull();
    expect(r.keys().filter((k) => k === 'POST /portal/logout')).toHaveLength(2);
    expect(screen.getByRole('button', { name: COPY.signOut })).toBeEnabled();
    expect(r.api.hasCsrf()).toBe(true);
  });

  it('B15R-PORTAL-1, E716: CSRF_INVALID and the /me refetch answers 401: already signed out, so "You\'re signed out" (no second post)', async () => {
    let ended = false;
    const r = renderPortal({
      routes: {
        ...signedIn,
        'GET /portal/me': () => (ended ? portalApiError('PORTAL_SESSION_REQUIRED') : { status: 200, body: F.me() }),
        'POST /portal/logout': () => {
          ended = true;
          return portalApiError('CSRF_INVALID');
        },
      },
    });
    await screen.findByText('Inspection');
    await userEvent.click(screen.getByRole('button', { name: COPY.signOut }));
    expect(await screen.findByRole('heading', { level: 1, name: COPY.signedOutTitle })).toBeInTheDocument();
    expect(r.keys().filter((k) => k === 'POST /portal/logout')).toHaveLength(1);
    expect(r.api.hasCsrf()).toBe(false);
  });

  it('B15R-PORTAL-1: sign out answered 401 PORTAL_SESSION_REQUIRED (the session had already ended): "You\'re signed out"', async () => {
    const r = renderPortal({ routes: { ...signedIn, 'POST /portal/logout': () => portalApiError('PORTAL_SESSION_REQUIRED') } });
    await screen.findByText('Inspection');
    await userEvent.click(screen.getByRole('button', { name: COPY.signOut }));
    expect(await screen.findByRole('heading', { level: 1, name: COPY.signedOutTitle })).toBeInTheDocument();
    expect(r.api.hasCsrf()).toBe(false);
    await waitFor(() => expect(r.queryClient.getQueryCache().getAll()).toEqual([]));
  });

  it('E705: the session ends mid-use: the next 401 signs out, the cache is cleared, nothing stale is shown', async () => {
    let ended = false;
    const r = renderPortal({ routes: { ...signedIn, 'GET /portal/documents': () => (ended ? portalApiError('PORTAL_SESSION_REQUIRED') : { status: 200, body: F.documents() }), 'GET /portal/me': () => (ended ? portalApiError('PORTAL_SESSION_REQUIRED') : { status: 200, body: F.me() }) } });
    await screen.findByText('Inspection');
    ended = true;
    await act(async () => {
      await r.queryClient.invalidateQueries();
    });
    expect(await screen.findByRole('heading', { level: 1, name: COPY.signedOutTitle })).toBeInTheDocument();
    expect(screen.queryByText('Inspection')).toBeNull();
    await waitFor(() => expect(r.queryClient.getQueryCache().getAll()).toEqual([]));
  });

  // b15 audit F6 (E705's "another client signs in on the device", R-PORTALWEB-9: the cache is cleared on each new
  // sign-in). Client B's world: another grant, another CSRF token, other items.
  const bMe = () => F.me([F.grant({ id: F.GRANT_2, title: 'Your home sale', scope: 'sale' })], 'portal-csrf-token-b');
  const bTimeline = (grantId: string) => ({ grantId, items: [{ itemId: F.ITEM_2, kind: 'milestone', title: 'Final walk-through', body: null, occursOn: '2027-02-01', publishedAt: '2026-11-10T15:00:00.000Z' }], nextSteps: [] });
  const aShown = () => ['Inspection', 'Book the movers', 'Your home purchase'].filter((t) => screen.queryByText(t) !== null);
  const cachedKeys = (r: ReturnType<typeof renderPortal>) => r.queryClient.getQueryCache().getAll().map((q) => JSON.stringify(q.queryKey));

  it('E705 (b15 audit F6): another client signs in on the device (another tab): on the next /me nothing of the first client is shown or cached', async () => {
    let who: 'a' | 'b' = 'a';
    const r = renderPortal({
      routes: {
        ...signedIn,
        'GET /portal/me': () => ({ status: 200, body: who === 'a' ? F.me() : bMe() }),
        'GET /portal/timeline': (x) => ({ status: 200, body: who === 'a' ? F.timeline(x.query.grantId) : bTimeline(x.query.grantId!) }),
      },
    });
    await screen.findByText('Inspection');
    expect(cachedKeys(r).some((k) => k.includes(F.GRANT_ID))).toBe(true);
    who = 'b';
    await act(async () => {
      await r.queryClient.invalidateQueries({ queryKey: ['portal', 'me'] });
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Your home sale' })).toBeInTheDocument();
    expect(await screen.findByText('Final walk-through')).toBeInTheDocument();
    expect(aShown()).toEqual([]);
    expect(cachedKeys(r).filter((k) => k.includes(F.GRANT_ID))).toEqual([]);
    expect(r.api.hasCsrf()).toBe(true);
    expect(r.problems).toEqual([]);
  });

  it('E705 (b15 audit F6): a sign-in link tapped on a device holding another client\'s data clears the cache first', async () => {
    withToken();
    const r = renderPortal({ link: { link: 'token' }, routes: { 'GET /portal/me': () => ({ status: 200, body: bMe() }), 'GET /portal/timeline': (x) => ({ status: 200, body: bTimeline(x.query.grantId!) }), 'GET /portal/documents': (x) => ({ status: 200, body: F.documents(x.query.grantId) }), 'POST /portal/session': () => ({ status: 200, body: F.session('portal-csrf-token-b') }) } });
    // client A's answers, as a shared device's cache would hold them
    r.queryClient.setQueryData(['portal', 'me'], F.me());
    r.queryClient.setQueryData(['portal', 'timeline', F.GRANT_ID], F.timeline());
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Your home sale' })).toBeInTheDocument();
    expect(await screen.findByText('Final walk-through')).toBeInTheDocument();
    expect(aShown()).toEqual([]);
    expect(cachedKeys(r).filter((k) => k.includes(F.GRANT_ID))).toEqual([]);
  });

  it('b15 audit F11: /me fails for another reason than the session (a network error): the sentence and Try again, no Sign out; Try again asks /me again', async () => {
    let down = true;
    const r = renderPortal({
      routes: {
        ...signedIn,
        'GET /portal/me': () => {
          if (down) throw new TypeError('Failed to fetch');
          return { status: 200, body: F.me() };
        },
      },
    });
    expect(await screen.findByText(COPY.network, IGN)).toBeInTheDocument();
    expect(h1()).toHaveTextContent(VIEW_WORDS.portalTitle);
    expect(screen.queryByRole('button', { name: COPY.signOut })).toBeNull();
    down = false;
    await userEvent.click(screen.getByRole('button', { name: COPY.tryAgain }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Your home purchase' })).toBeInTheDocument();
    expect(r.keys().filter((k) => k === 'GET /portal/me').length).toBeGreaterThanOrEqual(1);
  });

  it('b15 audit F11: an unreadable /me answer (BAD_RESPONSE) gets the generic sentence and Try again, no Sign out', async () => {
    // a raw answer (the contract fake checks bodies, and the API never sends this one): what a broken proxy might send
    renderPortal({ routes: { ...signedIn, 'GET /portal/me': () => ({ status: 200, raw: new Response('{"grants":"not a list"}', { status: 200, headers: { 'content-type': 'application/json' } }) }) } });
    expect(await screen.findByText(COPY.generic, IGN)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: COPY.tryAgain })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: COPY.signOut })).toBeNull();
  });

  // b15 review UI-2: Try again says what happened. The sentence reaches the live region when the error screen opens and
  // after each failed retry (the same sentence again too), and Try again is marked busy while the retry runs (it keeps
  // focus: aria-disabled, not disabled).
  const liveLog = () => {
    const seen: string[] = [];
    const mo = new MutationObserver(() => seen.push(live().textContent ?? ''));
    mo.observe(live(), { childList: true, characterData: true, subtree: true });
    return seen;
  };

  it('b15 review UI-2: a /me refetch that keeps failing after /me answered: the sentence is announced, Try again is busy while it runs, and a failed retry is announced again', async () => {
    let mode: 'up' | 'down' | 'gated' = 'up';
    let release!: () => void;
    const r = renderPortal({
      routes: {
        ...signedIn,
        'GET /portal/me': async () => {
          if (mode === 'gated') await new Promise<void>((res) => (release = res));
          if (mode !== 'up') throw new TypeError('Failed to fetch');
          return { status: 200, body: F.me() };
        },
      },
    });
    await screen.findByText('Inspection');
    mode = 'down';
    await act(async () => {
      await r.queryClient.invalidateQueries({ queryKey: ['portal', 'me'] });
    });
    expect(await screen.findByText(COPY.network, IGN)).toBeInTheDocument();
    await waitFor(() => expect(live()).toHaveTextContent(COPY.network));
    expect(screen.getByRole('button', { name: COPY.signOut })).toBeInTheDocument();
    const seen = liveLog();
    mode = 'gated';
    const again = screen.getByRole('button', { name: COPY.tryAgain });
    await userEvent.click(again);
    await waitFor(() => expect(again).toHaveAttribute('aria-disabled', 'true'));
    expect(again).toHaveFocus();
    await userEvent.click(again); // a tap while busy asks nothing more
    const calls = r.keys().filter((k) => k === 'GET /portal/me').length;
    await act(async () => {
      release();
      await new Promise((res) => setTimeout(res, 20));
    });
    await waitFor(() => expect(again).not.toHaveAttribute('aria-disabled', 'true'));
    await waitFor(() => expect(seen.filter((t) => t === COPY.network).length).toBeGreaterThanOrEqual(1));
    expect(r.keys().filter((k) => k === 'GET /portal/me').length).toBe(calls);
  });

  it('b15 review UI-2: a first /me that fails announces its sentence (the error screen\'s heading takes focus, the live region says why)', async () => {
    renderPortal({
      routes: {
        ...signedIn,
        'GET /portal/me': () => {
          throw new TypeError('Failed to fetch');
        },
      },
    });
    expect(await screen.findByText(COPY.network, IGN)).toBeInTheDocument();
    await waitFor(() => expect(live()).toHaveTextContent(COPY.network));
  });

  it('b15 review UI-2: a timeline that fails to load offers Try again (announced); Try again reads it again', async () => {
    let down = true;
    const r = renderPortal({
      routes: {
        ...signedIn,
        'GET /portal/timeline': (x) => {
          if (down) throw new TypeError('Failed to fetch');
          return { status: 200, body: F.timeline(x.query.grantId) };
        },
      },
    });
    expect(await screen.findByText(COPY.generic, IGN)).toBeInTheDocument();
    await waitFor(() => expect(live()).toHaveTextContent(COPY.generic));
    down = false;
    await userEvent.click(screen.getByRole('button', { name: COPY.tryAgain }));
    expect(await screen.findByText('Inspection')).toBeInTheDocument();
    expect(r.keys().filter((k) => k === 'GET /portal/timeline').length).toBe(2);
  });

  it('R-PORTALWEB-6: no screen shows a code', async () => {
    renderPortal({ routes: { ...signedIn, 'GET /portal/documents': () => portalApiError('VALIDATION_FAILED') } });
    await screen.findByText('Inspection');
    expect(document.body.textContent).not.toMatch(CODE_IN_TEXT);
  });
});
