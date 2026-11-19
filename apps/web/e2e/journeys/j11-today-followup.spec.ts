// J11 — warm follow-up in Today (batch 19; R-TODAY-1 to R-TODAY-10), against the REAL API (journeys/stack.ts: a fresh
// Postgres database, RLS-bound app_user, fake providers only), entirely through the UI, on the phone project (an
// iPhone 13 EMULATED on Chromium: not a real iPhone, not Safari, no on-screen keyboard) and the desktop project
// (1440 × 900). Invented people and the stack's own fictional numbers only; nothing is sent anywhere real.
//
//   1. an agent opens Today: "Follow up today" lists a person with a promise due, with why they are due, what was last
//      discussed (the agent's own note) and the promise; the person is shown once (their task's card is not also in
//      "Next up");
//   2. the agent taps the row's Log, logs "Left voicemail" for a call made from their own phone, keeps the suggested
//      stage and the follow-up for tomorrow the sheet preselects: Log → outcome → the one button = 3 taps, every tap
//      counted, without leaving Today. The row updates in place ("Logged by you: called from your phone, left a
//      voicemail"); one note, no call record, one task, one stage event;
//   3. a person whose only message was automatic says "No conversation yet." and, on its own line, "Automatic text
//      sent …"; the automatic text's words are nowhere on the page;
//   4. from the People page the header's "Log a call or conversation" logs a conversation for another person: the
//      entry → the person → "Talked" → the one button = 4 taps, and a double tap on that button makes one record;
//   5. axe on Today and on the open sheet; on the phone, 44 px targets, no sideways scroll, the sheet's one button on
//      screen above the home indicator; a 24-character stage label is whole at 320 px wide.
// Screenshots of each step go to $JOURNEY_SHOTS_DIR (desktop at deviceScaleFactor 2; the phone as the iPhone 13
// descriptor has it).
import { createRequire } from 'node:module';
import { type BrowserContext, type Locator, type Page, devices, expect, test } from 'playwright/test';
import { phoneProblems } from '../a11y/checks.js';
import { isPhone, shot, signIn, tap } from './helpers.js';
import { type JourneyStack, type WorldInfo, startJourneyStack } from './stack.js';

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');

test.describe.configure({ mode: 'serial' });
// the owner's screenshots: desktop at 2x; the phone keeps the iPhone 13 descriptor's own scale
// (a Playwright fixture must take its first argument as an object pattern, even an empty one)
// eslint-disable-next-line no-empty-pattern
test.use({ deviceScaleFactor: async ({}, use, info) => use(info.project.name === 'desktop' ? 2 : devices['iPhone 13'].deviceScaleFactor) });

const IMPORTS = String.raw`
import { grantConsent, sendText } from './src/comms/testing.ts';
`;

// Spec routes (child JS). The superuser writes are fixtures with no application path: a task's kind `promise` (only
// the assistant makes one, from a conversation), a text re-attributed to the system (a plan's step), and stored
// instants moved into the past (Postgres' clock cannot be faked). Everything the journey ASSERTS is done through the UI.
const ROUTES = String.raw`
  /** { as, first, last } → a person the agent adds (theirs), with a phone, an email and staff-entered consent to text */
  async '/j11/person'(b) {
    const r = await call(client(b.as), 'POST', '/contacts', { commandId: randomUUID(), firstName: b.first, lastName: b.last, phones: [randomPhone()], emails: [randomEmail()] });
    if (r.status !== 201 && r.status !== 200) throw new Error('person: ' + r.status + ' ' + JSON.stringify(r.body));
    await grantConsent(client(b.as), r.body.contact.id, 'sms');
    return { id: r.body.contact.id, name: b.first + ' ' + b.last, first: b.first };
  },
  /** { taskId, overdueMinutes } the task becomes a promise, due earlier today */
  async '/j11/promise'(b) {
    await h.su.query("UPDATE tasks SET kind = 'promise', due_at = clock_timestamp() - ($2::int * interval '1 minute') WHERE id = $1", [b.taskId, b.overdueMinutes ?? 10]);
    return { ok: true };
  },
  /** { as, contactId, body, daysAgo } a text a plan sent: one the agent really sent through the fake provider, re-attributed to the system */
  async '/j11/automatic-text'(b) {
    const r = await sendText(client(b.as), b.contactId, b.body);
    if (r.body.result !== 'sent') throw new Error('automatic text: ' + JSON.stringify(r.body));
    await suFixture(h, [{ text: "UPDATE messages SET initiator = 'system', initiated_by_user_id = NULL, occurred_at = clock_timestamp() - ($2::int * interval '1 day'), dispatched_at = clock_timestamp() - ($2::int * interval '1 day') WHERE id = $1", values: [r.body.message.id, b.daysAgo] }]);
    return { messageId: r.body.message.id };
  },
  /** { contactId, stage, days } in the stage, last verified touch that many days ago, theirs for 90 days */
  async '/j11/quiet'(b) {
    await suFixture(h, [{ text: "UPDATE contacts SET stage = $2, owned_at = clock_timestamp() - interval '90 days', last_human_touch_at = clock_timestamp() - ($3::int * interval '1 day') - interval '1 hour' WHERE id = $1", values: [b.contactId, b.stage, b.days] }]);
    return { ok: true };
  },
`;

const NOTE = 'Wants 3 beds near the park, pre-approval next week.';
const PROMISE = 'Send lender intro';
const AUTOMATIC = 'New listings near you this week, reply for details';
const LONG_LABEL = 'Trying to reach them now'; // 24 characters

interface Person {
  id: string;
  name: string;
  first: string;
}

let stack: JourneyStack;
let w: WorldInfo;
let agent: WorldInfo['agents'][number];
let dana: Person;
let ines: Person;
let marisol: Person;
let promiseTaskId = '';

async function must<T>(p: Promise<{ status: number; body: T }>, what: string): Promise<T> {
  const r = await p;
  expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
  return r.body;
}

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startJourneyStack({ imports: IMPORTS, routes: ROUTES });
  w = await stack.world({ agents: 1, alertPhones: true });
  agent = w.agents[0]!;
  const person = (first: string, last: string) => stack.fixture<Person>('/j11/person', { as: 'a.agent0', first, last });
  dana = await person('Dana', 'Okafor');
  ines = await person('Ines', 'Halloran');
  marisol = await person('Marisol', 'Vance');
  // Dana: the agent's own note, and a promise due earlier today
  await must(stack.api('a.agent0', 'POST', `/contacts/${dana.id}/notes`, { body: NOTE }), 'note');
  const t = await must(stack.api<{ task: { id: string } }>('a.agent0', 'POST', '/tasks', { title: PROMISE, contactId: dana.id, dueAt: new Date(Date.now() + 3_600_000).toISOString() }), 'task');
  promiseTaskId = t.task.id;
  await stack.fixture('/j11/promise', { taskId: promiseTaskId, overdueMinutes: 10 });
  // Ines: "Connected", quiet for 9 days, and the only message is one a plan sent 2 days ago
  await stack.fixture('/j11/automatic-text', { as: 'a.agent0', contactId: ines.id, body: AUTOMATIC, daysAgo: 2 });
  await stack.fixture('/j11/quiet', { contactId: ines.id, stage: 'connected', days: 9 });
});
test.afterAll(async () => {
  await stack?.stop();
});

/** One sign-in through the login page per run; later tests reuse its cookies (the login endpoint is rate limited). */
let session: Awaited<ReturnType<BrowserContext['storageState']>> | null = null;
async function openToday(page: Page) {
  if (session) {
    await page.context().addCookies(session.cookies);
    await page.goto(`${stack.webUrl}/`);
  } else {
    await signIn(page, stack, agent);
    session = await page.context().storageState();
  }
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible({ timeout: 20_000 });
  await expect(plan(page)).toBeVisible({ timeout: 20_000 });
}

const plan = (page: Page) => page.getByRole('region', { name: 'Follow up today' });
const row = (page: Page, p: Person) => plan(page).getByRole('article', { name: p.name });
const lines = (page: Page, p: Person) => row(page, p).getByTestId('follow-up-lines');
const line = (page: Page, p: Person, term: 'Due' | 'Last' | 'Next') => lines(page, p).locator('div').filter({ has: page.locator('dt', { hasText: new RegExp(`^${term}$`) }) }).locator('dd');
const peopleToast = (page: Page) => page.getByTestId('people-toast');

async function axeViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async () => {
    const r = await (window as unknown as { axe: { run(ctx: Document, o: object): Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe.run(document, { resultTypes: ['violations'] });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
}

/** Every control inside `root` is at least 44 × 44 px. */
async function smallTargets(root: Locator): Promise<string[]> {
  return root.evaluate((el) => {
    const out: string[] = [];
    for (const c of el.querySelectorAll<HTMLElement>('button, a[href], input:not([type=hidden]), select, textarea, [role=radio]')) {
      const r = c.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (Math.round(r.width) < 44 || Math.round(r.height) < 44) out.push(`${(c.getAttribute('aria-label') ?? c.innerText).trim().slice(0, 40)} ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
    return out;
  });
}

const notesOf = (id: string) => stack.sql<{ source: string; activity_kind: string | null; activity_direction: string | null; activity_outcome: string | null }>('SELECT source, activity_kind, activity_direction, activity_outcome FROM notes WHERE contact_id = $1 ORDER BY created_at', [id]);
const tasksOf = (id: string) => stack.sql<{ kind: string; title: string; status: string; due_at: string }>('SELECT kind, title, status, due_at FROM tasks WHERE contact_id = $1 ORDER BY created_at', [id]);
const callsOf = (id: string) => stack.sql('SELECT 1 FROM calls WHERE contact_id = $1', [id]);
const stageEvents = (id: string) => stack.sql<{ to_stage: string }>('SELECT to_stage FROM contact_stage_events WHERE contact_id = $1 ORDER BY occurred_at', [id]);

test('J11.1 Today: a person with a promise due shows why they are due, what was last discussed and the promise, once', async ({ page }, info) => {
  await openToday(page);
  await expect(row(page, dana)).toBeVisible({ timeout: 20_000 });
  await expect(line(page, dana, 'Due')).toHaveText(/^You promised this; \d+ min overdue$/);
  await expect(line(page, dana, 'Last')).toHaveText(new RegExp(`^Note today \\d{1,2}:\\d{2}\\s[AP]M: “${NOTE.replace(/[.]/g, '\\.')}”$`));
  await expect(line(page, dana, 'Next')).toHaveText(new RegExp(`^${PROMISE}, overdue since today \\d{1,2}:\\d{2}\\s[AP]M$`));
  await expect(row(page, dana).getByTestId('card-stage')).toHaveText('New lead');
  // one pass, here: Call, Log and Text sit on the row
  await expect(row(page, dana).getByRole('button', { name: 'Call', exact: true })).toBeEnabled({ timeout: 15_000 });
  await expect(row(page, dana).getByRole('button', { name: `Log for ${dana.name}` })).toBeVisible();
  // shown once: the promise's own card is not also under "Next up"
  await expect(page.getByRole('article', { name: dana.name })).toHaveCount(1);
  // the group says what it is, in a line
  await expect(plan(page).getByText('People you promised to get back to, and people you have talked with who have gone quiet.')).toBeVisible();
  await shot(page, info, 'j11', '1-today');
  expect(await axeViolations(page), 'axe on Today').toEqual([]);
  if (isPhone(page)) expect(await phoneProblems(page), 'Today on the phone').toEqual([]);
});

test('J11.2 a call made outside the app, from the row: Log → "Left voicemail" → the one button = 3 taps; the row updates in place', async ({ page }, info) => {
  await openToday(page);
  const n = { taps: 0 };
  await tap(page, row(page, dana).getByRole('button', { name: `Log for ${dana.name}` }), n); // 1
  const sheet = page.getByRole('dialog', { name: `Log for ${dana.name}` });
  // an outside call is the sheet's first choice: a call, "I called from my phone", just now
  await expect(sheet.getByRole('button', { name: 'Call', exact: true, pressed: true })).toBeVisible({ timeout: 15_000 });
  await expect(sheet.getByRole('button', { name: 'I called from my phone', pressed: true })).toBeVisible();
  await expect(sheet.getByRole('group', { name: 'When, quickly' }).getByRole('button', { name: 'Just now', pressed: true })).toBeVisible();
  await expect(sheet.getByText(`Something that happened outside Realty OS. It shows as logged by you and doesn’t count as reaching ${dana.first}.`)).toBeVisible();
  await shot(page, info, 'j11', '2-log-sheet-open');
  await tap(page, sheet.getByRole('button', { name: 'Left voicemail', exact: true }), n); // 2
  // the suggested stage is kept, and the follow-up for tomorrow is preselected and said before the tap
  await expect(sheet.getByRole('radio', { name: 'Trying to reach Suggested' })).toBeChecked({ timeout: 15_000 });
  await expect(sheet.getByTestId('log-summary')).toHaveText('To log: Call · I called from my phone · Left voicemail');
  await expect(sheet.getByRole('button', { name: 'Tomorrow', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(sheet.getByTestId('follow-up-line')).toHaveText(new RegExp(`^Will add a task for you: “Follow up with ${dana.first}”, due .+ 9:00\\sAM\\.$`));
  const save = sheet.getByTestId('log-save');
  await expect(save).toHaveText('Save and change to Trying to reach + follow-up');
  await expect(save).toBeEnabled({ timeout: 15_000 });
  expect(await axeViolations(page), 'axe with the Log sheet open').toEqual([]);
  if (isPhone(page)) {
    expect(await smallTargets(sheet), 'every control of the Log sheet is at least 44 px').toEqual([]);
    // the one button is wholly on screen, above the home indicator's safe area (the emulation has no on-screen keyboard)
    const b = (await save.boundingBox())!;
    expect(b.y + b.height, 'the one button is on screen').toBeLessThanOrEqual(page.viewportSize()!.height + 0.5);
    expect(await phoneProblems(page), 'Today with the Log sheet open').toEqual([]);
  }
  await shot(page, info, 'j11', '3-log-sheet-outcome');
  await tap(page, save, n); // 3
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 20_000 });
  expect(n.taps, 'Log → outcome → the one button').toBe(3);
  // said once, in the page's one toast
  await expect(peopleToast(page)).toContainText(/Call logged \(left voicemail\)\. Stage: Trying to reach\..*Follow-up saved for .+ 9:00\sAM/, { timeout: 15_000 });
  await expect(page.getByTestId('people-toast')).toHaveCount(1);
  // still Today, and the row says the new last touch as the agent's own report, with the new stage
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/');
  await expect(line(page, dana, 'Last')).toHaveText(/^Logged by you: called from your phone, left a voicemail \(today \d{1,2}:\d{2}\s[AP]M\)$/, { timeout: 20_000 });
  await expect(row(page, dana).getByTestId('card-stage')).toHaveText('Trying to reach');
  // the promise is still theirs to keep: it stays the next thing, and the row stays
  await expect(line(page, dana, 'Next')).toHaveText(new RegExp(`^${PROMISE}, overdue since today`));
  // still shown once: the follow-up just set for tomorrow has a card of its own in the feed, and it is not drawn beside the row
  await expect(page.getByRole('article', { name: dana.name })).toHaveCount(1);
  await shot(page, info, 'j11', '4-row-updated');
  // what was stored: one note that is a logged call, no call record, the promise and one new follow-up, one stage event
  expect(await notesOf(dana.id)).toEqual([
    { source: 'manual', activity_kind: null, activity_direction: null, activity_outcome: null },
    { source: 'logged_activity', activity_kind: 'call', activity_direction: 'outbound', activity_outcome: 'left_voicemail' },
  ]);
  expect(await callsOf(dana.id)).toEqual([]);
  const tasks = await tasksOf(dana.id);
  expect(tasks.map((t) => [t.kind, t.title, t.status])).toEqual([['promise', PROMISE, 'open'], ['follow_up', `Follow up with ${dana.first}`, 'open']]);
  expect(new Date(tasks[1]!.due_at).getTime(), 'the follow-up is for tomorrow').toBeGreaterThan(Date.now() + 3 * 3_600_000);
  expect((await stageEvents(dana.id)).map((e) => e.to_stage)).toEqual(['attempting']);
  // nothing was sent to anyone
  expect((await stack.sends()).sms.filter((m) => m.body.includes('Follow up'))).toEqual([]);
});

test('J11.3 a person whose only message was automatic: "No conversation yet." and the automatic text on its own line', async ({ page }, info) => {
  await openToday(page);
  await expect(row(page, ines)).toBeVisible({ timeout: 20_000 });
  await expect(line(page, ines, 'Due')).toHaveText('Connected: no conversation for 9 days');
  await expect(line(page, ines, 'Last')).toHaveText('No conversation yet.');
  await expect(lines(page, ines).getByText(/^Automatic text sent (Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/)).toBeVisible();
  await expect(line(page, ines, 'Next')).toHaveText('No next step set.');
  // the automatic text's own words are nowhere on the page
  await expect(page.getByText(AUTOMATIC.slice(0, 20))).toHaveCount(0);
  await row(page, ines).scrollIntoViewIfNeeded();
  await shot(page, info, 'j11', '5-automatic-only');
});

test('J11.4 from the People page: the header’s "Log a call or conversation" → a person → "Talked" → the one button = 4 taps; a double tap makes one record', async ({ page }, info) => {
  await openToday(page);
  await page.goto(`${stack.webUrl}/people`);
  await expect(page.getByRole('heading', { level: 1, name: 'People' })).toBeVisible({ timeout: 20_000 });
  // "+" is still a one-tap link to Add person, and the entry sits beside it
  await expect(page.getByRole('link', { name: 'Add person' })).toHaveAttribute('href', '/people/new');
  const n = { taps: 0 };
  await tap(page, page.getByRole('button', { name: 'Log a call or conversation', exact: true }), n); // 1
  const picker = page.getByRole('dialog', { name: 'Log a call or conversation' });
  await expect(picker.getByText('Recent people')).toBeVisible({ timeout: 15_000 });
  await expect(picker.getByRole('button', { name: `Log for ${marisol.name}` })).toBeVisible({ timeout: 15_000 });
  expect(await axeViolations(page), 'axe with the person picker open').toEqual([]);
  if (isPhone(page)) expect(await smallTargets(picker), 'every control of the picker is at least 44 px').toEqual([]);
  await shot(page, info, 'j11', '6-person-picker');
  await tap(page, picker.getByRole('button', { name: `Log for ${marisol.name}` }), n); // 2
  const sheet = page.getByRole('dialog', { name: `Log for ${marisol.name}` });
  await tap(page, sheet.getByRole('button', { name: 'Talked', exact: true }), n); // 3
  await expect(sheet.getByRole('radio', { name: 'Connected Suggested' })).toBeChecked({ timeout: 15_000 });
  await expect(sheet.getByRole('button', { name: '1 week', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const save = sheet.getByTestId('log-save');
  await expect(save).toHaveText('Save and change to Connected + follow-up');
  await expect(save).toBeEnabled({ timeout: 15_000 });
  await shot(page, info, 'j11', '7-log-from-anywhere');
  // a double tap: the second lands while the first is on its way (or after the sheet has gone) and adds nothing
  if (isPhone(page)) {
    await save.tap();
    await save.tap({ timeout: 1500 }).catch(() => undefined);
  } else {
    await save.dblclick();
  }
  n.taps += 1; // 4 (the double tap's second touch is the idempotence check, not a step)
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 20_000 });
  expect(n.taps, 'the entry → a person → an outcome → the one button').toBe(4);
  await expect(peopleToast(page)).toContainText(/Call logged \(talked\)\. Stage: Connected\..*Follow-up saved for .+ 9:00\sAM/, { timeout: 15_000 });
  // still on the People page
  await expect(page.getByRole('heading', { level: 1, name: 'People' })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/people');
  // the list behind the sheet is read again: it says the stage the toast says
  await expect(page.getByRole('main').locator('li, tr, article').filter({ hasText: marisol.name }).first()).toContainText('Connected', { timeout: 15_000 });
  await shot(page, info, 'j11', '8-after-log-from-anywhere');
  // one record of each
  expect(await notesOf(marisol.id)).toEqual([{ source: 'logged_activity', activity_kind: 'call', activity_direction: 'outbound', activity_outcome: 'connected' }]);
  expect((await tasksOf(marisol.id)).map((t) => [t.kind, t.status])).toEqual([['follow_up', 'open']]);
  expect((await stageEvents(marisol.id)).map((e) => e.to_stage)).toEqual(['connected']);
  expect(await callsOf(marisol.id)).toEqual([]);
  // the person's page labels it as the agent's own report, not verified
  await page.goto(`${stack.webUrl}/contacts/${marisol.id}`);
  await expect(page.getByRole('list', { name: 'Notes' }).getByText(/^Logged by you: called from your phone, talked · not verified · /).first()).toBeVisible({ timeout: 20_000 });
});

test('J11.5 a 24-character stage label is whole on the row at 320 px wide, and nothing scrolls sideways', async ({ page }, info) => {
  await stack.fixture('/reauth', { as: 'a.owner' });
  await must(stack.api('a.owner', 'PUT', '/stage-labels', { labels: { attempting: LONG_LABEL } }), 'stage labels');
  await openToday(page);
  if (isPhone(page)) await page.setViewportSize({ width: 320, height: 640 });
  await page.reload();
  await expect(row(page, dana)).toBeVisible({ timeout: 20_000 });
  const stage = row(page, dana).getByTestId('card-stage');
  await expect(stage).toHaveText(LONG_LABEL);
  // whole: the element shows all of its text (no clipping box, no ellipsis), and the page does not scroll sideways
  const fit = await stage.evaluate((el) => {
    const s = getComputedStyle(el);
    return { clipped: el.scrollWidth > el.clientWidth + 1 && s.overflow !== 'visible', ellipsis: s.textOverflow === 'ellipsis', sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth };
  });
  expect(fit).toEqual({ clipped: false, ellipsis: false, sideways: false });
  await row(page, dana).scrollIntoViewIfNeeded();
  await shot(page, info, 'j11', '9-long-stage-label');
  if (isPhone(page)) expect(await phoneProblems(page), 'Today at 320 px').toEqual([]);
});
