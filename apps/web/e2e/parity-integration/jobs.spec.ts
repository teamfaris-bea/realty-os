// The FUB-parity lanes wired together, against the REAL API (stack.ts), on the phone (iPhone 13, 390×844)
// and desktop (1440×900) projects. Each job runs end to end through the real interfaces, with its taps
// counted against PARITY_PLAN §5 where §5 has a target:
//   bulk tag 30 from a smart list: People → list → Select all → Tag → tag = 5 on a phone (4 on desktop)
//     reaches module 64's count sheet with the frozen target (module 60's resolveSelection), and Confirm in
//     it starts the job at 6 (5). §5's target, 5 (4) with "count sheet confirms inline", is NOT met: module
//     64 always previews and asks for Confirm (R-PAR-33: create, preview, confirm). That is an owner
//     decision (ARCHITECTURE, parity gaps), so the spec asserts what is built. The real runner tags all 30
//   tags on the person's page (module 61's chips in module 58's section registry): + → tag = 2 on a phone
//     (+ → ↵ = 1 on desktop); remove with the chip's ×
//   the opt-out-looking tag prompt: "DNC" saves a tag, and "Record do not contact" is ONE tap through
//     module 57's POST /contacts/:id/do-not-contact (tighten-only: no Undo)
//   stage labels: saved on Admin → Stage labels (module 57's PUT /stage-labels), shown on the stage pill
//   an import that creates tags and typed custom fields through module 60's writers, then reverts cleanly
import { type Locator, type Page, expect, test } from 'playwright/test';
import { type ParityStack, startParityStack } from './stack.js';

test.describe.configure({ mode: 'serial' });

interface World {
  agent: { email: string; password: string };
  admin: { email: string; password: string };
  listId: string;
  janeId: string;
  firstListPerson: string;
}

let stack: ParityStack;
let world: World;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startParityStack();
  world = await stack.fixture<World>('/world');
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

async function signIn(page: Page, who: { email: string; password: string }) {
  await page.goto(`${stack.webUrl}/login`);
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const code = (await stack.fixture<{ code: string | null }>('/totp', { email: who.email })).code;
  if (code) {
    await page.getByLabel('Code').fill(code);
    await page.getByRole('button', { name: 'Continue' }).click();
  }
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible({ timeout: 15_000 });
}

const peopleNav = (page: Page) => page.getByRole('navigation').getByRole('link', { name: 'People', exact: true }).first();

test('bulk tag 30 from a smart list through the People bulk bar and module 64\'s real sheet: phone 5 taps (desktop 4) to the count sheet, 6 (5) to start, one over PARITY_PLAN §5; the runner tags all 30', async ({ page }) => {
  await signIn(page, world.agent);
  const c = { taps: 0 };
  if (isPhone(page)) await tap(page, peopleNav(page), c);
  else await page.goto(`${stack.webUrl}/people`);
  await tap(page, page.getByRole('navigation', { name: 'Lists' }).getByRole('button', { name: 'Hot buyers' }), c);
  await expect(page.getByText(/^30 people · Showing people you can see/)).toBeVisible();
  await tap(page, page.getByRole('checkbox', { name: /Select all/ }), c);
  const bar = page.getByRole('region', { name: 'Bulk actions' });
  await expect(bar.getByText('30 selected')).toBeVisible();
  await tap(page, bar.getByRole('button', { name: 'Tag', exact: true }), c);
  await tap(page, page.getByRole('dialog').getByRole('button', { name: 'Investor' }), c);
  // the server resolved the whole list (not the page's rows) and froze the target: 30 of 30
  const sheet = page.getByRole('dialog', { name: 'Tag 30 of 30?' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('30 of 30 selected will get this tag.')).toBeVisible();
  await expect(page.getByText(/Nothing was changed/)).toHaveCount(0);
  expect(c.taps).toBe(isPhone(page) ? 5 : 4); // to the count sheet only: nothing has started, so this is not §5's 5 / 4
  await tap(page, sheet.getByRole('button', { name: 'Tag 30 people' }), c);
  await expect(page.getByText(/Started: 30 people/)).toBeVisible();
  expect(c.taps).toBe(isPhone(page) ? 6 : 5); // started: one tap over §5's 5 / 4 ("count sheet confirms inline"), an owner gap
  // the bulk.run job, run by the real runner as the worker would
  const run = await stack.fixture<{ results: unknown[] }>('/run-bulk');
  expect(run.results).toEqual([{ kind: 'finished', status: 'completed' }]);
  await page.goto(`${stack.webUrl}/people?list=${world.listId}`);
  await expect(page.getByRole('list', { name: 'People' }).getByRole('button', { name: 'Tag Investor, show everyone with it' })).toHaveCount(30);
  const state = await stack.fixture<{ tags: { name: string; added_by_kind: string }[] }>('/person-state', { contactId: world.firstListPerson });
  expect(state.tags).toEqual([{ name: 'Buyer', added_by_kind: 'user' }, { name: 'Investor', added_by_kind: 'bulk' }]);
});

test('tags show on the person\'s page and can be edited there: + → tag = 2 taps on a phone (+ → ↵ = 1 on desktop); × removes', async ({ page }) => {
  await signIn(page, world.agent);
  await page.goto(`${stack.webUrl}/contacts/${world.janeId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Jane Doe' })).toBeVisible();
  const tags = page.getByRole('region', { name: 'Tags' });
  await expect(tags.getByRole('button', { name: 'Add a tag' })).toBeVisible();
  const c = { taps: 0 };
  await tap(page, tags.getByRole('button', { name: 'Add a tag' }), c);
  const picker = page.getByRole('dialog', { name: 'Tag Jane' });
  if (isPhone(page)) await tap(page, picker.getByRole('button', { name: 'Buyer' }), c);
  else {
    await picker.getByRole('textbox', { name: 'Tag' }).fill('buyer'); // typing is not counted; ↵ picks the existing "Buyer" (E165)
    await picker.getByRole('textbox', { name: 'Tag' }).press('Enter');
  }
  await expect(tags.getByRole('button', { name: 'Tag Buyer, show everyone with it' })).toBeVisible();
  expect(c.taps).toBe(isPhone(page) ? 2 : 1);
  expect((await stack.fixture<{ tags: { name: string; added_by_kind: string }[] }>('/person-state', { contactId: world.janeId })).tags).toEqual([{ name: 'Buyer', added_by_kind: 'user' }]);
  // a reload still shows it (it is stored, not just drawn)
  await page.reload();
  await expect(page.getByRole('region', { name: 'Tags' }).getByRole('button', { name: 'Tag Buyer, show everyone with it' })).toBeVisible();
  await page.getByRole('region', { name: 'Tags' }).getByRole('button', { name: 'Tag Buyer, remove' }).click();
  await expect(page.getByRole('region', { name: 'Tags' }).getByRole('button', { name: 'Tag Buyer, show everyone with it' })).toHaveCount(0);
  expect((await stack.fixture<{ tags: unknown[] }>('/person-state', { contactId: world.janeId })).tags).toEqual([]);
  // tap a chip to see everyone with the tag (1 tap)
  await page.goto(`${stack.webUrl}/contacts/${world.firstListPerson}`);
  await tap(page, page.getByRole('region', { name: 'Tags' }).getByRole('button', { name: 'Tag Buyer, show everyone with it' }), { taps: 0 });
  await expect(page.getByRole('heading', { level: 2, name: 'Tag: Buyer' })).toBeVisible();
});

test('R-PAR-7 E167 R-PAR-32: tagging Jane "DNC" saves a tag and blocks nothing; "Record do not contact" is one tap and blocks every channel; there is no Undo', async ({ page }) => {
  await signIn(page, world.agent);
  await page.goto(`${stack.webUrl}/contacts/${world.janeId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Jane Doe' })).toBeVisible();
  const tags = page.getByRole('region', { name: 'Tags' });
  await tags.getByRole('button', { name: 'Add a tag' }).click();
  await page.getByRole('dialog', { name: 'Tag Jane' }).getByRole('textbox', { name: 'Tag' }).fill('DNC');
  await page.getByRole('dialog', { name: 'Tag Jane' }).getByRole('button', { name: 'Create "DNC"' }).click();
  await expect(tags.getByText("Tags don't stop messages")).toBeVisible();
  await expect(tags.getByText('Record "do not contact" for Jane?')).toBeVisible();
  // the tag alone changed nothing about reaching her
  const before = await stack.fixture<{ doNotContact: boolean; revokes: number; tags: { name: string }[] }>('/person-state', { contactId: world.janeId });
  expect(before).toMatchObject({ doNotContact: false, revokes: 0, tags: [{ name: 'DNC' }] });
  await expect(page.getByRole('button', { name: 'Text', exact: true })).toBeEnabled();
  const c = { taps: 0 };
  await tap(page, tags.getByRole('button', { name: 'Record do not contact' }), c);
  await expect(tags.getByText('Recorded: do not contact Jane')).toBeVisible();
  expect(c.taps).toBe(1);
  await expect(tags.getByRole('button', { name: /Undo/ })).toHaveCount(0);
  const after = await stack.fixture<{ doNotContact: boolean; revokes: number }>('/person-state', { contactId: world.janeId });
  expect(after.doNotContact).toBe(true);
  expect(after.revokes).toBeGreaterThanOrEqual(2); // texts and calls on her phone: a staff revoke each
  // every channel is now blocked, and the page says so before any tap
  await expect(page.getByRole('button', { name: 'Text', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Call', exact: true })).toBeDisabled();
  // removing the tag lifts nothing (R-PAR-7)
  await tags.getByRole('button', { name: 'Tag DNC, remove' }).click();
  await expect(tags.getByRole('button', { name: 'Tag DNC, show everyone with it' })).toHaveCount(0);
  expect((await stack.fixture<{ doNotContact: boolean }>('/person-state', { contactId: world.janeId })).doNotContact).toBe(true);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Text', exact: true })).toBeDisabled();
});

test('R-PAR-13: an Admin saves stage labels (module 57\'s /stage-labels) and they stay saved', async ({ page }) => {
  await signIn(page, world.admin);
  await page.goto(`${stack.webUrl}/admin/stage-labels`);
  await expect(page.getByRole('heading', { level: 1, name: 'Stage labels' })).toBeVisible();
  await expect(page.getByText(/can't be saved yet/)).toHaveCount(0);
  const label = isPhone(page) ? 'Fresh lead' : 'New lead (desk)';
  await page.getByLabel('New', { exact: true }).fill(label);
  await page.getByRole('button', { name: 'Save labels' }).click();
  await expect(page.getByTestId('toast')).toHaveText('Stage labels saved');
  await page.reload();
  await expect(page.getByLabel('New', { exact: true })).toHaveValue(label);
});

test('R-PAR-13: the saved label is shown on the person\'s stage pill', async ({ page }) => {
  await signIn(page, world.agent);
  await page.goto(`${stack.webUrl}/contacts/${world.janeId}`);
  const label = isPhone(page) ? 'Fresh lead' : 'New lead (desk)';
  await expect(page.getByRole('button', { name: `Stage: ${label}. Change stage` })).toBeVisible();
});

test('R-PAR-46 R-PAR-10: an import creates tags and typed custom fields through module 60\'s writers, shown on the person\'s page and in Admin; Undo removes exactly what it wrote', async ({ page }) => {
  test.setTimeout(240_000);
  const imp = await stack.fixture<{ admin: { email: string; password: string }; batchId: string; anaId: string }>('/import');
  const committed = await stack.fixture<{ links: number; linksByKind: { kind: string; n: number }[]; values: number; fields: { key: string; field_type: string; origin: string; archived: boolean }[]; tags: { name: string; created_by_kind: string }[] }>('/import-state', { batchId: imp.batchId });
  expect(committed.links).toBeGreaterThan(0);
  expect(committed.linksByKind).toEqual([{ kind: 'import', n: committed.links }]);
  expect(committed.values).toBeGreaterThan(0);
  expect(committed.fields).toEqual([
    { key: 'fub_closing_date', field_type: 'date', origin: 'fub_import', archived: false },
    { key: 'fub_interests', field_type: 'multi_select', origin: 'fub_import', archived: false },
    { key: 'fub_lead_score', field_type: 'number', origin: 'fub_import', archived: false },
    { key: 'fub_notes_field', field_type: 'text', origin: 'fub_import', archived: false },
    { key: 'fub_timeline', field_type: 'single_select', origin: 'fub_import', archived: false },
  ]);
  expect(committed.tags.map((t) => t.name)).toEqual(['Buyer', 'FUB stage: Hot Prospect', 'FUB stage: Waiting On Lender', 'Investor', 'Relocating']);
  expect(committed.tags.every((t) => t.created_by_kind === 'import')).toBe(true);

  await signIn(page, imp.admin);
  // the imported person's tags, on their page
  await page.goto(`${stack.webUrl}/contacts/${imp.anaId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Ana Imported' })).toBeVisible();
  const tags = page.getByRole('region', { name: 'Tags' });
  for (const t of ['Buyer', 'FUB stage: Hot Prospect', 'Relocating']) await expect(tags.getByRole('button', { name: `Tag ${t}, show everyone with it` })).toBeVisible();
  // the typed fields, in Admin → Custom fields
  await page.goto(`${stack.webUrl}/admin/fields`);
  for (const [label, meta] of [
    ['Lead score', 'Number · from an import'],
    ['Closing date', 'Date · from an import'],
    ['Timeline', 'One choice · 2 choices · from an import'],
    ['Interests', 'Several choices · 2 choices · from an import'],
    ['Notes field', 'Text · from an import'],
  ] as const) {
    const row = page.getByRole('listitem').filter({ has: page.getByText(label, { exact: true }) });
    await expect(row.getByText(meta, { exact: true })).toBeVisible();
  }
  // Undo the whole import (2 taps), then the revert job runs
  await page.goto(`${stack.webUrl}/imports/${imp.batchId}`);
  await page.getByRole('button', { name: 'Undo this import' }).click();
  await page.getByRole('button', { name: 'Undo the whole import' }).click();
  await expect(page.getByText(/Undo started/).first()).toBeVisible();
  await stack.fixture('/drain');
  await page.reload();
  await expect(page.getByText('This import was undone.')).toBeVisible({ timeout: 15_000 });
  const reverted = await stack.fixture<{ links: number; values: number; fields: { key: string; archived: boolean }[]; tags: { name: string }[]; status: string }>('/import-state', { batchId: imp.batchId });
  expect(reverted).toMatchObject({ links: 0, values: 0, tags: [], status: 'reverted' });
  expect(reverted.fields.every((f) => f.archived)).toBe(true); // definitions are archived, never deleted
  await page.goto(`${stack.webUrl}/admin/fields`);
  await expect(page.getByText('Lead score', { exact: true })).toHaveCount(0);
  await page.getByLabel('Show archived fields').check();
  await expect(page.getByRole('listitem').filter({ has: page.getByText('Lead score', { exact: true }) }).getByText('Number · archived · from an import', { exact: true })).toBeVisible();
  await page.goto(`${stack.webUrl}/admin/tags`);
  await expect(page.getByRole('heading', { level: 1, name: 'Tags' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit Relocating' })).toHaveCount(0);
});

test('the wired pages: 44 px tap targets on the person\'s Tags section and the bulk sheet; no horizontal scroll on a phone', async ({ page }) => {
  await signIn(page, world.agent);
  await page.goto(`${stack.webUrl}/contacts/${world.firstListPerson}`);
  await expect(page.getByRole('region', { name: 'Tags' }).getByRole('button', { name: 'Add a tag' })).toBeVisible();
  const small = async (scope: string) =>
    page.locator(`${scope} button:visible`).evaluateAll((els) => els.map((e) => ({ t: (e.getAttribute('aria-label') ?? (e as HTMLElement).innerText).trim().slice(0, 40), h: e.getBoundingClientRect().height, w: e.getBoundingClientRect().width })).filter((x) => x.h > 0 && (x.h < 43.5 || x.w < 43.5)));
  expect(await small('section[aria-label="Tags"]')).toEqual([]);
  await page.goto(`${stack.webUrl}/people?list=${world.listId}`);
  await page.getByRole('checkbox', { name: /Select all/ }).check();
  await page.getByRole('region', { name: 'Bulk actions' }).getByRole('button', { name: 'Change stage' }).click();
  const sheet = page.getByRole('dialog', { name: /^Move 30 people$/ });
  await expect(sheet.getByRole('region', { name: 'Stages' })).toBeVisible();
  expect(await small('[role="dialog"]')).toEqual([]);
  if (isPhone(page)) {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  }
});
