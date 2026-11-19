// The team work queue against the REAL API (stack.ts: the API harness on a fresh Postgres database, the RLS-bound
// app_user, fake providers), on the phone (iPhone 13) and desktop (1440 px) projects (b19 team-queue lane; DATA_MODEL
// R-TEAMQ-1..6):
//   - "did anybody call?": a Team Lead opens the team page and sees a lead in a pond, a lead on offer and an owned
//     lead whose only contact was the automatic reply, each with the right owner words, and does NOT see the owned
//     lead its agent has called. The name opens the person. Reading the page writes nothing.
//   - axe-core (color contrast included) on the queue, no horizontal page scroll on a phone, and 44 px tap targets
//     for every button and every link of the queue.
// Every lead is seeded through the real intake, ownership engine, first-response job and dial path.
import { createRequire } from 'node:module';
import { type Locator, type Page, expect, test } from 'playwright/test';
import { type TeamQueueStack, type Waiting, type World, startTeamQueueStack } from './stack.js';

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');

test.describe.configure({ mode: 'serial' });

let stack: TeamQueueStack;
let w: World;
let leads: Waiting;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startTeamQueueStack();
  w = await stack.fixture<World>('/world');
  leads = await stack.fixture<Waiting>('/waiting');
});
test.afterAll(async () => {
  await stack?.stop();
});

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 768;

async function signIn(page: Page) {
  await page.goto(`${stack.webUrl}/login`);
  await page.getByLabel('Email').fill(w.teamLead.email);
  await page.getByLabel('Password').fill(w.teamLead.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
}

const queue = (page: Page): Locator => page.getByRole('region', { name: 'Waiting now' });
const rowOf = (page: Page, name: string): Locator => queue(page).getByRole('listitem').filter({ has: page.getByRole('link', { name, exact: true }) });

test('a Team Lead sees who is waiting on a first call: the pond lead, the lead on offer and the lead with only an automatic reply, with their owner words; the lead a person called is not listed', async ({ page }) => {
  // the fixture really sent the automatic reply to the owned lead (the real first-response job)
  expect(leads.automated.automatedReplies).toBe(1);
  const before = await stack.fixture<Record<string, number>>('/writes');
  await signIn(page);
  if (isPhone(page)) {
    await page.getByRole('navigation', { name: 'Main tabs' }).getByRole('link', { name: 'More' }).tap();
    await page.getByRole('link', { name: 'Needs attention' }).tap();
  } else await page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('link', { name: 'Needs attention' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Needs attention' })).toBeVisible();

  const region = queue(page);
  await expect(region).toBeVisible();
  // the new-lead group is open with its three rows; the count says three
  await expect(region.getByRole('group', { name: 'New leads nobody has tried yet: 3' })).toBeVisible();

  const pond = rowOf(page, 'Pilar Pondsworth');
  await expect(pond).toBeVisible();
  await expect(pond.getByText(`No owner yet: in the pond ${w.pondName}`, { exact: true })).toBeVisible();
  await expect(pond.getByText(/Nobody has called, texted or emailed yet\./)).toBeVisible();

  const offered = rowOf(page, 'Otis Offerman');
  await expect(offered).toBeVisible();
  await expect(offered.getByText(`No owner yet: on offer to ${leads.offered.offeredToName}`, { exact: true })).toBeVisible();
  await expect(offered.getByText(new RegExp(`^Arrived .* from Portal\\. On offer to ${leads.offered.offeredToName}\\. Nobody has called, texted or emailed yet\\.`))).toBeVisible();

  const automated = rowOf(page, 'Aurelio Autoreply');
  await expect(automated).toBeVisible();
  await expect(automated.getByText(leads.automated.ownerName, { exact: true })).toBeVisible();
  await expect(automated.getByText(/No owner yet/)).toHaveCount(0);
  await expect(automated.getByText(new RegExp(`Owned by ${leads.automated.ownerName}\\. Nobody has called, texted or emailed yet\\. An automatic reply went out`))).toBeVisible();
  await expect(automated.getByText(/^Waiting /)).toBeVisible();

  // the lead its agent called is nobody's first call to chase
  await expect(region.getByRole('link', { name: 'Hana Called' })).toHaveCount(0);
  // every other group says, in words, that it is empty
  await expect(region.getByText('Every reply has an answer from a person.')).toBeVisible();
  await expect(region.getByText('No promise is past due.')).toBeVisible();
  // one line says how the queue differs from the exception list under it, which is still there
  await expect(region.getByText(/who is waiting for a person right now, counted from when they arrived/)).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Missed deadlines' })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Handled' })).toBeVisible();

  // collapsing and opening the group
  const toggle = region.getByRole('button', { name: /New leads nobody has tried yet/ });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(pond).toHaveCount(0);
  await toggle.click();
  await expect(pond).toBeVisible();

  // reading the page wrote nothing
  expect(await stack.fixture<Record<string, number>>('/writes')).toEqual(before);

  // the name opens the person
  const link = pond.getByRole('link', { name: 'Pilar Pondsworth' });
  await expect(link).toHaveAttribute('href', `/contacts/${leads.pond.contactId}`);
  if (isPhone(page)) await link.tap();
  else await link.click();
  await expect(page).toHaveURL(new RegExp(`/contacts/${leads.pond.contactId}$`));
});

test('the queue passes axe (color contrast included), has no horizontal scroll, and every button and queue link is a 44 px target', async ({ page }) => {
  await signIn(page);
  await page.goto(`${stack.webUrl}/team`);
  await expect(rowOf(page, 'Otis Offerman')).toBeVisible();
  await page.addScriptTag({ path: AXE_PATH });
  const violations = await page.evaluate(async () => {
    const r = await (window as unknown as { axe: { run(n: Node, o: unknown): Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe.run(document.body, { resultTypes: ['violations'] });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
  expect(violations).toEqual([]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const small = await page.locator('main button:visible, main [role="radio"]:visible').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).filter((r) => r.height < 44 || r.width < 44).length);
  expect(small).toBe(0);
  const smallLinks = await queue(page).locator('a:visible').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).filter((r) => r.height < 44 || r.width < 44).length);
  expect(smallLinks).toBe(0);
});
