// The People filter builder (lane people-filters) against the REAL API (stack.ts: api/lists on a fresh per-test
// Postgres database, RLS-bound app_user), on the phone (iPhone 13) and desktop (1440 px) projects. Taps are
// counted as PARITY_PLAN §5 counts them (phone from the People tab, desktop from the People page; typing is
// not counted). Agent A's 12 people (stack.ts): active ×4, nurture ×3, new ×2, closed ×1, lost ×2; Zillow ×5,
// Website ×4, no source ×3; DNC on 3, Buyer on 5.
//   filter by stage            phone People → Filter → Stage → Active → Show = 5 · desktop 4
//   exclude a source           phone People → Filter → Source → is not → Zillow → Show = 6 · desktop 5
//   tags has none of           phone People → Filter → Tags → has none of → DNC → Show = 6 · desktop 5
//   combine three filters      phone 14 · desktop 13 ("Add another" opens the field list for the next one)
//   save as list and reopen    Save as list → Save = 2 (+ typing the name); reopen: phone People → list = 2 · 1
//   edit a saved list          People → list → Edit filters → the filter → Nurture → Done → Save changes = 7 · 6
//   bulk-tag the filtered set  after the filter: Select all → Tag → tag → Confirm = 4 (module 64's sheet)
import AxeBuilder from '@axe-core/playwright';
import { type BrowserContext, type Locator, type Page, expect, test } from 'playwright/test';
import { type FiltersStack, startFiltersStack } from './stack.js';

test.describe.configure({ mode: 'serial' });

let stack: FiltersStack;
let world: { agent: { email: string; password: string }; lead: { email: string; password: string }; listId: string };

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startFiltersStack();
  world = await stack.fixture('/world');
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

// sign in once per person and reuse the session (the login rate limit refuses a dozen sign-ins in a row)
const sessions = new Map<string, Awaited<ReturnType<BrowserContext['cookies']>>>();
async function signIn(page: Page, who: { email: string; password: string } = world.agent) {
  const saved = sessions.get(who.email);
  if (saved) {
    await page.context().addCookies(saved);
    await page.goto(`${stack.webUrl}/`);
  } else {
    await page.goto(`${stack.webUrl}/login`);
    await page.getByLabel('Email').fill(who.email);
    await page.getByLabel('Password').fill(who.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
  }
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
  if (!saved) sessions.set(who.email, await page.context().cookies());
}

const peopleNav = (page: Page) => page.getByRole('navigation').getByRole('link', { name: 'People', exact: true }).first();
const sheet = (page: Page) => page.getByRole('dialog');
const countLine = (page: Page, n: number) => page.getByText(new RegExp(`^${n} ${n === 1 ? 'person' : 'people'} · Showing people you can see`));

/** People tab (phone) or the People page (desktop), counted as §5 counts. */
async function toPeople(page: Page, c: { taps: number }) {
  if (isPhone(page)) await tap(page, peopleNav(page), c);
  else await page.goto(`${stack.webUrl}/people`);
  await expect(page.getByRole('heading', { level: 2, name: 'Everyone' })).toBeVisible();
  await expect(countLine(page, 12)).toBeVisible();
}

const peopleTaps = (page: Page, n: number) => (isPhone(page) ? n : n - 1);

test('filter by stage: phone People → Filter → Stage → choose → Show = 5 taps; desktop 4', async ({ page }) => {
  await signIn(page);
  const c = { taps: 0 };
  await toPeople(page, c);
  await tap(page, page.getByRole('button', { name: 'Filter', exact: true }), c);
  await tap(page, sheet(page).getByRole('button', { name: 'Stage', exact: true }), c);
  await tap(page, sheet(page).getByRole('checkbox', { name: 'Active' }), c);
  const show = sheet(page).getByRole('button', { name: 'Show 4 people' });
  await expect(show).toBeVisible(); // the live count of exactly what will be shown
  await tap(page, show, c);
  await expect(countLine(page, 4)).toBeVisible();
  await expect(page.getByRole('list', { name: 'Active filters' }).getByRole('button', { name: 'Remove filter Stage is Active' })).toBeVisible();
  expect(c.taps).toBe(peopleTaps(page, 5));
});

test('exclude a source: People → Filter → Source → is not → Zillow → Show = 6 taps (desktop 5); people with no source stay in', async ({ page }) => {
  await signIn(page);
  const c = { taps: 0 };
  await toPeople(page, c);
  await tap(page, page.getByRole('button', { name: 'Filter', exact: true }), c);
  await tap(page, sheet(page).getByRole('button', { name: 'Source', exact: true }), c);
  await tap(page, sheet(page).getByText('is not', { exact: true }), c);
  await tap(page, sheet(page).getByRole('checkbox', { name: 'Zillow' }), c);
  await tap(page, sheet(page).getByRole('button', { name: 'Show 7 people' }), c);
  await expect(countLine(page, 7)).toBeVisible(); // 4 Website + 3 with no source (E195)
  await expect(page.getByRole('button', { name: 'Remove filter Source is not Zillow' })).toBeVisible();
  expect(c.taps).toBe(peopleTaps(page, 6));
});

test('tags has none of: People → Filter → Tags → has none of → DNC → Show = 6 taps (desktop 5)', async ({ page }) => {
  await signIn(page);
  const c = { taps: 0 };
  await toPeople(page, c);
  await tap(page, page.getByRole('button', { name: 'Filter', exact: true }), c);
  await tap(page, sheet(page).getByRole('button', { name: 'Tags', exact: true }), c);
  await tap(page, sheet(page).getByText('has none of', { exact: true }), c);
  await tap(page, sheet(page).getByRole('checkbox', { name: 'DNC' }), c);
  await tap(page, sheet(page).getByRole('button', { name: 'Show 9 people' }), c);
  await expect(countLine(page, 9)).toBeVisible();
  expect(c.taps).toBe(peopleTaps(page, 6));
});

test('combine three filters (stage is not Lost, source is not Website, tags has none of DNC) = 14 taps (desktop 13); chips remove one at a time; Clear all', async ({ page }) => {
  await signIn(page);
  const c = { taps: 0 };
  await toPeople(page, c);
  await tap(page, page.getByRole('button', { name: 'Filter', exact: true }), c);
  const s = sheet(page);
  await tap(page, s.getByRole('button', { name: 'Stage', exact: true }), c);
  await tap(page, s.getByText('is not', { exact: true }), c);
  await tap(page, s.getByRole('checkbox', { name: 'Lost' }), c);
  await tap(page, s.getByRole('button', { name: 'Add another' }), c);
  await tap(page, s.getByRole('button', { name: 'Source', exact: true }), c);
  await tap(page, s.getByText('is not', { exact: true }), c);
  await tap(page, s.getByRole('checkbox', { name: 'Website' }), c);
  await tap(page, s.getByRole('button', { name: 'Add another' }), c);
  await tap(page, s.getByRole('button', { name: 'Tags', exact: true }), c);
  await tap(page, s.getByText('has none of', { exact: true }), c);
  await tap(page, s.getByRole('checkbox', { name: 'DNC' }), c);
  await tap(page, s.getByRole('button', { name: 'Show 6 people' }), c);
  await expect(countLine(page, 6)).toBeVisible();
  expect(c.taps).toBe(peopleTaps(page, 14));
  const chips = page.getByRole('list', { name: 'Active filters' });
  await chips.getByRole('button', { name: 'Remove filter Tags has none of DNC' }).click();
  await expect(countLine(page, 7)).toBeVisible();
  await chips.getByRole('button', { name: 'Clear all' }).click();
  await expect(countLine(page, 12)).toBeVisible();
});

test('the name box narrows inside a filter; an empty result names the filters to loosen', async ({ page }) => {
  await signIn(page);
  await page.goto(`${stack.webUrl}/people`);
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await sheet(page).getByRole('button', { name: 'Stage', exact: true }).click();
  await sheet(page).getByRole('checkbox', { name: 'Closed' }).click();
  await sheet(page).getByRole('button', { name: 'Show 1 person' }).click();
  await expect(countLine(page, 1)).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search people by name' }).fill('zzz nobody');
  await expect(countLine(page, 0)).toBeVisible();
  await expect(page.getByText('No one you can see matches all of these filters. Try removing Stage is Closed or Name contains “zzz nobody”.')).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search people by name' }).fill('');
  await expect(countLine(page, 1)).toBeVisible();
});

test('save as list and reopen: Save as list → Save = 2 taps (+ the name); reopen from the lists = phone People → list = 2, desktop 1', async ({ page }) => {
  await signIn(page);
  await page.goto(`${stack.webUrl}/people`);
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await sheet(page).getByRole('button', { name: 'Source', exact: true }).click();
  await sheet(page).getByText('is not', { exact: true }).click();
  await sheet(page).getByRole('checkbox', { name: 'Zillow' }).click();
  await sheet(page).getByRole('button', { name: 'Show 7 people' }).click();
  const c = { taps: 0 };
  await tap(page, page.getByRole('button', { name: 'Save as list' }), c);
  await sheet(page).getByLabel('Name').fill('Not from Zillow');
  await tap(page, sheet(page).getByRole('button', { name: 'Save' }), c);
  await expect(page.getByRole('heading', { level: 2, name: 'Not from Zillow' })).toBeVisible();
  await expect(countLine(page, 7)).toBeVisible();
  expect(c.taps).toBe(2);
  // reopen: away and back
  await page.goto(`${stack.webUrl}/`);
  const r = { taps: 0 };
  if (isPhone(page)) await tap(page, peopleNav(page), r);
  else await page.goto(`${stack.webUrl}/people`);
  await tap(page, page.getByRole('navigation', { name: 'Lists' }).getByRole('button', { name: 'Not from Zillow' }), r);
  await expect(countLine(page, 7)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove filter Source is not Zillow' })).toBeVisible();
  expect(r.taps).toBe(isPhone(page) ? 2 : 1);
});

test('edit a saved list\'s filters: People → list → Edit filters → the filter → add Nurture → Done → Save changes = 7 taps (desktop 6); the list keeps the change', async ({ page }) => {
  await signIn(page);
  const c = { taps: 0 };
  if (isPhone(page)) await tap(page, peopleNav(page), c);
  else await page.goto(`${stack.webUrl}/people`);
  await tap(page, page.getByRole('navigation', { name: 'Lists' }).getByRole('button', { name: 'Active buyers' }), c);
  await expect(countLine(page, 4)).toBeVisible();
  await tap(page, page.getByRole('button', { name: /^Edit filters/ }), c);
  await tap(page, sheet(page).getByRole('button', { name: 'Change filter Stage is Active' }), c);
  await tap(page, sheet(page).getByRole('checkbox', { name: 'Nurture' }), c);
  await tap(page, sheet(page).getByRole('button', { name: 'Done' }), c);
  await tap(page, sheet(page).getByRole('button', { name: 'Save changes to “Active buyers”' }), c);
  await expect(sheet(page)).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 2, name: 'Active buyers' })).toBeVisible();
  await expect(countLine(page, 7)).toBeVisible();
  expect(c.taps).toBe(isPhone(page) ? 7 : 6);
  await page.reload();
  await expect(countLine(page, 7)).toBeVisible();
});

test('bulk-tag the filtered set: the selection is the filter; Select all → Tag → tag → Confirm = 4 taps after the filter', async ({ page }) => {
  await signIn(page);
  await page.goto(`${stack.webUrl}/people`);
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await sheet(page).getByRole('button', { name: 'Tags', exact: true }).click();
  await sheet(page).getByText('has none of', { exact: true }).click();
  await sheet(page).getByRole('checkbox', { name: 'DNC' }).click();
  await sheet(page).getByRole('button', { name: 'Show 9 people' }).click();
  await expect(countLine(page, 9)).toBeVisible();
  const c = { taps: 0 };
  await tap(page, page.getByRole('checkbox', { name: /Select all/ }), c);
  const bar = page.getByRole('region', { name: 'Bulk actions' });
  await expect(bar.getByText('9 selected')).toBeVisible();
  await tap(page, bar.getByRole('button', { name: 'Tag', exact: true }), c);
  await tap(page, sheet(page).getByRole('button', { name: 'Investor' }), c);
  const confirm = page.getByRole('dialog', { name: 'Tag 9 of 9?' });
  await expect(confirm).toBeVisible();
  await tap(page, confirm.getByRole('button', { name: 'Tag 9 people' }), c);
  await expect(page.getByText(/Started: 9 people/)).toBeVisible();
  expect(c.taps).toBe(4);
});

test('R-PAR-27: a Team Lead\'s filter with a name search cannot be saved as a team list, in plain words; as their own list it can', async ({ page }) => {
  await signIn(page, world.lead);
  await page.goto(`${stack.webUrl}/people`);
  await page.getByRole('searchbox', { name: 'Search people by name' }).fill('Alice');
  await expect(page.getByRole('button', { name: 'Save as list' })).toBeVisible();
  await page.getByRole('button', { name: 'Save as list' }).click();
  await sheet(page).getByLabel('Name').fill('Alices');
  await sheet(page).getByText('My team (each person sees only their own people)').click();
  await expect(sheet(page).getByText("Team lists can't include typed text. Remove the name search or save it as your own list.")).toBeVisible();
  await expect(sheet(page).getByRole('button', { name: 'Save' })).toBeDisabled();
  await sheet(page).getByText('Only me').click();
  await sheet(page).getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Alices' })).toBeVisible();
});

test('the Search page links to the filter builder ("Filter people") and the builder opens on the field list', async ({ page }) => {
  await signIn(page);
  await page.goto(`${stack.webUrl}/search`);
  await page.getByRole('link', { name: 'Filter people' }).click();
  await expect(sheet(page).getByRole('heading', { name: 'Add a filter' })).toBeVisible();
  await expect(sheet(page).getByRole('button', { name: 'Stage', exact: true })).toBeVisible();
});

test('the People page with the builder: every control is at least 44 px; no horizontal scroll on a phone; desktop shows a side panel', async ({ page }) => {
  await signIn(page);
  await page.goto(`${stack.webUrl}/people`);
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await sheet(page).getByRole('button', { name: 'Stage', exact: true }).click();
  await sheet(page).getByRole('checkbox', { name: 'Active' }).click();
  await sheet(page).getByRole('button', { name: 'Add another' }).click();
  const small = await page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('[role="dialog"] button, [role="dialog"] label:has(input), main button, main a[href]')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (el.closest('[inert]')) continue;
      if (r.height < 43.5 || r.width < 43.5) out.push(`${el.tagName} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}" ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
    return out;
  });
  expect(small).toEqual([]);
  const box = (await sheet(page).boundingBox())!;
  if (isPhone(page)) {
    expect(Math.round(box.y + box.height)).toBeGreaterThanOrEqual(page.viewportSize()!.height - 2); // a bottom sheet
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  } else {
    expect(Math.round(box.x + box.width)).toBe(1440); // a side panel on the right, full height
    expect(Math.round(box.height)).toBe(900);
  }
});

// the a11y sweep's tags (e2e/a11y/a11y.spec.ts AXE_TAGS): WCAG 2.0/2.1/2.2 A and AA plus axe best practice
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
async function axe(page: Page): Promise<string[]> {
  const r = await new AxeBuilder({ page: page as never }).withTags(AXE_TAGS).analyze();
  return r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

test('the filter builder passes axe at every step (fields, values, the filter list), with chips and the empty state, in light and dark', async ({ page }) => {
  await signIn(page);
  const found: string[] = [];
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(`${stack.webUrl}/people?filter=open`);
    await expect(sheet(page).getByRole('heading', { name: 'Add a filter' })).toBeVisible();
    found.push(...(await axe(page)).map((v) => `${scheme} fields: ${v}`));
    await sheet(page).getByRole('button', { name: 'Source', exact: true }).click();
    await sheet(page).getByText('is not', { exact: true }).click();
    await sheet(page).getByRole('checkbox', { name: 'Zillow' }).click();
    await expect(sheet(page).getByRole('button', { name: 'Show 7 people' })).toBeVisible();
    found.push(...(await axe(page)).map((v) => `${scheme} values: ${v}`));
    await sheet(page).getByRole('button', { name: 'Add another' }).click();
    await sheet(page).getByRole('button', { name: 'Back to filters' }).click();
    await expect(sheet(page).getByRole('list', { name: 'Filters' })).toBeVisible();
    found.push(...(await axe(page)).map((v) => `${scheme} list: ${v}`));
    await sheet(page).getByRole('button', { name: 'Show 7 people' }).click();
    await expect(page.getByRole('list', { name: 'Active filters' })).toBeVisible();
    await page.getByRole('searchbox', { name: 'Search people by name' }).fill('zzz nobody');
    await expect(countLine(page, 0)).toBeVisible();
    found.push(...(await axe(page)).map((v) => `${scheme} empty: ${v}`));
  }
  expect(found).toEqual([]);
});

/** Each control of the bulk bar: its label and the top of its row. */
async function barRows(page: Page): Promise<{ label: string; top: number; right: number }[]> {
  return page.getByRole('region', { name: 'Bulk actions' }).evaluate((el) =>
    [...el.querySelectorAll('p, button')].map((b) => {
      const r = b.getBoundingClientRect();
      return { label: (b.textContent ?? '').trim(), top: Math.round(r.top), right: Math.round(r.right) };
    }),
  );
}

test('the bulk bar fits on one row at 1440 px for an agent and a Team Lead (Clear never wraps); on a phone it stays one sideways-scrolling row above the tab bar', async ({ page }) => {
  for (const who of [world.agent, world.lead]) {
    await page.context().clearCookies();
    await signIn(page, who);
    await page.goto(`${stack.webUrl}/people`);
    await page.getByRole('checkbox', { name: /^Select Alice/ }).first().check();
    const bar = page.getByRole('region', { name: 'Bulk actions' });
    await expect(bar.getByRole('button', { name: 'Clear' })).toBeAttached();
    const rows = await barRows(page);
    const labels = rows.map((r) => r.label);
    expect(labels).toEqual(expect.arrayContaining(['Tag', 'Start plan', 'Remove tag', 'Change stage', 'Email', 'Clear']));
    if (who === world.lead) expect(labels).toContain('Assign');
    const box = (await bar.boundingBox())!;
    if (isPhone(page)) {
      // one row (it scrolls sideways), wholly inside the window, above the tab bar
      expect(new Set(rows.map((r) => r.top)).size).toBeLessThanOrEqual(2); // the count text centres a few px lower
      expect(Math.max(...rows.map((r) => r.top)) - Math.min(...rows.map((r) => r.top))).toBeLessThan(20);
      const tabs = (await page.getByRole('navigation', { name: 'Main tabs' }).boundingBox())!;
      expect(Math.round(box.y + box.height)).toBeLessThanOrEqual(Math.round(tabs.y) + 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    } else {
      // every control on the same row, inside the bar, the bar inside the window
      const buttons = rows.filter((r) => r.label !== '' && !/selected$/.test(r.label));
      expect(Math.max(...buttons.map((r) => r.top)) - Math.min(...buttons.map((r) => r.top)), JSON.stringify(rows)).toBe(0);
      expect(Math.max(...rows.map((r) => r.right))).toBeLessThanOrEqual(Math.round(box.x + box.width));
      expect(box.x + box.width).toBeLessThanOrEqual(1440);
      await expect(bar).toBeInViewport();
    }
  }
});
