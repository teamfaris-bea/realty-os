// web/people (PARITY_PLAN module 58) against the REAL API (e2e/agent/stack.ts: api/platform's harness on a
// fresh per-test Postgres database, RLS-bound app_user, fake providers), on the phone (iPhone 13) and desktop
// (1440 px) projects. Every job of PARITY_PLAN §5 this module delivers is run with its taps counted (typing is
// not counted; picking a mention adds +0 by the plan's count):
//   add a person: phone + → Save = 2 (+1 on a duplicate warning) · desktop + → ↵ = 1
//   add a note:   phone Note → Save = 2 · desktop click the box → ⌘↵ = 1
//   log a call:   Log (Call preselected) → outcome → Save = 3 (+ the follow-up task)
//   change stage: pill → stage = 2, toast with Undo
//   replace a phone: phone Details ✎ → field → Save = 3 · desktop inline field → ↵ = 1
//   add a relationship; locked stages say why before the tap; logged items say "Logged by".
// Then axe-core and 44 px targets on the contact page and the Add person page, and screenshots.
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { type BrowserContext, type Locator, type Page, expect, test } from 'playwright/test';
import { type AgentStack, startAgentStack } from '../agent/stack.js';
import { phoneProblems } from '../a11y/checks.js';

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');
const SHOTS = process.env.PEOPLE_SHOTS_DIR ?? '';

test.describe.configure({ mode: 'serial' });

let stack: AgentStack;
let agent: { email: string; password: string };
let jane: { id: string; name: string; phone: string };
let ben: { id: string; name: string };

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startAgentStack();
  agent = await stack.fixture('/world');
  jane = await stack.fixture('/contact', { firstName: 'Jane', lastName: 'Doe' });
  ben = await stack.fixture('/contact', { firstName: 'Ben', lastName: 'Doe' });
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
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

let session: Awaited<ReturnType<BrowserContext['storageState']>> | null = null;

/** Signs in once per run (the login endpoint is rate limited) and reuses the session cookies after. */
async function signIn(page: Page) {
  if (session) {
    await page.context().addCookies(session.cookies);
    await page.goto(`${stack.webUrl}/`);
    await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
    return;
  }
  await page.goto(`${stack.webUrl}/login`);
  await page.getByLabel('Email').fill(agent.email);
  await page.getByLabel('Password').fill(agent.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
  session = await page.context().storageState();
}

async function openContact(page: Page, id: string, name: string) {
  await page.goto(`${stack.webUrl}/contacts/${id}`);
  await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Stage: / })).toBeVisible({ timeout: 15_000 });
}

const peopleToast = (page: Page) => page.getByTestId('people-toast');

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.screenshot({ path: `${SHOTS}/${isPhone(page) ? 'phone' : 'desktop'}-${name}.png`, fullPage: true });
}

async function axeViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async () => {
    const r = await (window as unknown as { axe: { run(ctx: Document, o: object): Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe.run(document, { resultTypes: ['violations'] });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
}

function uniquePhone(seed: number): string {
  return `(415) ${String(200 + (seed % 700)).padStart(3, '0')}-${String(1000 + ((Date.now() + seed) % 8999)).padStart(4, '0')}`;
}

test('add a person: + → Save = 2 on a phone, + → ↵ = 1 on desktop; a duplicate warns first (+1)', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  const add = { taps: 0 };
  await tap(page, page.getByRole('link', { name: 'Add person' }), add);
  await expect(page.getByRole('heading', { level: 1, name: 'Add person' })).toBeVisible();
  const phone = uniquePhone(isPhone(page) ? 11 : 22);
  await page.getByLabel('First name').fill('Rosa');
  await page.getByLabel('Last name').fill(isPhone(page) ? 'Phone' : 'Desk');
  await page.getByLabel('Mobile').fill(phone);
  await shot(page, 'add-person');
  if (isPhone(page)) await tap(page, page.getByRole('button', { name: 'Save' }), add);
  else await page.getByLabel('Mobile').press('Enter');
  await expect(page.getByRole('heading', { level: 2, name: `Rosa ${isPhone(page) ? 'Phone' : 'Desk'}` })).toBeVisible({ timeout: 15_000 });
  expect(add.taps).toBe(isPhone(page) ? 2 : 1);

  // the same number again: the existing person is offered first; Create anyway is the +1
  const dup = { taps: 0 };
  await tap(page, page.getByRole('link', { name: 'Add person' }), dup);
  await page.getByLabel('First name').fill('Rosa');
  await page.getByLabel('Mobile').fill(phone);
  await tap(page, page.getByRole('button', { name: 'Save' }), dup);
  await expect(page.getByText('This may already be someone in Realty OS.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open the existing person' })).toBeVisible();
  await tap(page, page.getByRole('button', { name: 'Create anyway (a different person)' }), dup);
  await expect(page.getByRole('heading', { level: 2, name: 'Rosa' })).toBeVisible({ timeout: 15_000 });
  expect(dup.taps).toBe(3);
});

test('a note with an @mention: phone Note → Save = 2, desktop box → ⌘↵ = 1; the mention says who was told', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  await openContact(page, jane.id, 'Jane Doe');
  const note = { taps: 0 };
  const text = `Wants a fenced yard (${isPhone(page) ? 'phone' : 'desktop'}) `;
  let box: Locator;
  if (isPhone(page)) {
    await tap(page, page.getByRole('button', { name: 'Note', exact: true }), note);
    box = page.getByRole('dialog').getByRole('textbox', { name: 'Note about Jane Doe' });
  } else {
    box = page.getByRole('textbox', { name: 'Note about Jane Doe' });
    await tap(page, box, note);
  }
  await box.pressSequentially(`${text}ask @Oli`);
  const pick = page.getByRole('list', { name: 'Mention a teammate' }).getByRole('button', { name: /Olivia Owner/ });
  await expect(pick).toContainText('sees Jane');
  await pick.click(); // +0 by the plan's count: picking a name is part of typing the mention
  await expect(box).toHaveValue(`${text}ask @Olivia Owner `);
  await shot(page, 'note-mention');
  if (isPhone(page)) await tap(page, page.getByRole('dialog').getByRole('button', { name: 'Save note' }), note);
  else await box.press('ControlOrMeta+Enter');
  await expect(peopleToast(page).getByText('Note saved. Told Olivia Owner.')).toBeVisible({ timeout: 15_000 });
  expect(note.taps).toBe(isPhone(page) ? 2 : 1);
  const saved = page.getByRole('list', { name: 'Notes' }).getByText(`${text}ask @Olivia Owner`);
  await expect(saved).toBeVisible();
  await expect(page.getByText(/^Everyone who can see Jane can read (this note|these notes)\.$/).first()).toBeVisible();
});

test('log an outside call: Log → outcome → Save = 3; "Logged by" and not verified; the follow-up task; "they said stop" asks', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  await openContact(page, jane.id, 'Jane Doe');
  const log = { taps: 0 };
  await tap(page, page.getByRole('button', { name: 'Log', exact: true }), log);
  const sheet = page.getByRole('dialog', { name: 'Log for Jane Doe' });
  await expect(sheet.getByRole('button', { name: 'Call', exact: true, pressed: true })).toBeVisible();
  await tap(page, sheet.getByRole('button', { name: 'No answer' }), log);
  await shot(page, 'log-sheet');
  await tap(page, sheet.getByRole('button', { name: 'Save' }), log);
  await expect(peopleToast(page).getByText('Call logged')).toBeVisible();
  expect(log.taps).toBe(3);
  await expect(page.getByRole('list', { name: 'Notes' }).getByText(/Outbound call · No answer · Logged by .+ · not verified/).first()).toBeVisible();

  // with a "remind me": an ordinary task appears in the person's tasks
  await page.getByRole('button', { name: 'Log', exact: true }).click();
  const again = page.getByRole('dialog', { name: 'Log for Jane Doe' });
  await again.getByRole('button', { name: 'Talked' }).click();
  await again.getByLabel('Remind me').selectOption('2');
  await again.getByRole('button', { name: 'Save' }).click();
  await expect(peopleToast(page).getByText('Call logged, reminder in 2 days')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Follow up after the call' }).first()).toBeVisible({ timeout: 15_000 });

  // E193: "she said stop" only asks; nothing is blocked until the agent records it
  await page.getByRole('button', { name: 'Log', exact: true }).click();
  const third = page.getByRole('dialog', { name: 'Log for Ben Doe' }).or(page.getByRole('dialog', { name: 'Log for Jane Doe' }));
  await third.getByLabel('Note (optional)').fill('She said stop calling');
  await expect(third.getByText(/a note alone doesn’t stop anything/)).toBeVisible();
  await third.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('dialog', { name: 'Did Jane ask not to be contacted?' })).toBeVisible();
  await page.getByRole('button', { name: 'No', exact: true }).click();
});

test('change stage: pill → stage = 2 with an Undo toast; locked stages say why before the tap', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  await openContact(page, ben.id, 'Ben Doe');
  const stage = { taps: 0 };
  await tap(page, page.getByRole('button', { name: 'Stage: New. Change stage' }), stage);
  await tap(page, page.getByRole('dialog').getByRole('button', { name: /^Nurture/ }), stage);
  await expect(peopleToast(page).getByText('Stage: Nurture')).toBeVisible();
  expect(stage.taps).toBe(2);
  await peopleToast(page).getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('button', { name: 'Stage: New. Change stage' })).toBeVisible({ timeout: 15_000 });

  // a routed lead nobody reached yet: the picker shows the locked stages and why, up front
  const lead = await stack.fixture<{ id: string; state: string }>('/offer', { name: isPhone(page) ? 'Lou Phone' : 'Lou Desk' });
  expect(lead.state).toBe('offered');
  await page.goto(`${stack.webUrl}/contacts/${lead.id}`);
  await page.getByRole('button', { name: 'Accept' }).click();
  await expect(page.getByRole('button', { name: /^Stage: New/ })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: /^Stage: New/ }).click();
  const picker = page.getByRole('dialog');
  await expect(picker.getByText('Reach them first.')).toBeVisible();
  await expect(picker.getByRole('button', { name: /^Lost/ })).toBeDisabled();
  await expect(picker.getByRole('button', { name: /^Attempting/ })).toBeEnabled();
  await shot(page, 'stage-locked');
  await picker.getByRole('button', { name: 'Cancel' }).click();
});

test('replace a phone: phone Details ✎ → field → Save = 3, desktop inline → ↵ = 1; the old number is kept as removed', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  const p = await stack.fixture<{ id: string; name: string; phone: string }>('/contact', { firstName: 'Ivy', lastName: isPhone(page) ? 'Phone' : 'Desk' });
  await openContact(page, p.id, p.name);
  const next = uniquePhone(isPhone(page) ? 33 : 44);
  const edit = { taps: 0 };
  if (isPhone(page)) {
    await tap(page, page.getByRole('button', { name: `Edit details of ${p.name}` }), edit);
    const field = page.getByRole('dialog').getByLabel('Phone (mobile)');
    await tap(page, field, edit);
    await field.fill(next);
    await expect(page.getByRole('dialog').getByText('Saving replaces the old one; its history and any opt-out stay with it.')).toBeVisible();
    await shot(page, 'edit-sheet');
    await tap(page, page.getByRole('dialog').getByRole('button', { name: 'Save' }), edit);
    await expect(peopleToast(page).getByText('Saved')).toBeVisible();
    expect(edit.taps).toBe(3);
  } else {
    const field = page.getByRole('textbox', { name: 'mobile' });
    await tap(page, field, edit);
    await field.fill(next);
    await field.press('Enter');
    await expect(peopleToast(page).getByText('Number replaced')).toBeVisible();
    expect(edit.taps).toBe(1);
  }
  const digits = next.replace(/\D/g, '');
  await expect(page.getByText(new RegExp(`${digits.slice(3, 6)}.${digits.slice(6)}`)).first()).toBeVisible({ timeout: 15_000 });
});

test('add a relationship: Link a person → find → tap; it shows on both people', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  await openContact(page, jane.id, 'Jane Doe');
  const kind = isPhone(page) ? 'household' : 'spouse_partner';
  await page.getByRole('button', { name: 'Link a person' }).click();
  const sheet = page.getByRole('dialog', { name: 'Link someone to Jane Doe' });
  await sheet.getByLabel('Relationship').selectOption(kind);
  await sheet.getByLabel('Find a person').fill('Ben');
  await sheet.getByRole('list', { name: 'People' }).getByRole('button', { name: 'Ben Doe' }).click();
  await expect(peopleToast(page).getByText('Linked Jane Doe and Ben Doe')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Ben Doe' }).first()).toBeVisible();
  await openContact(page, ben.id, 'Ben Doe');
  await expect(page.getByRole('link', { name: 'Jane Doe' }).first()).toBeVisible();
});

test('add a task and an appointment from the person’s page', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  await openContact(page, ben.id, 'Ben Doe');
  await page.getByRole('button', { name: 'Add task' }).click();
  await page.getByRole('dialog').getByLabel('What').fill(`Send comps (${isPhone(page) ? 'p' : 'd'})`);
  await page.getByRole('dialog').getByRole('button', { name: 'Add task' }).click();
  await expect(peopleToast(page).getByText('Task added')).toBeVisible();
  await expect(page.getByRole('link', { name: `Send comps (${isPhone(page) ? 'p' : 'd'})` })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Add appointment' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Add appointment' }).click();
  await expect(peopleToast(page).getByText('Appointment added')).toBeVisible();
});

test('people pages: axe (incl. contrast) in light and dark, 44 px tap targets, no sideways scroll', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await openContact(page, jane.id, 'Jane Doe');
    await page.waitForLoadState('networkidle');
    if (scheme === 'light') await shot(page, 'contact');
    expect(await axeViolations(page), `${scheme} contact`).toEqual([]);
    if (isPhone(page)) expect(await phoneProblems(page), `${scheme} contact`).toEqual([]);
    await page.goto(`${stack.webUrl}/people/new`);
    await expect(page.getByRole('heading', { level: 1, name: 'Add person' })).toBeVisible();
    expect(await axeViolations(page), `${scheme} add person`).toEqual([]);
    if (isPhone(page)) expect(await phoneProblems(page), `${scheme} add person`).toEqual([]);
  }
});
