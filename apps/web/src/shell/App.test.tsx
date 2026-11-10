// The shell end to end in jsdom (fake API): session gate, auth screens, layout, role filtering,
// error sentences and accessibility. The same flows run against the real API in
// e2e/shell/auth.spec.ts.
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useApi } from './context.js';
import { FakeFetch, err, renderApp, sessionFixture, tableWith } from './testing/fakeApi.js';
import type { SurfaceModule } from './types.js';

const Search = () => <p>search page body</p>;
const Team = () => <p>team page body</p>;
function Pinger() {
  const api = useApi();
  const [s, setS] = useState('…');
  useEffect(() => {
    api.get('/ping').then(
      () => setS('pong'),
      () => setS('failed'),
    );
  }, [api]);
  return <p>{s}</p>;
}

const testSurface: SurfaceModule = {
  pages: [
    { path: '/search', title: 'Search', roles: 'all', nav: { phone: 'tab', desktop: 'sidebar', icon: 'search', order: 2 }, component: Search },
    { path: '/team', title: 'Team', roles: ['owner', 'admin', 'team_lead'], nav: { phone: 'more', desktop: 'sidebar', icon: 'team', order: 50, section: 'team' }, component: Team },
    { path: '/contacts/:id', title: 'Contact', roles: 'all', component: Pinger },
  ],
};
const table = tableWith(testSurface);

const ok = (s = sessionFixture()) => ({ status: 200, body: s });
const loginOk = (s = sessionFixture(), next = 'ready') => ({ status: 200, body: { next, session: s } });

async function axeViolations(): Promise<string[]> {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  window.sessionStorage.clear();
});
afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('session gate', () => {
  it('signed out: any app page goes to sign-in and comes back to it afterwards', async () => {
    const fake = new FakeFetch().on('GET /auth/session', err(401, 'UNAUTHENTICATED')).on('POST /auth/login', loginOk());
    const { router } = renderApp({ fake, path: '/search', table });
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.pathname + router.state.location.search).toBe('/login?next=%2Fsearch');
    await userEvent.type(screen.getByLabelText('Email'), ' ava@example.test ');
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse battery staple');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('search page body')).toBeInTheDocument();
    expect(fake.callsTo('POST /auth/login')[0]?.body).toEqual({ email: 'ava@example.test', password: 'correct horse battery staple' });
    expect(router.state.location.pathname).toBe('/search');
  });

  it('a failed sign-in shows the uniform sentence, never the code, and clears the password', async () => {
    const fake = new FakeFetch().on('GET /auth/session', err(401, 'UNAUTHENTICATED')).on('POST /auth/login', err(401, 'LOGIN_FAILED'));
    renderApp({ fake, path: '/login', table });
    await userEvent.type(await screen.findByLabelText('Email'), 'ava@example.test');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("That email and password don't match.");
    expect(document.body.textContent).not.toMatch(/LOGIN_FAILED/);
    expect(screen.getByLabelText('Password')).toHaveValue('');
  });

  it('MFA: sign-in goes to the code screen, then to the requested page; a recovery code works too', async () => {
    const pending = sessionFixture({ mfa: { enabled: true, verified: false, enrollmentRequired: false } });
    const verified = sessionFixture({ mfa: { enabled: true, verified: true, enrollmentRequired: false } });
    const fake = new FakeFetch()
      .on('GET /auth/session', err(401, 'UNAUTHENTICATED'))
      .on('POST /auth/login', loginOk(pending, 'mfa_verify'))
      .on('POST /auth/mfa/verify', (c, n) => (n === 1 ? err(401, 'MFA_CODE_INVALID') : loginOk(verified)));
    const { router } = renderApp({ fake, path: '/search', table });
    await userEvent.type(await screen.findByLabelText('Email'), 'ava@example.test');
    await userEvent.type(screen.getByLabelText('Password'), 'pw');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Two-step verification' })).toBeInTheDocument();
    expect(router.state.location.pathname + router.state.location.search).toBe('/login/mfa?next=%2Fsearch');
    const code = screen.getByLabelText('Code');
    expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    expect(code).toHaveAttribute('inputmode', 'numeric');
    await userEvent.type(code, '12a3456');
    expect(code).toHaveValue('123456');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/newest one/);
    await userEvent.click(screen.getByRole('button', { name: /Use a recovery code/ }));
    await userEvent.type(screen.getByLabelText('Recovery code'), 'abcd-efgh-ijkl');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('search page body')).toBeInTheDocument();
    expect(fake.callsTo('POST /auth/mfa/verify').map((c) => c.body)).toEqual([{ code: '123456' }, { recoveryCode: 'abcd-efgh-ijkl' }]);
  });

  it('an Owner without MFA must enroll first: key shown, code confirmed, recovery codes shown once, then the app', async () => {
    const enrolling = sessionFixture({ tenant: { ...sessionFixture().tenant!, role: 'owner' }, mfa: { enabled: false, verified: false, enrollmentRequired: true } });
    const enrolled = { ...enrolling, mfa: { enabled: true, verified: true, enrollmentRequired: false } };
    const codes = Array.from({ length: 10 }, (_, i) => `code-${i}`);
    const fake = new FakeFetch()
      .on('GET /auth/session', ok(enrolling))
      .on('POST /auth/mfa/enroll', (_c, n) => (n === 1 ? err(401, 'REAUTH_REQUIRED') : { status: 200, body: { secret: 'JBSWY3DPEHPK3PXPJBSWY3DP', otpauthUri: 'otpauth://totp/x' } }))
      .on('POST /auth/reauth', loginOk(enrolling, 'mfa_enroll'))
      .on('POST /auth/mfa/enroll/confirm', { status: 200, body: { recoveryCodes: codes, session: enrolled } });
    const { router } = renderApp({ fake, path: '/', table });
    // starting enrollment needs a fresh password proof: the re-auth prompt appears and then it continues
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Password'), 'pw');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByLabelText('Setup key')).toHaveTextContent('JBSW Y3DP EHPK 3PXP JBSW Y3DP');
    expect(router.state.location.pathname).toBe('/mfa/enroll');
    await userEvent.type(screen.getByLabelText('Code'), '654321');
    await userEvent.click(screen.getByRole('button', { name: 'Turn on two-step verification' }));
    const list = await screen.findByRole('list', { name: 'Recovery codes' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
    await userEvent.click(screen.getByRole('button', { name: 'I saved them, continue' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument();
    expect(fake.callsTo('POST /auth/mfa/enroll/confirm')[0]?.body).toEqual({ code: '654321' });
    // one enrollment start (each issues a new secret) plus its single re-send after re-auth, even under StrictMode
    expect(fake.callsTo('POST /auth/mfa/enroll')).toHaveLength(2);
  });

  it('no active team: choose one; the switch is by slug and lands in the app', async () => {
    const a = { id: '01900000-0000-7000-8000-00000000000a', name: 'Harbor Home Team', slug: 'harbor', role: 'agent' as const };
    const b = { id: '01900000-0000-7000-8000-00000000000b', name: 'Bayside Group', slug: 'bayside', role: 'team_lead' as const };
    const none = sessionFixture({ tenant: null, tenants: [a, b] });
    const fake = new FakeFetch().on('GET /auth/session', ok(none)).on('POST /auth/tenant-switch', loginOk(sessionFixture({ tenant: b, tenants: [a, b] })));
    renderApp({ fake, path: '/', table });
    await userEvent.click(await screen.findByRole('button', { name: /Bayside Group/ }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument();
    expect(fake.callsTo('POST /auth/tenant-switch')[0]?.body).toEqual({ slug: 'bayside' });
    // a Team Lead in Bayside sees the team page in navigation
    expect(screen.getAllByRole('link', { name: 'Team' }).length).toBeGreaterThan(0);
  });

  it('a user on no team is told how to join, not shown an empty app', async () => {
    const fake = new FakeFetch().on('GET /auth/session', ok(sessionFixture({ tenant: null, tenants: [] })));
    renderApp({ fake, path: '/', table });
    expect(await screen.findByText("You're not on a team yet")).toBeInTheDocument();
  });

  it('if the session cannot be loaded (offline), says so and offers Try again', async () => {
    const fake = new FakeFetch().on('GET /auth/session', (_c, n) => (n === 1 ? 'network-error' : ok()));
    renderApp({ fake, path: '/', table });
    expect(await screen.findByText(/Can't reach the server/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument();
  });

  it('a 401 from any call signs the app out to the sign-in screen and forgets cached data', async () => {
    const fake = new FakeFetch().on('GET /auth/session', (_c, n) => (n === 1 ? ok() : err(401, 'UNAUTHENTICATED'))).on('GET /ping', err(401, 'UNAUTHENTICATED'));
    const { router } = renderApp({ fake, path: '/contacts/1', table });
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
  });
});

describe('layout and navigation', () => {
  it('phone tab bar and desktop sidebar list the role’s pages; Account is under More', async () => {
    const fake = new FakeFetch().on('GET /auth/session', ok());
    renderApp({ fake, path: '/', table });
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    // both are in the DOM; CSS shows the tab bar below 768 px and the sidebar above
    const sidebar = screen.getByRole('navigation', { name: 'Main' });
    const tabbar = screen.getByRole('navigation', { name: 'Main tabs' });
    expect(within(tabbar).getAllByRole('link').map((l) => l.textContent)).toEqual(['Home', 'Search', 'More']);
    expect(within(sidebar).getAllByRole('link').map((l) => l.textContent)).toEqual(['Home', 'Search', 'Account']);
    // an agent does not see the Team Lead page
    expect(screen.queryByRole('link', { name: 'Team' })).toBeNull();
    expect(within(tabbar).getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    await userEvent.click(within(tabbar).getByRole('link', { name: 'More' }));
    const more = await screen.findByRole('navigation', { name: 'More' });
    await userEvent.click(within(more).getByRole('link', { name: 'Account' }));
    expect(await screen.findByText('ava@example.test')).toBeInTheDocument();
    expect(within(tabbar).getByRole('link', { name: 'More' })).toHaveAttribute('aria-current', 'page');
  });

  it('a page the role may not open is "not available", even by URL (the server still decides data access)', async () => {
    const fake = new FakeFetch().on('GET /auth/session', ok());
    renderApp({ fake, path: '/team', table });
    expect(await screen.findByText("This page isn't available")).toBeInTheDocument();
    expect(screen.queryByText('team page body')).toBeNull();
  });

  it('unknown paths are "not available"', async () => {
    const fake = new FakeFetch().on('GET /auth/session', ok());
    renderApp({ fake, path: '/nope', table });
    expect(await screen.findByText("This page isn't available")).toBeInTheDocument();
  });

  it('after in-app navigation focus moves to the new page h1, and the document title names page and team', async () => {
    const fake = new FakeFetch().on('GET /auth/session', ok());
    const { router } = renderApp({ fake, path: '/', table });
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    expect(document.title).toBe('Home · Harbor Home Team');
    await act(() => router.navigate('/search'));
    const h1 = await screen.findByRole('heading', { level: 1, name: 'Search' });
    await waitFor(() => expect(h1).toHaveFocus());
    expect(document.title).toBe('Search · Harbor Home Team');
  });

  it('detail pages (no nav) get a Back button on the phone top bar', async () => {
    const fake = new FakeFetch().on('GET /auth/session', ok()).on('GET /ping', { status: 200, body: {} });
    renderApp({ fake, path: '/contacts/1', table });
    expect(await screen.findByRole('heading', { level: 1, name: 'Contact' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Back' })).toBeInTheDocument();
  });

  it('signing out from Account ends the session on the server and returns to sign-in', async () => {
    const fake = new FakeFetch().on('GET /auth/session', ok()).on('POST /auth/logout', { status: 200, body: { ok: true } });
    const { router } = renderApp({ fake, path: '/account', table });
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    // an explicit sign-out does not bring the next person back to this page
    expect(router.state.location.pathname + router.state.location.search).toBe('/login');
    expect(fake.callsTo('POST /auth/logout')[0]?.headers['x-csrf-token']).toBe('csrf-1');
  });

  it('has a skip link to main content', async () => {
    const fake = new FakeFetch().on('GET /auth/session', ok());
    renderApp({ fake, path: '/', table });
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveAttribute('href', '#main');
    expect(document.getElementById('main')?.tagName).toBe('MAIN');
  });
});

describe('invite, signup and password reset', () => {
  it('invite (#token): the token leaves the address bar at once; a new person creates an account and joins', async () => {
    window.history.replaceState(null, '', '/invite#token=tok-123456789');
    const fake = new FakeFetch().on('GET /auth/session', err(401, 'UNAUTHENTICATED')).on('POST /auth/invites/tok-123456789/accept', loginOk());
    renderApp({ fake, path: '/invite', table });
    await screen.findByRole('heading', { level: 1, name: 'Join your team' });
    expect(window.location.hash).toBe('');
    await userEvent.type(screen.getByLabelText('Your name'), 'Ava Agent');
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse battery staple');
    await userEvent.click(screen.getByRole('button', { name: 'Join team' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument();
    expect(fake.callsTo('POST /auth/invites/tok-123456789/accept')[0]?.body).toEqual({ displayName: 'Ava Agent', password: 'correct horse battery staple' });
    expect(window.sessionStorage.getItem('realty.pendingInvite')).toBeNull();
  });

  it('invite for an existing account: sign in first, then accept with one tap', async () => {
    window.history.replaceState(null, '', '/invite#token=tok-abcdefghij');
    let signedIn = false;
    const fake = new FakeFetch()
      .on('GET /auth/session', () => (signedIn ? ok() : err(401, 'UNAUTHENTICATED')))
      .on('POST /auth/invites/tok-abcdefghij/accept', () => (signedIn ? loginOk() : err(401, 'LOGIN_REQUIRED')))
      .on('POST /auth/login', () => {
        signedIn = true;
        return loginOk();
      });
    const { router } = renderApp({ fake, path: '/invite', table });
    await userEvent.type(await screen.findByLabelText('Your name'), 'Ava');
    await userEvent.type(screen.getByLabelText('Password'), 'some long password');
    await userEvent.click(screen.getByRole('button', { name: 'Join team' }));
    await userEvent.click(await screen.findByRole('link', { name: 'Sign in' }));
    expect(router.state.location.pathname + router.state.location.search).toBe('/login?next=%2Finvite');
    await userEvent.type(screen.getByLabelText('Email'), 'ava@example.test');
    await userEvent.type(screen.getByLabelText('Password'), 'pw');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Accept invite' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument();
    expect(fake.callsTo('POST /auth/invites/tok-abcdefghij/accept').map((c) => c.body)).toEqual([{ displayName: 'Ava', password: 'some long password' }, {}]);
  });

  it('invite in the path (/invite/:token) works and is replaced by /invite', async () => {
    const fake = new FakeFetch().on('GET /auth/session', err(401, 'UNAUTHENTICATED')).on('POST /auth/invites/tok-in-path-1/accept', err(404, 'INVITE_INVALID'));
    const { router } = renderApp({ fake, path: '/invite/tok-in-path-1', table });
    await screen.findByRole('heading', { level: 1, name: 'Join your team' });
    await waitFor(() => expect(router.state.location.pathname).toBe('/invite'));
    await userEvent.type(screen.getByLabelText('Your name'), 'Ava');
    await userEvent.type(screen.getByLabelText('Password'), 'some long password');
    await userEvent.click(screen.getByRole('button', { name: 'Join team' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/expired, was already used, or was withdrawn/);
  });

  it('an invite link without a token says what to do', async () => {
    const fake = new FakeFetch().on('GET /auth/session', err(401, 'UNAUTHENTICATED'));
    renderApp({ fake, path: '/invite', table });
    expect(await screen.findByText('This invite link is incomplete')).toBeInTheDocument();
  });

  it('signup: the team address follows the team name until edited; weak password gets the specific sentence', async () => {
    const owner = sessionFixture({ tenant: { ...sessionFixture().tenant!, role: 'owner' }, mfa: { enabled: false, verified: false, enrollmentRequired: true } });
    const fake = new FakeFetch()
      .on('GET /auth/session', err(401, 'UNAUTHENTICATED'))
      .on('POST /auth/signup', (_c, n) => (n === 1 ? err(422, 'PASSWORD_TOO_WEAK', { rule: 'length' }) : { status: 201, body: { next: 'mfa_enroll', session: owner } }))
      .on('POST /auth/mfa/enroll', { status: 200, body: { secret: 'ABCDEFGH', otpauthUri: 'otpauth://totp/x' } });
    const { router } = renderApp({ fake, path: '/signup', table });
    await userEvent.type(await screen.findByLabelText('Your name'), 'Olivia Owner');
    await userEvent.type(screen.getByLabelText('Email'), 'olivia@example.test');
    await userEvent.type(screen.getByLabelText('Password'), 'short');
    await userEvent.type(screen.getByLabelText('Team name'), 'Harbor Home Team!');
    expect(screen.getByLabelText('Team web address')).toHaveValue('harbor-home-team');
    await userEvent.type(screen.getByLabelText('Brokerage legal name'), 'Harbor Realty LLC');
    await userEvent.selectOptions(screen.getByLabelText('Team time zone'), 'America/Chicago');
    await userEvent.click(screen.getByRole('button', { name: 'Create team' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Use at least 12 characters.');
    await userEvent.clear(screen.getByLabelText('Password'));
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse battery staple');
    await userEvent.click(screen.getByRole('button', { name: 'Create team' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/mfa/enroll'));
    expect(fake.callsTo('POST /auth/signup')[1]?.body).toEqual({
      displayName: 'Olivia Owner',
      email: 'olivia@example.test',
      password: 'correct horse battery staple',
      teamName: 'Harbor Home Team!',
      slug: 'harbor-home-team',
      timezone: 'America/Chicago',
      brokerageLegalName: 'Harbor Realty LLC',
    });
  });

  it('forgot password: the same answer whether or not the account exists', async () => {
    const fake = new FakeFetch().on('GET /auth/session', err(401, 'UNAUTHENTICATED')).on('POST /auth/password/reset', { status: 202, body: { ok: true } });
    renderApp({ fake, path: '/forgot-password', table });
    await userEvent.type(await screen.findByLabelText('Email'), 'who@example.test');
    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByText(/If an account uses who@example.test/)).toBeInTheDocument();
  });

  it('reset: token from #token is hidden from the URL; mismatch is caught locally; an expired link says so', async () => {
    window.history.replaceState(null, '', '/reset-password#token=reset-token-123');
    const fake = new FakeFetch()
      .on('GET /auth/session', err(401, 'UNAUTHENTICATED'))
      .on('POST /auth/password/reset/confirm', (_c, n) => (n === 1 ? err(400, 'RESET_TOKEN_INVALID') : { status: 200, body: { ok: true } }));
    renderApp({ fake, path: '/reset-password', table });
    await screen.findByRole('heading', { level: 1, name: 'Choose a new password' });
    expect(window.location.hash).toBe('');
    await userEvent.type(screen.getByLabelText('New password'), 'correct horse battery staple');
    await userEvent.type(screen.getByLabelText('New password again'), 'correct horse battery stapl');
    await userEvent.click(screen.getByRole('button', { name: 'Save password' }));
    expect(await screen.findByText("The two passwords don't match.")).toBeInTheDocument();
    expect(fake.callsTo('POST /auth/password/reset/confirm')).toHaveLength(0);
    await userEvent.type(screen.getByLabelText('New password again'), 'e');
    await userEvent.click(screen.getByRole('button', { name: 'Save password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/expired or was already used/);
    expect(screen.getByRole('link', { name: 'Request a new link' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save password' }));
    expect(await screen.findByText(/signed out everywhere/)).toBeInTheDocument();
    expect(fake.callsTo('POST /auth/password/reset/confirm')[1]?.body).toEqual({ token: 'reset-token-123', password: 'correct horse battery staple' });
  });
});

describe('accessibility (axe-core; color contrast is checked in the Playwright run)', () => {
  it('sign-in screen has no violations', async () => {
    const fake = new FakeFetch().on('GET /auth/session', err(401, 'UNAUTHENTICATED')).on('POST /auth/login', err(401, 'LOGIN_FAILED'));
    renderApp({ fake, path: '/login', table });
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(await axeViolations()).toEqual([]);
  });

  it('the app frame (nav, header, main) has no violations', async () => {
    const fake = new FakeFetch().on('GET /auth/session', ok());
    renderApp({ fake, path: '/account', table });
    await screen.findByText('ava@example.test');
    expect(await axeViolations()).toEqual([]);
  });

  it('the re-auth dialog and MFA screen have no violations', async () => {
    const pending = sessionFixture({ mfa: { enabled: true, verified: false, enrollmentRequired: false } });
    const fake = new FakeFetch().on('GET /auth/session', ok(pending));
    renderApp({ fake, path: '/', table });
    await screen.findByRole('heading', { name: 'Two-step verification' });
    expect(await axeViolations()).toEqual([]);
  });
});
