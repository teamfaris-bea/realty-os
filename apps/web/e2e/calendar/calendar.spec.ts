// Module 41's calendar settings page against the REAL API (stack.ts: a fresh per-test Postgres database,
// RLS-bound app_user, the fake Google OAuth provider and fake Google calendar), on the phone (iPhone 13,
// 390x844) and desktop (1440x900) projects. An agent opens Calendar from navigation, connects Google Calendar
// (the fake provider's approval screen is played by the fixture: the browser's request to the fake provider
// is answered with the redirect a real provider would send), sees "Connected" in words, an in-app appointment
// reaches the fake Google calendar, then disconnects in two taps and the token is purged. Taps are counted
// from the signed-in Home screen; the provider's own approval screen is not counted.
import { type Page, expect, test } from 'playwright/test';
import { type CalendarStack, type World, startCalendarStack } from './stack.js';

test.describe.configure({ mode: 'serial' });

let stack: CalendarStack;
let w: World;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startCalendarStack();
  w = await stack.fixture<World>('/world');
});
test.afterAll(async () => {
  await stack?.stop();
});

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 768;

async function signInAgent(page: Page) {
  await page.goto(`${stack.webUrl}/login`);
  await page.getByLabel('Email').fill(w.agent.email);
  await page.getByLabel('Password').fill(w.agent.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
}

/** The fake provider's consent screen: approve, and redirect back with the code, exactly as a provider would. */
async function fakeProviderApproves(page: Page) {
  await page.route('https://oauth.fake.invalid/**', async (route) => {
    const a = await stack.fixture<{ code: string; state: string; provider: string }>('/approve', { url: route.request().url() });
    const back = `${stack.webUrl}/api/me/calendar/${a.provider}/callback?${new URLSearchParams({ state: a.state, code: a.code }).toString()}`;
    await route.fulfill({ status: 302, headers: { location: back } });
  });
}

test('an agent connects Google Calendar, an appointment reaches it, and they disconnect it (taps counted)', async ({ page }) => {
  await signInAgent(page);
  await fakeProviderApproves(page);
  let taps = 0;
  const tap = async (l: ReturnType<Page['getByRole']>) => {
    taps += 1;
    if (isPhone(page)) await l.tap();
    else await l.click();
  };

  // open the page from navigation
  if (isPhone(page)) {
    await tap(page.getByRole('navigation', { name: 'Main tabs' }).getByRole('link', { name: 'More' }));
    await tap(page.getByRole('link', { name: 'Calendar', exact: true }));
  } else await tap(page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('link', { name: 'Calendar', exact: true }));
  await expect(page.getByRole('heading', { level: 1, name: 'Calendar' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'What syncs' })).toBeVisible();
  await expect(page.getByText(/^One way: appointments you make or change in Realty OS are added to your calendar/)).toBeVisible();
  await expect(page.getByText(/Owners and Admins cannot see your calendar/)).toBeVisible();

  // connect: one tap, then the provider's approval, then back on the page in words
  await tap(page.getByRole('button', { name: 'Connect Google Calendar' }));
  await expect(page.getByText('Your calendar is connected. New and changed appointments will appear there.')).toBeVisible();
  await expect(page.getByText('Connected. New and changed appointments are added to your Google Calendar.')).toBeVisible();
  expect(taps).toBe(isPhone(page) ? 3 : 2);
  expect((await stack.fixture<{ link: { status: string; has_token: boolean } }>('/link')).link).toMatchObject({ status: 'connected', has_token: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  // the accept: an in-app appointment appears in the fake Google calendar
  expect(await stack.fixture<{ inGoogle: boolean; title: string }>('/push')).toMatchObject({ inGoogle: true, title: 'Buyer consult' });

  // disconnect: two taps (Disconnect, then the confirmation)
  taps = 0;
  await tap(page.getByRole('button', { name: 'Disconnect Google Calendar' }));
  await tap(page.getByRole('button', { name: 'Yes, disconnect' }));
  await expect(page.getByText(/Google Calendar is disconnected\. Nothing more is sent to it\./)).toBeVisible();
  await expect(page.getByText('Not connected. Nothing is sent to your Google Calendar.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect Google Calendar' })).toBeVisible();
  expect(taps).toBe(2);
  expect((await stack.fixture<{ link: { status: string; has_token: boolean; has_refresh: boolean } }>('/link')).link).toEqual({ status: 'revoked', has_token: false, has_refresh: false });
  await page.screenshot({ path: `test-results/calendar/${isPhone(page) ? 'phone' : 'desktop'}-disconnected.png`, fullPage: true });
});
