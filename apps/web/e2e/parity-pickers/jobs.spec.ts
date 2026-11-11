// The People bar's Assign and Start plan, and the stage-to-plan setting, against the REAL API (stack.ts), on
// the phone (iPhone 13, 390×844) and desktop (1440×900) projects. Taps are counted from the People tab as
// PARITY_PLAN §5 counts them, and a counted tap never hides a swipe: its target must already be wholly in
// view (tap() below), because Playwright's tap() and click() scroll a hidden target into view by themselves
// (the phone's one-row bulk bar scrolls sideways):
//   bulk assign (Team Lead): phone People → list → Select all → Assign → person → Confirm = 6 · desktop 5
//     (§5 "Bulk assign (Owner/Admin/TL)": 6 / 5), with no swipe; the run moves everyone through the
//     ownership engine
//   bulk Start plan (agent): the same shape, 6 · 5, with no swipe (§5 has no row for it; FUB's bulk action
//     plan VERIFY), with who is left out and why (already in a plan, can't be reached, not yours) shown
//     before Confirm, and the run enrolling from the approved version with enrolled_by "bulk"
//   the stage-to-plan setting: saved, shown after a reload, a taken stage refused in plain words
// Then axe-core (contrast included) in light and dark on the new sheets and the setting, 44 px targets.
// Screenshots when PICKERS_SHOTS_DIR is set.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { type Locator, type Page, expect, test } from 'playwright/test';
import { type PickersStack, type PickersWorld, type Who, startPickersStack } from './stack.js';

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');
const SHOTS = process.env.PICKERS_SHOTS_DIR ?? '';

test.describe.configure({ mode: 'serial' });

let stack: PickersStack;
let world: PickersWorld;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startPickersStack();
  world = await stack.fixture('/world');
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});
test.afterAll(async () => {
  await stack?.stop();
});

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 768;

/**
 * One counted tap. The target must be wholly in view first: IntersectionObserver (toBeInViewport) counts
 * clipping by a scrolled container such as the bulk bar, so a target behind the bar's edge fails here instead
 * of being scrolled into view by Playwright, a swipe the count would not see.
 */
async function tap(page: Page, target: Locator, counter: { taps: number }) {
  await expect(target, 'a counted tap needs its target in view without a swipe or scroll').toBeInViewport({ ratio: 1 });
  if (isPhone(page)) await target.tap();
  else await target.click();
  counter.taps += 1;
}

async function signIn(page: Page, who: Who) {
  const u = world.users[who];
  await page.goto(`${stack.webUrl}/login`);
  await page.getByLabel('Email').fill(u.email);
  await page.getByLabel('Password').fill(u.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  if (u.mfa) {
    await page.getByLabel('Code').fill((await stack.fixture<{ code: string }>('/totp', { email: u.email })).code);
    await page.getByRole('button', { name: 'Continue' }).click();
  }
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible({ timeout: 15_000 });
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.screenshot({ path: `${SHOTS}/${isPhone(page) ? 'phone' : 'desktop'}-${name}.png` });
}

async function axeViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async () => {
    const r = await (window as unknown as { axe: { run(ctx: Document, o: object): Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe.run(document, { resultTypes: ['violations'] });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
}

/** Visible controls under `scope` smaller than 44 px in either direction (text links inside sentences excepted). */
async function smallTargets(page: Page, scope: string): Promise<string[]> {
  return page.locator(`${scope} button:visible, ${scope} a[href]:visible, ${scope} select:visible, ${scope} label:has(input):visible`).evaluateAll((els) =>
    els
      .map((e) => ({ t: ((e as HTMLElement).innerText || e.getAttribute('aria-label') || e.tagName).trim().slice(0, 30), r: e.getBoundingClientRect() }))
      .filter((x) => x.r.height > 0 && (Math.round(x.r.height) < 44 || Math.round(x.r.width) < 44))
      .map((x) => `${x.t} ${Math.round(x.r.width)}×${Math.round(x.r.height)}`),
  );
}

/** The People nav entry: the phone tab bar or the desktop sidebar. */
const peopleNav = (page: Page) => page.getByRole('navigation').getByRole('link', { name: 'People', exact: true }).first();
const listButton = (page: Page, name: string) => page.getByRole('navigation', { name: 'Lists' }).getByRole('button', { name });

/** People (phone: the tab, 1 tap; desktop: the page is open) → the list (1 tap). */
async function openList(page: Page, name: string, c: { taps: number }, count: number) {
  if (isPhone(page)) await tap(page, peopleNav(page), c);
  else await page.goto(`${stack.webUrl}/people`);
  await expect(page.getByRole('heading', { level: 2, name: 'Everyone' })).toBeVisible();
  await tap(page, listButton(page, name), c);
  await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
  await expect(page.getByText(new RegExp(`^${count} people · Showing people you can see`))).toBeVisible();
}

test('bulk assign (Team Lead): People → list → Select all → Assign → person → Confirm = 6 taps on a phone, 5 on desktop; only the Team Lead and their team are offered; the run moves everyone', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, 'team_lead');
  const c = { taps: 0 };
  await openList(page, 'Open house', c, 6);
  await tap(page, page.getByRole('checkbox', { name: /Select all/ }), c);
  const bar = page.getByRole('region', { name: 'Bulk actions' });
  await expect(bar.getByText('6 selected')).toBeVisible();
  // Assign and Start plan come right after Tag, so a phone shows them without a swipe; the rest follow
  await expect(bar.getByRole('button')).toHaveText(['Tag', 'Assign', 'Start plan', 'Remove tag', 'Change stage', 'Email', 'Clear']);
  if (isPhone(page)) {
    // the one-row bar scrolls sideways: Assign is wholly in view (tap() checks it); Start plan, third for a Team
    // Lead, shows most of itself at the bar's edge, tappable without a swipe; the rest may sit behind the scroll
    await expect(bar.getByRole('button', { name: 'Start plan' })).toBeInViewport({ ratio: 0.5 });
  } else {
    // desktop: every action is in view (the bar wraps)
    const clipped = await bar.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return [...el.querySelectorAll('button')].filter((b) => b.getBoundingClientRect().right > box.right + 1).map((b) => b.textContent);
    });
    expect(clipped).toEqual([]);
  }
  await shot(page, 'bar');
  await tap(page, bar.getByRole('button', { name: 'Assign', exact: true }), c);
  const picker = page.getByRole('dialog', { name: 'Assign 6 people' }).getByRole('region', { name: 'Assign to' });
  await expect(picker.getByRole('button')).toHaveText(['Ana Diaz', 'Bo Park', 'Sam Rivera (you)']); // never the Owner, Admin or TC
  await shot(page, 'assign-picker');
  await tap(page, picker.getByRole('button', { name: 'Bo Park' }), c);
  const sheet = page.getByRole('dialog', { name: 'Assign 6 of 6?' });
  await expect(sheet.getByText('6 of 6 selected will be assigned to Bo Park.')).toBeVisible();
  await expect(sheet.getByText('Each one moves to Bo Park under the same rules as assigning one lead. Bo Park and each current owner other than you get one notice for the whole group, not one per lead.')).toBeVisible();
  await shot(page, 'assign-confirm');
  await tap(page, sheet.getByRole('button', { name: 'Assign 6 people' }), c);
  await expect(page.getByText(/Started: 6 people/)).toBeVisible();
  expect(c.taps).toBe(isPhone(page) ? 6 : 5);
  // the real runner, one ownership command per person (as the Team Lead)
  const id = new URL(await page.getByRole('link', { name: 'See progress' }).getAttribute('href') ?? '', stack.webUrl).pathname.split('/').at(-1)!;
  expect((await stack.fixture<{ result: unknown }>('/run', { actionId: id })).result).toEqual({ kind: 'finished', status: 'completed' });
  const owners = (await stack.fixture<{ rows: { owner_user_id: string }[] }>('/owners', { ids: world.ids.assign })).rows;
  expect(owners.map((o) => o.owner_user_id)).toEqual(world.ids.assign.map(() => world.users.bo.userId));
  // what the sheet said: one notice each to Bo and to Ana (their current owner), none to the Team Lead who ran it
  const { users } = world;
  expect((await stack.fixture<{ rows: unknown[] }>('/notices', { subjectId: id })).rows).toEqual([
    { user_id: users.team_lead.userId, kind: 'bulk_finished', title: 'Assigned 6 of 6' },
    { user_id: users.ana.userId, kind: 'reassigned_away', title: '6 of your leads were reassigned' },
    { user_id: users.bo.userId, kind: 'reassigned_to_you', title: '6 leads were assigned to you' },
  ]);
});

test('the Owner\'s person picker: every active member who can hold leads (never the TC), the Owner included', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, 'owner');
  await page.goto(`${stack.webUrl}/people`);
  await page.getByRole('checkbox', { name: 'Select Ada Open' }).check();
  await page.getByRole('region', { name: 'Bulk actions' }).getByRole('button', { name: 'Assign', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Assign 1 person' }).getByRole('region', { name: 'Assign to' });
  await expect(picker.getByRole('button')).toHaveText(['Adam Alvarez', 'Ana Diaz', 'Bo Park', 'Olivia Owens (you)', 'Sam Rivera']);
  await expect(picker.getByRole('button', { name: 'Theo Clark' })).toHaveCount(0);
});

test('bulk Start plan (agent): People → list → Select all → Start plan → plan → Confirm = 6 taps on a phone, 5 on desktop; who is left out and why is shown before Confirm; the run enrolls from the approved version as "bulk"', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, 'ana');
  const c = { taps: 0 };
  await openList(page, 'Buyers', c, 7);
  await tap(page, page.getByRole('checkbox', { name: /Select all/ }), c);
  const bar = page.getByRole('region', { name: 'Bulk actions' });
  await expect(bar.getByRole('button', { name: 'Assign', exact: true })).toHaveCount(0); // agents never assign
  await tap(page, bar.getByRole('button', { name: 'Start plan' }), c);
  const plans = page.getByRole('dialog', { name: 'Enroll 7 people' }).getByRole('region', { name: 'Plans' });
  // approved plans Ana may start: the team's and her own; never a draft-only plan or Bo's plan
  await expect(plans.getByRole('button')).toHaveCount(4);
  for (const n of ['Buyer plan', 'Contract plan', 'Second plan', "Ana's check-ins"]) await expect(plans.getByRole('button', { name: new RegExp(`^${n}`) })).toBeVisible();
  await expect(plans.getByRole('button', { name: /Draft plan|Bo's plan/ })).toHaveCount(0);
  await expect(plans.getByRole('button', { name: /^Ana's check-ins/ })).toContainText('Your plan, for people you own');
  await shot(page, 'plan-picker');
  await tap(page, plans.getByRole('button', { name: /^Buyer plan/ }), c);
  const sheet = page.getByRole('dialog', { name: 'Enroll 5 of 7?' });
  await expect(sheet.getByText('5 of 7 selected will start “Buyer plan”.')).toBeVisible();
  const left = sheet.getByRole('region', { name: 'Left out (2)' });
  await expect(left.locator('[data-reason="ALREADY_ENROLLED"]')).toHaveText('1 are already in a plan');
  await expect(left.locator('[data-reason="UNREACHABLE"]')).toHaveText("1 can't be reached by text or email");
  await expect(sheet.getByRole('checkbox')).toHaveCount(0); // nothing to pre-tick
  await shot(page, 'plan-confirm');
  await tap(page, sheet.getByRole('button', { name: 'Enroll 5 people' }), c);
  await expect(page.getByText(/Started: 5 people/)).toBeVisible();
  expect(c.taps).toBe(isPhone(page) ? 6 : 5);
  const id = new URL(await page.getByRole('link', { name: 'See progress' }).getAttribute('href') ?? '', stack.webUrl).pathname.split('/').at(-1)!;
  expect((await stack.fixture<{ result: unknown }>('/run', { actionId: id })).result).toEqual({ kind: 'finished', status: 'completed' });
  const { ids, users } = world;
  const rows = (await stack.fixture<{ rows: { contact_id: string; playbook_id: string; enrolled_by: string; enrolled_by_user_id: string }[] }>('/enrollments', { ids: [...ids.buyers, ids.vic, ids.pat, ids.uma] })).rows;
  const of = (cid: string) => rows.filter((r) => r.contact_id === cid);
  for (const cid of [...ids.buyers, ids.vic]) expect(of(cid)).toEqual([{ contact_id: cid, playbook_id: ids.buyerPlan, enrolled_by: 'bulk', enrolled_by_user_id: users.ana.userId }]);
  expect(of(ids.pat).map((r) => r.playbook_id)).toEqual([ids.anaPlan]); // still only in the plan they were in
  expect(of(ids.uma)).toEqual([]); // opted out: never started
});

test('Start plan: someone checked who is no longer yours is left out as not visible, and with nobody left there is nothing to confirm', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, 'ana');
  await page.goto(`${stack.webUrl}/people`);
  await listButton(page, 'Buyers').click();
  await page.getByRole('checkbox', { name: 'Select Vic Moved' }).check();
  await stack.fixture('/reassign', { contactId: world.ids.vic }); // the Owner gives Vic to Bo meanwhile
  await page.getByRole('region', { name: 'Bulk actions' }).getByRole('button', { name: 'Start plan' }).click();
  await page.getByRole('dialog').getByRole('region', { name: 'Plans' }).getByRole('button', { name: /^Buyer plan/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Enroll 0 of 1?' });
  await expect(sheet.getByRole('region', { name: 'Left out (1)' }).locator('[data-reason="NOT_VISIBLE"]')).toHaveText("1 aren't yours to reach");
  await expect(sheet.getByRole('button', { name: 'Enroll 0 people' })).toBeDisabled();
  await expect(sheet.getByText('Everyone selected is left out, so there is nothing to enroll.')).toBeVisible();
});

test('the stage-to-plan setting: the Owner picks "Active buyer" (the tenant\'s label) for the team Buyer plan; it is saved and shown after a reload; the same stage on another team plan is refused in plain words', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, 'owner');
  await page.goto(`${stack.webUrl}/settings/playbooks/${world.ids.buyerPlan}`);
  const select = page.getByLabel('Start this plan when a person enters stage');
  await expect(select).toHaveValue('');
  await expect(select.locator('option')).toHaveText(['No stage', 'New', 'Attempting', 'Connected', 'Nurture', 'Active buyer', 'Under contract', 'Closed', 'Lost']);
  await select.selectOption({ label: 'Active buyer' });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved. This playbook now starts when a person enters “Active buyer”.')).toBeVisible();
  expect((await stack.fixture<{ stage: string }>('/stage', { playbookId: world.ids.buyerPlan })).stage).toBe('active');
  await shot(page, 'stage-saved');
  await page.reload();
  await expect(page.getByLabel('Start this plan when a person enters stage')).toHaveValue('active');
  await expect(page.getByLabel('Start this plan when a person enters stage').locator('option:checked')).toHaveText('Active buyer');
  // one team plan per stage: the second is refused, in words, with the way to the plan that holds it
  await page.goto(`${stack.webUrl}/settings/playbooks/${world.ids.secondPlan}`);
  await page.getByLabel('Start this plan when a person enters stage').selectOption('active');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const refused = page.getByRole('alert');
  await expect(refused).toContainText('Another team playbook already starts when a person enters “Active buyer”. Clear the stage on that playbook first, or pick another one.');
  await shot(page, 'stage-taken');
  expect((await stack.fixture<{ stage: string | null }>('/stage', { playbookId: world.ids.secondPlan })).stage).toBeNull();
  await refused.getByRole('link', { name: 'Open that playbook' }).click();
  await expect(page).toHaveURL(new RegExp(`/settings/playbooks/${world.ids.buyerPlan}$`));
  await expect(page.getByRole('heading', { level: 2, name: 'Buyer plan' })).toBeVisible();
});

test('the stage-to-plan setting for an agent: their own plan is theirs to set (it covers only people they own); a team plan only says the stage it starts on', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, 'ana');
  await page.goto(`${stack.webUrl}/settings/playbooks/${world.ids.anaPlan}`);
  await expect(page.getByText(/It covers only people you own\./)).toBeVisible();
  await page.getByLabel('Start this plan when a person enters stage').selectOption('nurture');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved. This playbook now starts when a person enters “Nurture”.')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Start this plan when a person enters stage')).toHaveValue('nurture');
  await page.goto(`${stack.webUrl}/settings/playbooks/${world.ids.contractPlan}`);
  await expect(page.getByText(/Starts on its own when a person enters “Under contract”\./)).toBeVisible();
  await expect(page.getByText('An Owner or Admin can change this.')).toBeVisible();
  await expect(page.getByLabel('Start this plan when a person enters stage')).toHaveCount(0);
  await shot(page, 'stage-read-only');
});

test('the new sheets and the setting: axe (contrast included) in light and dark, 44 px targets, no sideways scroll on a phone', async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page, 'owner');
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(`${stack.webUrl}/people`);
    await page.getByRole('checkbox', { name: /Select all/ }).check();
    const bar = page.getByRole('region', { name: 'Bulk actions' });
    await bar.getByRole('button', { name: 'Assign', exact: true }).click();
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Bo Park' })).toBeVisible();
    expect(await axeViolations(page), `${scheme} assign picker`).toEqual([]);
    expect(await smallTargets(page, '[role="dialog"]'), `${scheme} assign picker targets`).toEqual([]);
    await page.getByRole('dialog').getByRole('button', { name: 'Bo Park' }).click();
    await expect(page.getByRole('dialog').getByRole('button', { name: /^Assign \d+ people$/ })).toBeVisible();
    expect(await axeViolations(page), `${scheme} assign confirm`).toEqual([]);
    expect(await smallTargets(page, '[role="dialog"]'), `${scheme} assign confirm targets`).toEqual([]);
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await bar.getByRole('button', { name: 'Start plan' }).click();
    await expect(page.getByRole('dialog').getByRole('button', { name: /^Buyer plan/ })).toBeVisible();
    expect(await axeViolations(page), `${scheme} plan picker`).toEqual([]);
    expect(await smallTargets(page, '[role="dialog"]'), `${scheme} plan picker targets`).toEqual([]);
    await page.getByRole('dialog').getByRole('button', { name: /^Contract plan/ }).click();
    await expect(page.getByRole('dialog').getByRole('region', { name: /^Left out/ })).toBeVisible();
    expect(await axeViolations(page), `${scheme} plan confirm`).toEqual([]);
    expect(await smallTargets(page, '[role="dialog"]'), `${scheme} plan confirm targets`).toEqual([]);
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    if (isPhone(page)) {
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 'sideways scroll on People').toBeLessThanOrEqual(0);
      expect(await smallTargets(page, '[aria-label="Bulk actions"]'), `${scheme} bulk bar targets`).toEqual([]);
    }
    // the setting, and its refusal
    await page.goto(`${stack.webUrl}/settings/playbooks/${world.ids.secondPlan}`);
    await page.getByLabel('Start this plan when a person enters stage').selectOption('active');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(await axeViolations(page), `${scheme} stage setting`).toEqual([]);
    expect(await smallTargets(page, '#auto-enroll-stage'), `${scheme} stage setting targets`).toEqual([]);
    if (isPhone(page)) expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 'sideways scroll on the playbook').toBeLessThanOrEqual(0);
  }
});
