// Parity module 67 (stage automation) against the REAL API (e2e/agent/stack.ts: the API harness on a fresh
// per-test Postgres database as RLS-bound app_user, fake providers), on the phone (iPhone 13, 390×844) and
// desktop (1440×900) projects. The job: "Stage → Active starts the buyer plan", visible on the stage-change
// toast, with the stage change still 2 taps (PARITY_PLAN §5: pill → stage). A person who opted out is told
// why the plan did not start, on the same toast. The plan is the agent's OWN approved agent playbook,
// created and approved through the API as the agent (the toast is the module's only UI).
import { mkdirSync } from 'node:fs';
import { type Locator, type Page, expect, test } from 'playwright/test';
import { type AgentStack, startAgentStack } from '../agent/stack.js';

const SHOTS = process.env.STAGE_SHOTS_DIR ?? '';

test.describe.configure({ mode: 'serial' });

let stack: AgentStack;
let agent: { email: string; password: string };
let planReady = false;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startAgentStack();
  agent = await stack.fixture('/world');
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

async function signIn(page: Page) {
  await page.goto(`${stack.webUrl}/login`);
  await page.getByLabel('Email').fill(agent.email);
  await page.getByLabel('Password').fill(agent.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
}

/** The agent's own "Buyer plan": created, approved and pointed at Active through the API, as the agent. */
async function ensureBuyerPlan(page: Page) {
  if (planReady) return;
  const s = await page.request.get(`${stack.webUrl}/api/auth/session`);
  const sj = (await s.json()) as { csrfToken?: string; session?: { csrfToken?: string } };
  const csrf = sj.session?.csrfToken ?? sj.csrfToken ?? '';
  const headers = { 'x-csrf-token': csrf, origin: stack.webUrl, 'content-type': 'application/json' };
  const step = { stepKey: 'check_in', channel: 'sms', delay: { anchor: 'enrollment', offsetSeconds: 3600 }, purpose: 'marketing', category: 'nurture_step', intent: 'check_in', template: 'Hi {{first_name}}, checking in on your home search.', personalization: 'none', slots: ['first_name'], maxLength: 640, stopIf: [] };
  const c = await page.request.post(`${stack.webUrl}/api/playbooks`, { headers, data: { kind: 'nurture', scope: 'agent', name: 'Buyer plan', steps: [step] } });
  expect(c.status(), await c.text()).toBe(201);
  const pb = ((await c.json()) as { playbook: { id: string; versions: { id: string; contentSha256: string }[] } }).playbook;
  const v = pb.versions[0]!;
  const a = await page.request.post(`${stack.webUrl}/api/playbook-versions/${v.id}/approve`, { headers, data: { attestation: 'I reviewed these messages and approve them.', contentSha256: v.contentSha256 } });
  expect(a.status(), await a.text()).toBe(200);
  const st = await page.request.put(`${stack.webUrl}/api/playbooks/${pb.id}/auto-enroll-stage`, { headers, data: { stage: 'active' } });
  expect(st.status(), await st.text()).toBe(200);
  planReady = true;
}

async function openContact(page: Page, id: string, name: string) {
  await page.goto(`${stack.webUrl}/contacts/${id}`);
  await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Stage: / })).toBeVisible({ timeout: 15_000 });
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.screenshot({ path: `${SHOTS}/${isPhone(page) ? 'phone' : 'desktop'}-${name}.png` });
}

test('R-PAR-16 Stage → Active starts the buyer plan, shown on the stage toast; the stage change stays 2 taps', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  await ensureBuyerPlan(page);
  const amy = await stack.fixture<{ id: string; name: string }>('/contact', { firstName: 'Amy', lastName: isPhone(page) ? 'Phone' : 'Desk' });
  await openContact(page, amy.id, amy.name);
  const stage = { taps: 0 };
  await tap(page, page.getByRole('button', { name: 'Stage: New. Change stage' }), stage);
  await tap(page, page.getByRole('dialog').getByRole('button', { name: /^Active/ }), stage);
  const toast = page.getByTestId('people-toast');
  await expect(toast.getByText('Stage: Active. Started Buyer plan')).toBeVisible();
  expect(stage.taps).toBe(2);
  // the Undo target on the toast is a real 44 px target
  const undo = toast.getByRole('button', { name: 'Undo' });
  const box = await undo.boundingBox();
  expect(Math.min(box!.width, box!.height)).toBeGreaterThanOrEqual(44);
  await shot(page, 'stage-started');
  // Undo moves the stage back and says honestly that the plan keeps running
  await undo.click();
  await expect(toast.getByText('Stage back to New. Buyer plan is still running')).toBeVisible();
});

test('R-PAR-16 D1 a person who opted out: the toast says why the plan did not start', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  await ensureBuyerPlan(page);
  const bo = await stack.fixture<{ id: string; name: string }>('/contact', { firstName: 'Bo', lastName: isPhone(page) ? 'Phone' : 'Desk', optOut: true });
  await openContact(page, bo.id, bo.name);
  await page.getByRole('button', { name: 'Stage: New. Change stage' }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^Active/ }).click();
  await expect(page.getByTestId('people-toast').getByText("Stage: Active. Buyer plan didn't start: they can't be messaged")).toBeVisible();
  await shot(page, 'stage-skipped');
});
