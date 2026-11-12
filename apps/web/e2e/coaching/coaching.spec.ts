// Coaching against the REAL API (stack.ts), on the phone (iPhone 13) and desktop (1440×900) projects
// (modules 36, 40, 41; R-COACH-2..6, R-INT-6). The agent's three recorded calls were reviewed by the
// review job (fake model) and the reconcile wrote today's tip, as the worker does.
//   - agent: Home → the coaching card → the tip with two moments (1 tap) → one moment plays (1 more tap);
//   - Owner: coaching settings from Home (phone: More → Coaching, 2 taps; desktop: the sidebar, 1 click),
//     "Not reviewed by counsel" while the pack is unreviewed, Team Lead access on in 1 tap;
//   - Team Lead: their team's tip appears only once the Owner allowed it;
//   - agent: "Not now" sets the tip aside in 1 tap;
//   - Admin (last: it ends call reviews): the settings from Home in the same taps as the Owner, call reviews
//     off in 1 tap; turning them on, Team Lead access and the checklist stay the Owner's (E283).
// No score, grade, percentage or rank on any of these screens; axe finds nothing; no sideways scroll on phone.
import { createRequire } from 'node:module';
import { type Locator, type Page, expect, test } from 'playwright/test';
import { type CoachingSeed, type CoachingStack, startCoachingStack } from './stack.js';

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');

test.describe.configure({ mode: 'serial' });

let stack: CoachingStack;
let seed: CoachingSeed;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startCoachingStack();
  seed = await stack.fixture<CoachingSeed>('/seed');
});
test.afterAll(async () => {
  await stack?.stop();
});

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 768;

async function tap(page: Page, target: Locator, counter: { taps: number }) {
  if (isPhone(page)) await target.tap();
  else await target.click();
  counter.taps += 1;
}

async function signIn(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto(`${stack.webUrl}/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(seed.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const code = (await stack.fixture<{ code: string | null }>('/totp', { email })).code;
  if (code) {
    await page.getByLabel('Code').fill(code);
    await page.getByRole('button', { name: 'Continue' }).click();
  }
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible({ timeout: 15_000 });
}

async function axeViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async () => {
    const r = await (window as unknown as { axe: { run(ctx: Document, o: object): Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe.run(document, { resultTypes: ['violations'] });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
}

async function noGrades(page: Page) {
  // the settings page's one statement that there are none is the only place these words may appear
  const text = ((await page.locator('main').textContent()) ?? '').replace('nobody is graded or ranked', '');
  expect(text).not.toMatch(/\bscores?\b|\bgrades?\b|\brank|\d+\s?%|leaderboard/i);
  if (isPhone(page)) expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

const shot = (page: Page, name: string) => page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });

test('agent: the coaching card opens today’s tip in 1 tap; a moment of the call plays in 1 more', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, seed.agent);
  const n = { taps: 0 };
  const card = page.locator('article').filter({ has: page.getByText("Today's coaching tip", { exact: true }) }).first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await tap(page, card.getByRole('button', { name: 'See the tip' }), n);
  await expect(page).toHaveURL(/\/coaching$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Coaching tip' })).toBeVisible();
  const tip = page.getByRole('article').filter({ has: page.getByRole('heading', { level: 2, name: /lender/ }) });
  await expect(tip).toBeVisible();
  await expect(tip.getByText('Asked about financing: missed in 3 of the last 3 calls')).toBeVisible();
  const moments = tip.getByRole('list', { name: 'Moments from the calls' }).getByRole('listitem');
  await expect(moments).toHaveCount(2);
  await expect(moments.first().getByText('“Thanks so much, talk soon.”')).toBeVisible();
  expect(n.taps).toBe(1);
  await noGrades(page);
  expect(await axeViolations(page)).toEqual([]);
  await shot(page, 'agent-tip');
  // tap to play: a single-use, audited stream token, played from the quoted moment
  const token = page.waitForResponse((r) => /\/api\/recordings\/[^/]+\/stream-token$/.test(r.url()) && r.request().method() === 'POST');
  await tap(page, moments.first().getByRole('button', { name: 'Play this moment' }), n);
  expect((await token).status()).toBe(200);
  const audio = moments.first().getByLabel('Moment 1 of the call');
  await expect(audio).toBeVisible();
  expect(await audio.getAttribute('src')).toMatch(/\/api\/recordings\/[0-9a-f-]+\/stream\?token=[^#]+#t=\d+(\.\d)?,\d+(\.\d)?$/);
  expect(n.taps).toBe(2);
});

test('Owner: coaching settings say "Not reviewed by counsel" while the pack is unreviewed; Team Lead access goes on in 1 tap', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, seed.owner);
  await stack.fixture('/pack', { cleared: false });
  try {
    const n = { taps: 0 };
    if (isPhone(page)) {
      await tap(page, page.getByRole('link', { name: 'More' }), n);
      await tap(page, page.getByRole('link', { name: 'Coaching settings', exact: true }), n);
      expect(n.taps).toBe(2);
    } else {
      await tap(page, page.getByRole('navigation').getByRole('link', { name: 'Coaching settings', exact: true }), n);
      expect(n.taps).toBe(1);
    }
    await expect(page.getByRole('heading', { level: 1, name: 'Coaching settings' })).toBeVisible();
    await expect(page.getByText('Not reviewed by counsel', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Call reviews are paused' })).toBeVisible();
    await noGrades(page);
    expect(await axeViolations(page)).toEqual([]);
    await shot(page, 'owner-not-reviewed');
  } finally {
    await stack.fixture('/pack', { cleared: true });
  }
  await page.reload();
  await expect(page.getByText('Not reviewed by counsel', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Call reviews are on' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Team Leads do not see their team’s reviews' })).toBeVisible();
  const n = { taps: 0 };
  await tap(page, page.getByRole('button', { name: 'Let Team Leads see them' }), n);
  await expect(page.getByRole('heading', { name: 'Team Leads see their team’s reviews' })).toBeVisible();
  expect(n.taps).toBe(1);
  await shot(page, 'owner-settings');
});

test('Team Lead: sees their team’s tip only because the Owner allowed it', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, seed.teamLead);
  await page.goto(`${stack.webUrl}/coaching`);
  const team = page.getByRole('region', { name: 'Your team' });
  await expect(team).toBeVisible();
  const people = team.getByRole('list', { name: 'Tips by person' });
  await expect(people.getByRole('heading', { level: 3, name: /lender/ })).toBeVisible({ timeout: 15_000 });
  await noGrades(page);
  expect(await axeViolations(page)).toEqual([]);
  await shot(page, 'team-lead');
});

test('agent: "Not now" sets today’s tip aside in 1 tap', async ({ page }) => {
  test.setTimeout(60_000);
  await signIn(page, seed.agent);
  await page.goto(`${stack.webUrl}/coaching`);
  const n = { taps: 0 };
  await tap(page, page.getByRole('button', { name: 'Not now' }), n);
  await expect(page.getByText('You set today’s tip aside. A new one comes tomorrow.')).toBeVisible();
  expect(n.taps).toBe(1);
  await page.goto(`${stack.webUrl}/`);
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
  await expect(page.locator('article').filter({ has: page.getByText("Today's coaching tip", { exact: true }) })).toHaveCount(0);
});

test('Admin: call reviews go off in 1 tap; turning them on, Team Lead access and the checklist stay the Owner’s (E283)', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, seed.admin);
  const n = { taps: 0 };
  if (isPhone(page)) {
    await tap(page, page.getByRole('link', { name: 'More' }), n);
    await tap(page, page.getByRole('link', { name: 'Coaching settings', exact: true }), n);
    expect(n.taps).toBe(2);
  } else {
    await tap(page, page.getByRole('navigation').getByRole('link', { name: 'Coaching settings', exact: true }), n);
    expect(n.taps).toBe(1);
  }
  await expect(page.getByRole('heading', { level: 1, name: 'Coaching settings' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Call reviews are on' })).toBeVisible();
  await expect(page.getByText('Only the Owner can change whether Team Leads see call reviews.')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Checklist items' })).toHaveAccessibleDescription('Only the Owner can change what calls are checked for.');
  await expect(page.getByRole('button', { name: 'Save checklist' })).toHaveCount(0);
  await noGrades(page);
  expect(await axeViolations(page)).toEqual([]);
  const m = { taps: 0 };
  await tap(page, page.getByRole('button', { name: 'Turn call reviews off' }), m);
  await expect(page.getByRole('heading', { name: 'Call reviews are off' })).toBeVisible();
  await expect(page.getByText('Call reviews are off. Today’s tips are gone.')).toBeVisible();
  // the switch is gone (turning call reviews on is the Owner's): focus is on what changed, not lost to <body>
  await expect(page.getByRole('heading', { name: 'Call reviews are off' })).toBeFocused();
  expect(m.taps).toBe(1);
  await expect(page.getByRole('button', { name: 'Turn call reviews on' })).toHaveCount(0);
  await expect(page.getByText('Only the Owner can turn call reviews on.')).toBeVisible();
  await noGrades(page);
  expect(await axeViolations(page)).toEqual([]);
  await shot(page, 'admin-off');
});
