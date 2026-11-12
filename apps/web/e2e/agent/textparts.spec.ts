// Lane telephony-safeguards (R-TWL-11): the thread shows the text carried in an MMS text part as plain text, and a part
// not read yet as such, against the REAL API (stack.ts: fresh Postgres, RLS-bound app_user, fake providers), on the
// phone (iPhone 13) and desktop (1440 px) projects. Opening the conversation from the contact is one tap.
import { type Page, expect, test } from 'playwright/test';
import { type AgentStack, startAgentStack } from './stack.js';

test.describe.configure({ mode: 'serial' });

let stack: AgentStack;
let agent: { email: string; password: string };
let ivy: { id: string; name: string; phone: string };

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startAgentStack();
  agent = await stack.fixture('/world');
  ivy = await stack.fixture('/contact', { firstName: 'Ivy', lastName: 'Moreno' });
  await stack.fixture('/mms-text', { phone: ivy.phone, body: 'Photo of the kitchen', parts: ['<b>Can we see it Saturday?</b>', 'second part'], read: 1 });
});
test.afterAll(async () => {
  await stack?.stop();
});

async function signIn(page: Page) {
  await page.goto(`${stack.webUrl}/login`);
  await page.getByLabel('Email').fill(agent.email);
  await page.getByLabel('Password').fill(agent.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
}

test('R-TWL-11: a read text part shows as plain text (markup never rendered); an unread one says so', async ({ page }, info) => {
  await signIn(page);
  await page.goto(`${stack.webUrl}/contacts/${ivy.id}/thread`);
  await expect(page.getByText('Text in this message: <b>Can we see it Saturday?</b>', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Part of this text hasn't been read yet.", { exact: true })).toBeVisible();
  expect(await page.locator('main b').count()).toBe(0);
  if (process.env.E2E_SHOTS_DIR) await page.screenshot({ path: `${process.env.E2E_SHOTS_DIR}/textparts-${info.project.name}.png`, fullPage: false });
});
