// J10 — the stage flow end to end (batch 19; R-STG-1 to R-STG-6), against the REAL API (journeys/stack.ts: a fresh
// Postgres database, RLS-bound app_user, fake providers only), entirely through the UI, on the phone project (an
// iPhone 13 EMULATED on Chromium: not a real iPhone, not Safari) and the desktop project (1440 px). Invented people
// and the stack's own fictional numbers only; nothing is sent anywhere real.
//
//   1. an Owner starts a stage plan "For the whole team" on the playbooks settings page, approves it, and sets it
//      to start when a person enters "Connected";
//   2. an agent opens an assigned lead, taps Call, taps "Left voicemail", sees "Trying to reach" suggested and that
//      no plan starts, and confirms: Call → outcome → confirm = 3 taps;
//   3. calls again, taps "Talked", sees "Connected" suggested and "Will start: Stay in touch …", and confirms;
//   4. "What happens next" shows the plan running with its next step; Pause, Resume and Stop work and the panel
//      says what the server says after each;
//   5. a person who texted STOP: the preview and the panel give the reason, and no plan starts;
//   6. Undo says the plan is still running and that undo does not stop it, and starts nothing;
//   7. a double tap on Save and on the confirm button, then a page refresh: one note, one task, one stage event and
//      at most one enrolment (read back through the API and the database);
//   8. with a 24-character team label at 320 px wide nothing truncates or overflows.
// b19 fix pass:
//   9. Log → outcome → ONE button ("Save and change to …") = 3 taps from the bar to a saved log and a confirmed stage,
//      every tap counted (M6); the stage step is in the Log sheet itself;
//  10. a stage change that fails after the log saved: the sheet says what was saved and what was not, and the retry
//      makes no second note (the first stage request is aborted in the browser; the API is real);
//  at 390 × 664 (the phone project's viewport) the suggested choice, the one effect line and the follow-up chips are
//  inside the sheet's visible body when the step opens, with the primary button on screen (M4).
// The existing checks stay on: axe on the page and on the sheet, 44 px targets and no sideways scroll on the phone.
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { type BrowserContext, type Locator, type Page, type TestInfo, expect, test } from 'playwright/test';
import { phoneProblems } from '../a11y/checks.js';
import { isPhone, shot, signIn, tap } from './helpers.js';
import { type JourneyStack, type WorldInfo, startJourneyStack } from './stack.js';

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');

test.describe.configure({ mode: 'serial' });

const PLAN = 'Stay in touch';
const LONG_LABEL = 'Trying to reach them now';

let stack: JourneyStack;
let w: WorldInfo;
let agent: WorldInfo['agents'][number];
let playbookId = '';

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startJourneyStack();
  // alertPhones: an agent needs a verified phone of their own to place a call (the bridge rings them first)
  w = await stack.world({ agents: 1, alertPhones: true });
  agent = w.agents[0]!;
});
test.afterAll(async () => {
  await stack?.stop();
});

interface Person {
  id: string;
  name: string;
  first: string;
  phone: string;
}

/** An assigned lead: it came in through the signed lead-source webhook, was offered to the agent, and they accepted. */
async function assignedLead(first: string, last: string, world: 'a' | 'b' = 'a', as = 'a.agent0'): Promise<Person> {
  const { phone } = await stack.fixture<{ phone: string }>('/phone');
  const name = `${first} ${last}`;
  const r = await stack.fixture<{ status: number; body: { contactId: string } }>('/intake', { world, body: { fullName: name, phones: [phone] } });
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  const id = r.body.contactId;
  const [offer] = await stack.sql<{ offer_id: string | null; ownership_state: string }>('SELECT offer_id, ownership_state FROM contacts WHERE id = $1', [id]);
  expect(offer, 'the lead was offered to the one agent').toMatchObject({ ownership_state: 'offered' });
  const acc = await stack.api(as, 'POST', `/leads/${id}/accept`, { commandId: randomUUID(), offerId: offer!.offer_id });
  expect(acc.status, JSON.stringify(acc.body)).toBe(200);
  return { id, name, first, phone };
}

/**
 * The agent signs in through the login page once per run and the later tests reuse that session's cookies: the login
 * endpoint is rate limited, and this journey opens the agent's session in seven tests within a minute.
 */
let agentSession: Awaited<ReturnType<BrowserContext['storageState']>> | null = null;
async function signInAgent(page: Page) {
  if (agentSession) {
    await page.context().addCookies(agentSession.cookies);
    await page.goto(`${stack.webUrl}/`);
    await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible({ timeout: 20_000 });
    return;
  }
  await signIn(page, stack, agent);
  agentSession = await page.context().storageState();
}

const suffix = (info: TestInfo) => (info.project.name === 'phone' ? 'Phone' : 'Desk');

async function openPerson(page: Page, p: Person) {
  await page.goto(`${stack.webUrl}/contacts/${p.id}`);
  await expect(page.getByRole('heading', { level: 1, name: p.name })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: /^Stage: / })).toBeVisible({ timeout: 20_000 });
}

/** Call: the phone's working bar on a phone, the header's button on desktop. One counted tap. */
function callButton(page: Page, p: Person): Locator {
  return isPhone(page) ? page.getByTestId('person-phone-bar').getByRole('button', { name: `Call ${p.name}` }) : page.getByRole('button', { name: 'Call', exact: true });
}
const step = (page: Page, p: Person) => page.getByRole('dialog', { name: `Stage for ${p.name}` });
const panel = (page: Page) => page.getByRole('region', { name: 'What happens next' });
const playbookRow = (page: Page) => panel(page).getByRole('group', { name: 'Automated playbook' });
const peopleToast = (page: Page) => page.getByTestId('people-toast');

/** Call → an outcome chip: the outcome is saved by that tap, and the same sheet shows the stage step. */
async function callAndLog(page: Page, p: Person, outcome: string, counter?: { taps: number }) {
  await tap(page, callButton(page, p), counter);
  const sheet = page.getByRole('dialog', { name: `Call ${p.name}` });
  await expect(sheet.getByText(`Your phone will ring first. Answer it and you're connected to ${p.first}.`)).toBeVisible({ timeout: 20_000 });
  await tap(page, sheet.getByRole('button', { name: outcome, exact: true }), counter);
  await expect(step(page, p).getByRole('radiogroup', { name: 'Stage' })).toBeVisible({ timeout: 15_000 });
  // M4: the step's first line says what was saved; no toast says it a second time over that line
  await expect(page.getByTestId('toast')).toBeEmpty();
}

/** The phone project's viewport: the design budget is checked at exactly this size. */
const PHONE_VIEWPORT = { width: 390, height: 664 };

/**
 * M4: when the step opens, each of `what` is wholly inside the sheet's visible body (the scrolling part between the
 * title and the pinned button), nothing has been scrolled, and the primary button is wholly on screen.
 */
async function expectAtOpen(page: Page, sheet: Locator, primary: Locator, what: Record<string, Locator>) {
  const body = sheet.getByTestId('dialog-body');
  expect(await body.evaluate((el) => el.scrollTop), 'the sheet has not been scrolled').toBe(0);
  const frame = (await body.boundingBox())!;
  const view = page.viewportSize()!;
  for (const [name, l] of Object.entries(what)) {
    await expect(l, name).toBeVisible();
    const r = (await l.boundingBox())!;
    expect(r.y, `${name}: top inside the sheet's visible body`).toBeGreaterThanOrEqual(frame.y - 0.5);
    expect(r.y + r.height, `${name}: bottom inside the sheet's visible body (${Math.round(r.y + r.height)} of ${Math.round(frame.y + frame.height)})`).toBeLessThanOrEqual(frame.y + frame.height + 0.5);
  }
  const b = (await primary.boundingBox())!;
  expect(b.y + b.height, 'the primary button is on screen').toBeLessThanOrEqual(view.height + 0.5);
  expect(b.y, 'the primary button is under the body, not over it').toBeGreaterThanOrEqual(frame.y + frame.height - 0.5);
}
/**
 * M4, the longer case (a refusal sentence of several lines): `l` is not on screen when the step opens, but it is
 * reached by scrolling the sheet's body alone, with the primary button still wholly on screen.
 */
async function expectReachable(page: Page, sheet: Locator, primary: Locator, name: string, l: Locator) {
  const body = sheet.getByTestId('dialog-body');
  await l.evaluate((el) => el.scrollIntoView({ block: 'end' }));
  const frame = (await body.boundingBox())!;
  const r = (await l.boundingBox())!;
  expect(r.y, `${name}: top inside the sheet's visible body after scrolling it`).toBeGreaterThanOrEqual(frame.y - 0.5);
  expect(r.y + r.height, `${name}: bottom inside the sheet's visible body after scrolling it`).toBeLessThanOrEqual(frame.y + frame.height + 0.5);
  await expect(primary).toBeInViewport({ ratio: 1 });
  await body.evaluate((el) => el.scrollTo(0, 0));
}
const stepParts = (s: Locator, suggested: string) => ({ 'what was logged': s.getByTestId('stage-step-saved'), 'the suggested choice': s.getByRole('radio', { name: `${suggested} Suggested` }), 'the effect line': s.getByTestId('stage-step-effect'), 'the follow-up chips': s.getByRole('group', { name: 'Follow-up' }) });

async function axeViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async () => {
    const r = await (window as unknown as { axe: { run(ctx: Document, o: object): Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe.run(document, { resultTypes: ['violations'] });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
}

/** Every control inside `root` is at least 44 × 44 px (a control in running text is not expected here). */
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

const enrollments = (contactId: string) => stack.sql<{ id: string; state: string; enrolled_by: string; playbook_id: string }>('SELECT id, state, enrolled_by, playbook_id FROM playbook_enrollments WHERE contact_id = $1 ORDER BY created_at', [contactId]);
const decisions = (contactId: string) => stack.sql<{ outcome: string; reason: string | null; playbook_id: string | null; to_stage: string }>('SELECT outcome, reason, playbook_id, to_stage FROM stage_automation_decisions WHERE contact_id = $1 AND playbook_id IS NOT NULL ORDER BY decided_at', [contactId]);
const stageEvents = (contactId: string) => stack.sql<{ to_stage: string }>('SELECT to_stage FROM contact_stage_events WHERE contact_id = $1 ORDER BY occurred_at', [contactId]);
const stageOf = async (contactId: string) => (await stack.sql<{ stage: string }>('SELECT stage FROM contacts WHERE id = $1', [contactId]))[0]!.stage;

test('J10.1: an Owner starts a stage plan for the whole team on the playbooks page, approves it, and sets it to start on Connected', async ({ page }, info) => {
  test.setTimeout(180_000);
  await signIn(page, stack, w.owner);
  await page.goto(`${stack.webUrl}/settings/playbooks`);
  await page.getByLabel('Start from').selectOption({ label: `${PLAN} (personal)` });
  const who = page.getByRole('radiogroup', { name: 'Who is it for' });
  await expect(who.getByRole('radio', { name: 'Just me' })).toBeChecked();
  await who.getByRole('radio', { name: 'For the whole team' }).check();
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByRole('heading', { level: 2, name: PLAN })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Team playbook')).toBeVisible();
  playbookId = /playbooks\/([0-9a-f-]{36})/.exec(page.url())![1]!;

  // approve exactly what is shown (the existing approval flow, unchanged)
  await page.getByRole('checkbox', { name: /^I reviewed the (message|\d+ messages) in “Stay in touch” version 1\./ }).check();
  await page.getByRole('button', { name: 'Approve and run' }).click();
  await expect(page.getByText('Version 1 approved and running')).toBeVisible({ timeout: 20_000 });

  const select = page.getByLabel('Start this plan when a person enters stage');
  await select.selectOption({ label: 'Connected' });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved. This playbook now starts when a person enters “Connected”.')).toBeVisible({ timeout: 20_000 });
  await shot(page, info, 'j10', '1-team-plan-approved');

  const [pb] = await stack.sql<{ scope: string; owner_user_id: string | null; auto_enroll_stage: string | null }>('SELECT scope, owner_user_id, auto_enroll_stage FROM playbooks WHERE id = $1', [playbookId]);
  expect(pb).toMatchObject({ scope: 'team', owner_user_id: null, auto_enroll_stage: 'connected' });
  expect(await stack.sql<{ status: string }>('SELECT status FROM playbook_versions WHERE playbook_id = $1', [playbookId])).toEqual([{ status: 'approved' }]);
});

test('J10.2-4: voicemail → "Trying to reach" (nothing starts) in 3 taps; a conversation → "Connected" (the team plan starts); the panel shows it running; Pause, Resume and Stop work', async ({ page }, info) => {
  test.setTimeout(240_000);
  expect(playbookId, 'J10.1 made the plan').not.toBe('');
  const dana = await assignedLead('Dana', suffix(info));
  await signInAgent(page);
  await openPerson(page, dana);
  await expect(page.getByRole('button', { name: 'Stage: New lead. Change stage' })).toBeVisible();
  // before anything: three rows, and the truth that nothing is running
  for (const row of ['Your next task', 'Automated playbook', 'AI follow-up']) await expect(panel(page).getByRole('group', { name: row })).toBeVisible();
  await expect(playbookRow(page).getByText('None running')).toBeVisible();
  // buyer or seller and texting permission are their own chips beside the stage
  const chips = page.getByRole('list', { name: `About ${dana.name}` });
  await expect(chips.getByText('Texting OK')).toBeVisible();
  await expect(chips.getByRole('listitem')).toHaveCount(2);
  await shot(page, info, 'j10', '2a-contact-with-panel');

  // (2) Call → Left voicemail → confirm = 3 taps
  const n = { taps: 0 };
  await callAndLog(page, dana, 'Left voicemail', n);
  const s = step(page, dana);
  await expect(s.getByRole('status')).toHaveText('Voicemail logged');
  const suggested = s.getByRole('radio', { name: 'Trying to reach Suggested' });
  await expect(suggested).toBeChecked();
  await expect(suggested).toContainText('We tried to reach them but have not had a two-way conversation yet.');
  await expect(suggested).toContainText('You left a voicemail. That is a try, not a conversation yet.');
  await expect(s.getByRole('radio', { name: 'Keep New lead' })).toBeVisible();
  const preview = s.getByTestId('stage-preview');
  await expect(preview.getByText('No plan starts on this stage.')).toBeVisible();
  // what no stage change ever does is the footnote under the step (M4: it is not what must be read before the tap)
  const note = s.getByTestId('stage-never-note');
  await expect(note.getByText('AI follow-up: unchanged')).toBeAttached();
  await expect(note.getByText('Your tasks: unchanged')).toBeAttached();
  await expect(note.getByText('Changing the stage does not stop a running plan.')).toBeAttached();
  await expect(s.getByText(/Will start/)).toHaveCount(0);
  // M4: what the tap will do is said ONCE, on screen without scrolling the sheet, and the button is described by it
  await expect(s.getByTestId('stage-step-effect')).toHaveText('No plan starts on this stage.');
  await expect(s.getByText('No plan starts on this stage.')).toHaveCount(1);
  await expect(s.getByTestId('stage-step-effect')).toBeInViewport({ ratio: 1 });
  await expect(s.getByRole('button', { name: 'Change to Trying to reach' })).toBeInViewport({ ratio: 1 });
  await expect(s.getByRole('button', { name: 'Change to Trying to reach' })).toHaveAccessibleDescription('No plan starts on this stage.');
  if (isPhone(page)) expect(page.viewportSize(), 'the phone project is 390 × 664').toEqual(PHONE_VIEWPORT);
  // at open, without scrolling: what was logged, the suggested choice, "Keep", "Another stage…", the effect, the follow-up
  await expectAtOpen(page, s, s.getByTestId('stage-step-confirm'), { ...stepParts(s, 'Trying to reach'), 'Keep': s.getByRole('radio', { name: 'Keep New lead' }), 'Another stage…': s.getByRole('button', { name: 'Another stage…' }) });
  // the outcome is saved, and the suggestion has changed nothing
  expect(await stageOf(dana.id)).toBe('new');
  if (isPhone(page)) expect(await smallTargets(s), 'stage step targets').toEqual([]);
  expect(await axeViolations(page), 'stage step').toEqual([]);
  await shot(page, info, 'j10', '2b-stage-step-voicemail');
  await tap(page, s.getByRole('button', { name: 'Change to Trying to reach' }), n);
  await expect(peopleToast(page).getByText('Stage: Trying to reach')).toBeVisible({ timeout: 15_000 });
  expect(n.taps, 'Call → outcome → confirm').toBe(3);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stage: Trying to reach. Change stage' })).toBeVisible({ timeout: 15_000 });
  expect(await stageOf(dana.id)).toBe('attempting');
  expect(await enrollments(dana.id)).toHaveLength(0);
  await expect(playbookRow(page).getByText('None running')).toBeVisible();

  // (3) call again → Talked → "Connected" suggested, the team plan will start
  await callAndLog(page, dana, 'Talked');
  await expect(s.getByRole('status')).toHaveText('Conversation logged');
  await expect(s.getByRole('radio', { name: 'Connected Suggested' })).toBeChecked();
  await expect(s.getByRole('radio', { name: 'Connected Suggested' })).toContainText('We have talked, but we are not actively working together yet.');
  await expect(s.getByRole('radio', { name: 'Keep Trying to reach' })).toBeVisible();
  // only the agent who was on the call knows whether they are months away: offered beside it, never chosen for them
  await expect(s.getByRole('radio', { name: 'Long-term follow-up' })).toBeVisible();
  await expect(preview.getByText(new RegExp(`^Will start: ${PLAN}, first step text `))).toBeVisible({ timeout: 15_000 });
  await expect(s.getByTestId('stage-step-effect')).toHaveText(new RegExp(`^Will start: ${PLAN}, first step text `));
  await expect(s.getByText(/Will start/)).toHaveCount(1);
  await expect(s.getByTestId('stage-step-effect')).toBeInViewport({ ratio: 1 });
  // at open with three choices and a plan that will start: still nothing that matters under the fold
  await expectAtOpen(page, s, s.getByTestId('stage-step-confirm'), { ...stepParts(s, 'Connected'), 'Keep': s.getByRole('radio', { name: 'Keep Trying to reach' }), 'Long-term follow-up': s.getByRole('radio', { name: 'Long-term follow-up' }) });
  expect(await enrollments(dana.id), 'a preview starts nothing').toHaveLength(0);
  await shot(page, info, 'j10', '3-stage-step-will-start');
  await tap(page, s.getByRole('button', { name: 'Change to Connected' }));
  await expect(peopleToast(page).getByText(`Stage: Connected. Started ${PLAN}`)).toBeVisible({ timeout: 15_000 });
  expect(await decisions(dana.id)).toEqual([expect.objectContaining({ outcome: 'started', reason: null, playbook_id: playbookId, to_stage: 'connected' })]);
  const started = await enrollments(dana.id);
  expect(started).toEqual([expect.objectContaining({ state: 'active', enrolled_by: 'stage_change', playbook_id: playbookId })]);

  // (4) the panel: the plan, running, its next step, where it came from; then Pause, Resume, Stop
  const row = playbookRow(page);
  await expect(row.getByText(PLAN, { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(row.getByTestId('plan-state')).toHaveText('Running');
  await expect(row.getByText(/^Next: text, /)).toBeVisible();
  await expect(row.getByText('Started when you moved them to Connected')).toBeVisible();
  await expect(row.getByRole('button', { name: `Resume ${PLAN}` })).toHaveCount(0);
  await shot(page, info, 'j10', '4a-panel-running');
  // the page as it rests, once the stage toast (8 s, with Undo) has gone
  await expect(peopleToast(page)).toBeEmpty({ timeout: 15_000 });
  if (isPhone(page)) expect(await phoneProblems(page), 'contact page with the panel and the working bar').toEqual([]);
  expect(await axeViolations(page), 'contact page').toEqual([]);

  await tap(page, row.getByRole('button', { name: `Pause ${PLAN}` }));
  await expect(row.getByTestId('plan-state')).toHaveText('Paused', { timeout: 15_000 });
  await expect(row.getByText('Paused by someone on the team. Resume it when you are ready.')).toBeVisible();
  await expect(row.getByText(/^Next: /)).toHaveCount(0);
  expect((await enrollments(dana.id))[0]!.state).toBe('paused');
  await tap(page, row.getByRole('button', { name: `Resume ${PLAN}` }));
  await expect(row.getByTestId('plan-state')).toHaveText('Running', { timeout: 15_000 });
  expect((await enrollments(dana.id))[0]!.state).toBe('active');
  await tap(page, row.getByRole('button', { name: `Stop ${PLAN}` }));
  await expect(row.getByTestId('plan-state')).toHaveText('Stopped', { timeout: 15_000 });
  await expect(row.getByText('Stopped by someone on the team.')).toBeVisible();
  await expect(row.getByRole('button')).toHaveCount(0);
  expect((await enrollments(dana.id))[0]!.state).toBe('stopped');
  await shot(page, info, 'j10', '4b-panel-stopped');
  // the stage did not move when the plan stopped: they are separate things
  expect(await stageOf(dana.id)).toBe('connected');
});

test('J10.5: a person who texted STOP: the preview and the panel give the reason, the texting chip says so, and no plan starts', async ({ page }, info) => {
  test.setTimeout(180_000);
  const omar = await assignedLead('Omar', suffix(info));
  expect((await stack.fixture<{ status: number }>('/sms-in', { world: 'a', from: omar.phone, body: 'STOP' })).status).toBeLessThan(300);
  await signInAgent(page);
  await openPerson(page, omar);
  await expect(page.getByRole('list', { name: `About ${omar.name}` }).getByText(/^No texting: Texted STOP on /)).toBeVisible({ timeout: 15_000 });
  if (isPhone(page)) {
    const text = page.getByTestId('person-phone-bar').getByRole('button', { name: `Text ${omar.name}` });
    await expect(text).toBeDisabled();
    await expect(text).toHaveAccessibleDescription(/^Text is off: Texted STOP on /);
  }
  // a text STOP does not block a call
  await callAndLog(page, omar, 'Talked');
  const s = step(page, omar);
  await expect(s.getByRole('radio', { name: 'Connected Suggested' })).toBeChecked();
  const preview = s.getByTestId('stage-preview');
  const why = `${PLAN} will not start: they opted out, are marked do not contact, or have no phone or email this plan could use.`;
  await expect(preview.getByText(why)).toBeVisible({ timeout: 15_000 });
  await expect(s.getByText(/Will start/)).toHaveCount(0);
  await expect(s.getByTestId('stage-step-effect')).toHaveText(why);
  await expect(s.getByText(why)).toHaveCount(1);
  await expect(s.getByTestId('stage-step-effect')).toBeInViewport({ ratio: 1 });
  // the refusal is a longer sentence: what was logged, the suggested choice and the reason are on screen at open; the
  // follow-up is one scroll of the sheet's body away, with the button still on screen
  const { 'the follow-up chips': followUp, ...above } = stepParts(s, 'Connected');
  await expectAtOpen(page, s, s.getByTestId('stage-step-confirm'), above);
  await expectReachable(page, s, s.getByTestId('stage-step-confirm'), 'the follow-up chips', followUp!);
  await shot(page, info, 'j10', '5a-stage-step-blocked');
  await tap(page, s.getByRole('button', { name: 'Change to Connected' }));
  await expect(peopleToast(page).getByText(`Stage: Connected. ${PLAN} didn't start: they can't be messaged`)).toBeVisible({ timeout: 15_000 });
  const row = playbookRow(page);
  await expect(row.getByText('None running')).toBeVisible({ timeout: 15_000 });
  await expect(row.getByText(`${PLAN} did not start: they opted out, are marked do not contact, or have no phone or email this plan could use.`)).toBeVisible();
  await expect(row.getByRole('button')).toHaveCount(0);
  await shot(page, info, 'j10', '5b-panel-blocked');
  expect(await stageOf(omar.id)).toBe('connected');
  expect(await decisions(omar.id)).toEqual([expect.objectContaining({ outcome: 'skipped', reason: 'cannot_be_reached', playbook_id: playbookId })]);
  expect(await enrollments(omar.id)).toHaveLength(0);
  // nothing from the plan ever reaches them, even after the worker runs
  await stack.fixture('/pjobs');
  expect(await stack.sql("SELECT 1 FROM messages WHERE contact_id = $1 AND direction = 'outbound' AND playbook_step_run_id IS NOT NULL", [omar.id])).toHaveLength(0);
});

test('J10.6: Undo moves the stage back, says the plan is still running and that undo does not stop it, offers Stop, and starts nothing', async ({ page }, info) => {
  test.setTimeout(180_000);
  const uma = await assignedLead('Uma', suffix(info));
  const before = (await stageEvents(uma.id)).length;
  await signInAgent(page);
  await openPerson(page, uma);
  await callAndLog(page, uma, 'Talked');
  await tap(page, step(page, uma).getByRole('button', { name: 'Change to Connected' }));
  const toast = peopleToast(page);
  await expect(toast.getByText(`Stage: Connected. Started ${PLAN}`)).toBeVisible({ timeout: 15_000 });
  const undo = toast.getByRole('button', { name: 'Undo' });
  const box = await undo.boundingBox();
  expect(Math.min(box!.width, box!.height)).toBeGreaterThanOrEqual(44);
  await tap(page, undo);
  await expect(toast.getByText(`Stage back to New lead. ${PLAN} is still running; undo does not stop it.`)).toBeVisible({ timeout: 15_000 });
  await expect(toast.getByRole('button', { name: `Stop ${PLAN}` })).toBeVisible();
  expect(await toast.textContent()).not.toMatch(/recall|unsent|taken back|cancel/i);
  await shot(page, info, 'j10', '6-undo-still-running');
  await expect(page.getByRole('button', { name: 'Stage: New lead. Change stage' })).toBeVisible({ timeout: 15_000 });
  // the panel keeps the truth and the Stop control after the toast is gone
  const row = playbookRow(page);
  await expect(row.getByText(PLAN, { exact: true })).toBeVisible();
  await expect(row.getByTestId('plan-state')).toHaveText('Running');
  await expect(row.getByRole('button', { name: `Stop ${PLAN}` })).toBeVisible();
  expect(await stageOf(uma.id)).toBe('new');
  // the undo started nothing and stopped nothing: still the one enrollment the change started, still active
  expect(await enrollments(uma.id)).toEqual([expect.objectContaining({ state: 'active', enrolled_by: 'stage_change', playbook_id: playbookId })]);
  expect((await decisions(uma.id)).filter((d) => d.outcome === 'started')).toHaveLength(1);
  expect((await stageEvents(uma.id)).slice(before).map((e) => e.to_stage)).toEqual(['connected', 'new']);
});

test('J10.7: a double tap on the one button that saves the log, the follow-up and the stage, then a refresh: one note, one task, one stage event, no enrolment', async ({ page }, info) => {
  test.setTimeout(180_000);
  const ivy = await assignedLead('Ivy', suffix(info));
  const before = (await stageEvents(ivy.id)).length;
  await signInAgent(page);
  await openPerson(page, ivy);
  const log = isPhone(page) ? page.getByTestId('person-phone-bar').getByRole('button', { name: 'Log', exact: true }) : page.getByRole('button', { name: 'Log', exact: true });
  await tap(page, log);
  // M6: the stage step is in the Log sheet itself; ONE button saves the log, the follow-up and the stage
  const s = page.getByRole('dialog', { name: `Log for ${ivy.name}` });
  await tap(page, s.getByRole('button', { name: 'Left voicemail' }));
  await expect(s.getByRole('radio', { name: 'Trying to reach Suggested' })).toBeChecked({ timeout: 15_000 });
  await tap(page, s.getByRole('group', { name: 'Follow-up' }).getByRole('button', { name: 'Tomorrow' }));
  await expect(s.getByTestId('follow-up-line')).toHaveText(new RegExp(`^Will add a task for you: “Follow up with ${ivy.first}”, due .+9:00 AM\\.$`));
  const confirm = s.getByRole('button', { name: 'Save and change to Trying to reach + follow-up' });
  await expect(confirm).toBeEnabled({ timeout: 15_000 });
  // two taps inside one frame: neither can wait for the other's answer
  const twice = (l: Locator) => l.evaluate((el) => { (el as HTMLElement).click(); (el as HTMLElement).click(); });
  await twice(confirm);
  await expect(peopleToast(page).getByText(/^Call logged \(left voicemail\)\. Stage: Trying to reach\. Follow-up saved for /)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // a refresh shows what the server stored
  await page.reload();
  await expect(page.getByRole('button', { name: 'Stage: Trying to reach. Change stage' })).toBeVisible({ timeout: 20_000 });
  const task = panel(page).getByRole('group', { name: 'Your next task' });
  await expect(task.getByText(`Follow up with ${ivy.first}`)).toBeVisible({ timeout: 15_000 });
  await expect(task.getByText(/more open/)).toHaveCount(0);
  await expect(playbookRow(page).getByText('None running')).toBeVisible();
  await shot(page, info, 'j10', '7-after-refresh');

  // through the API, as the agent: exactly one of each
  const notes = await stack.api<{ notes: { loggedActivity: { outcome: string | null } | null }[] }>('a.agent0', 'GET', `/contacts/${ivy.id}/notes`);
  expect(notes.body.notes.filter((x) => x.loggedActivity !== null)).toEqual([expect.objectContaining({ loggedActivity: expect.objectContaining({ outcome: 'left_voicemail' }) })]);
  const tasks = await stack.api<{ tasks: { title: string; kind: string }[] }>('a.agent0', 'GET', `/tasks?contactId=${ivy.id}&scope=visible&status=open`);
  expect(tasks.body.tasks).toEqual([expect.objectContaining({ title: `Follow up with ${ivy.first}`, kind: 'follow_up' })]);
  const status = await stack.api<{ plan: unknown; lastStageChange: { to: string } | null }>('a.agent0', 'GET', `/contacts/${ivy.id}/playbook-status`);
  expect(status.body.plan).toBeNull();
  expect(status.body.lastStageChange).toMatchObject({ to: 'attempting' });
  // and in the database
  expect(await stack.sql("SELECT 1 FROM notes WHERE contact_id = $1 AND source = 'logged_activity'", [ivy.id])).toHaveLength(1);
  expect(await stack.sql('SELECT 1 FROM tasks WHERE contact_id = $1', [ivy.id])).toHaveLength(1);
  expect((await stageEvents(ivy.id)).slice(before).map((e) => e.to_stage)).toEqual(['attempting']);
  expect((await enrollments(ivy.id)).length).toBeLessThanOrEqual(1);
  expect(await enrollments(ivy.id)).toHaveLength(0);
});

test('J10.8: a 24-character team label at 320 px wide: the pill, the picker, the stage step and its button show it whole; nothing truncates or scrolls sideways', async ({ page }, info) => {
  test.setTimeout(180_000);
  expect(LONG_LABEL).toHaveLength(24);
  // the desktop project has no touch screen, and at 320 px its layout is the phone's: a click on both projects
  const press = (l: Locator) => l.click();
  // a second team with its own label, so the first team's words stay as the other tests read them
  const b = await stack.world({ name: 'b', agents: 1, alertPhones: true });
  await stack.fixture('/reauth', { as: 'b.owner' });
  const put = await stack.api('b.owner', 'PUT', '/stage-labels', { labels: { attempting: LONG_LABEL } });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
  const lia = await assignedLead('Lia', suffix(info), 'b', 'b.agent0');
  expect((await stack.api('b.agent0', 'POST', `/contacts/${lia.id}/stage`, { stage: 'attempting' })).status).toBe(200);

  await page.setViewportSize({ width: 320, height: 640 });
  await signIn(page, stack, b.agents[0]!);
  await openPerson(page, lia);
  const sideways = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  /** the element shows all of its text: nothing is cut by its own box, and it sits inside the 320 px viewport */
  const whole = async (l: Locator, what: string) => {
    const m = await l.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return { left: r.left, right: r.right, cut: el.scrollWidth - el.clientWidth, ellipsis: s.textOverflow, nowrap: s.whiteSpace, text: (el as HTMLElement).innerText };
    });
    expect(m.text, what).toContain(LONG_LABEL);
    expect(m.cut, `${what}: text wider than its box`).toBeLessThanOrEqual(1);
    expect(m.ellipsis, what).not.toBe('ellipsis');
    expect(m.left, what).toBeGreaterThanOrEqual(0);
    expect(m.right, what).toBeLessThanOrEqual(320);
  };
  const pill = page.getByRole('button', { name: `Stage: ${LONG_LABEL}. Change stage` });
  await whole(pill, 'the stage pill');
  expect(await sideways(), 'the page').toBeLessThanOrEqual(0);
  expect(await phoneProblems(page), 'contact page at 320 px').toEqual([]);

  // the picker
  await press(pill);
  const picker = page.getByRole('dialog', { name: `Stage for ${lia.name}` });
  const current = picker.getByRole('button', { name: `${LONG_LABEL} Current` });
  await whole(current, 'the picker row');
  await expect(current).toContainText('We tried to reach them but have not had a two-way conversation yet.');
  await expect(picker.getByRole('list', { name: 'Stages' }).getByRole('listitem')).toHaveCount(8);
  expect(await picker.evaluate((el) => el.scrollWidth - el.clientWidth), 'the picker').toBeLessThanOrEqual(1);
  expect(await sideways()).toBeLessThanOrEqual(0);
  await shot(page, info, 'j10', '8a-320-picker-long-label');
  await press(picker.getByRole('button', { name: 'Cancel' }));

  // the stage step: "Keep <label>" and the button named for its effect
  await press(page.getByTestId('person-phone-bar').getByRole('button', { name: 'Log', exact: true }));
  const s = page.getByRole('dialog', { name: `Log for ${lia.name}` });
  await press(s.getByRole('button', { name: 'No answer' }));
  // already "trying to reach": another try suggests nothing, and the step (in the Log sheet) keeps the stage
  const keep = s.getByRole('radio', { name: `Keep ${LONG_LABEL}` });
  await expect(keep).toBeChecked({ timeout: 15_000 });
  await whole(keep, 'the "Keep" row');
  const button = s.getByRole('button', { name: `Save and keep ${LONG_LABEL}` });
  await whole(button, 'the primary button');
  expect(await s.evaluate((el) => el.scrollWidth - el.clientWidth), 'the stage step').toBeLessThanOrEqual(1);
  expect(await sideways()).toBeLessThanOrEqual(0);
  expect(await smallTargets(s), 'stage step targets at 320 px').toEqual([]);
  // the five-button bar still fits: every target at least 44 px, none off the screen
  await shot(page, info, 'j10', '8b-320-stage-step-long-label');
  await press(button);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(peopleToast(page).getByText('Call logged (no answer)')).toBeVisible({ timeout: 15_000 });
  expect(await stack.sql("SELECT 1 FROM notes WHERE contact_id = $1 AND source = 'logged_activity'", [lia.id])).toHaveLength(1);
  const bar = page.getByTestId('person-phone-bar');
  expect(await bar.getByRole('button').count()).toBe(5);
  expect(await smallTargets(bar), 'the working bar at 320 px').toEqual([]);
  for (const b5 of await bar.getByRole('button').all()) {
    const r = (await b5.boundingBox())!;
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.x + r.width).toBeLessThanOrEqual(320);
  }
});

const logButton = (page: Page) => (isPhone(page) ? page.getByTestId('person-phone-bar').getByRole('button', { name: 'Log', exact: true }) : page.getByRole('button', { name: 'Log', exact: true }));
const loggedNotes = (contactId: string) => stack.sql("SELECT 1 FROM notes WHERE contact_id = $1 AND source = 'logged_activity'", [contactId]);

test('J10.9 (M6): Log → outcome → "Save and change to Trying to reach" = 3 taps from the bar to a saved log and a confirmed stage, every tap counted; the step is in the Log sheet and nothing that matters is under the fold', async ({ page }, info) => {
  test.setTimeout(180_000);
  const noor = await assignedLead('Noor', suffix(info));
  const before = (await stageEvents(noor.id)).length;
  await signInAgent(page);
  await openPerson(page, noor);
  const n = { taps: 0 };
  await tap(page, logButton(page), n);
  const s = page.getByRole('dialog', { name: `Log for ${noor.name}` });
  await expect(s.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  await tap(page, s.getByRole('group', { name: 'Outcome' }).getByRole('button', { name: 'Left voicemail' }), n);
  // the same sheet: what is about to be logged, the suggestion, what it will do, the follow-up, ONE button
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(s.getByTestId('log-summary')).toHaveText('To log: Call · I called · Left voicemail');
  const suggested = s.getByRole('radio', { name: 'Trying to reach Suggested' });
  await expect(suggested).toBeChecked({ timeout: 15_000 });
  await expect(suggested).toContainText('You left a voicemail. That is a try, not a conversation yet.');
  await expect(s.getByTestId('stage-step-effect')).toHaveText('No plan starts on this stage.', { timeout: 15_000 });
  const one = s.getByRole('button', { name: 'Save and change to Trying to reach' });
  await expect(one).toBeEnabled({ timeout: 15_000 });
  await expect(s.getByRole('button', { name: /^(Save|Change to|Keep)/ })).toHaveCount(1);
  // nothing is saved by choosing
  expect(await loggedNotes(noor.id)).toHaveLength(0);
  expect(await stageOf(noor.id)).toBe('new');
  await expectAtOpen(page, s, one, { 'what is being logged': s.getByTestId('log-summary'), 'the suggested choice': suggested, 'Keep': s.getByRole('radio', { name: 'Keep New lead' }), 'the effect line': s.getByTestId('stage-step-effect'), 'the follow-up chips': s.getByRole('group', { name: 'Follow-up' }) });
  if (isPhone(page)) expect(await smallTargets(s), 'log sheet targets').toEqual([]);
  expect(await axeViolations(page), 'log sheet with the stage step').toEqual([]);
  await shot(page, info, 'j10', '9-log-sheet-stage-step-in-place');
  await tap(page, one, n);
  await expect(peopleToast(page).getByText('Call logged (left voicemail). Stage: Trying to reach')).toBeVisible({ timeout: 15_000 });
  expect(n.taps, 'Log → outcome → the one button, every tap counted (no Close)').toBe(3);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // M4: the banner's words are not repeated in a second toast
  await expect(page.getByTestId('toast')).toBeEmpty();
  await expect(page.getByRole('button', { name: 'Stage: Trying to reach. Change stage' })).toBeVisible({ timeout: 15_000 });
  expect(await loggedNotes(noor.id)).toHaveLength(1);
  expect((await stageEvents(noor.id)).slice(before).map((e) => e.to_stage)).toEqual(['attempting']);
});

test('J10.10 (M6): the stage change fails after the log saved: the sheet says what was saved and what was not, the button stays enabled, and the retry makes no second note', async ({ page }, info) => {
  test.setTimeout(180_000);
  const remy = await assignedLead('Remy', suffix(info));
  const before = (await stageEvents(remy.id)).length;
  await signInAgent(page);
  await openPerson(page, remy);
  // the first stage request never reaches the API (the connection drops in the browser); everything else is real
  let dropped = 0;
  await page.route(`**/contacts/${remy.id}/stage`, async (route) => {
    if (route.request().method() === 'POST' && dropped === 0) {
      dropped += 1;
      await route.abort('connectionfailed');
    } else await route.continue();
  });
  await tap(page, logButton(page));
  const s = page.getByRole('dialog', { name: `Log for ${remy.name}` });
  await tap(page, s.getByRole('group', { name: 'Outcome' }).getByRole('button', { name: 'Left voicemail' }));
  const one = s.getByTestId('log-save');
  await expect(one).toHaveText('Save and change to Trying to reach', { timeout: 15_000 });
  await expect(one).toBeEnabled({ timeout: 15_000 });
  await tap(page, one);
  // exactly what was saved and what was not; nothing is claimed in a toast
  await expect(s.getByRole('alert')).toHaveText("Call logged (left voicemail). We could not confirm the stage change: Can't reach the server. Check your connection, then try again.", { timeout: 15_000 });
  await expect(s.getByRole('status')).toHaveText('Call logged (left voicemail)');
  await expect(peopleToast(page)).toBeEmpty();
  expect(dropped).toBe(1);
  expect(await loggedNotes(remy.id), 'the log is saved').toHaveLength(1);
  expect(await stageOf(remy.id), 'the stage is not').toBe('new');
  await expect(one).toHaveText('Change to Trying to reach');
  await expect(one).toBeEnabled();
  await shot(page, info, 'j10', '10-log-saved-stage-not');
  await tap(page, one);
  await expect(peopleToast(page).getByText('Call logged (left voicemail). Stage: Trying to reach')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await loggedNotes(remy.id), 'the retry made no second note').toHaveLength(1);
  expect((await stageEvents(remy.id)).slice(before).map((e) => e.to_stage)).toEqual(['attempting']);
});
