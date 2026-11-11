// Opt-outs said before the tap, and the reason on every message that did not go out (lane
// optout-visibility), against the REAL API (stack.ts: a fresh per-test Postgres database, RLS-bound
// app_user, fake providers), on the phone (iPhone 13) and desktop (1440 px) projects:
//   - Owen texted STOP through the signed telephony webhook: Text is disabled with "Texted STOP on …";
//     Email and Call stay enabled (a text STOP blocks neither);
//   - his thread shows the attempt made afterwards as "Not sent: texted STOP on …";
//   - an agent-recorded do-not-call disables Call with "Asked not to be called (recorded by … on …)";
//   - a text held because the client replied shows "Held because Jane replied", and Send anyway sends it.
import { type Page, expect, test } from 'playwright/test';
import { type AgentStack, startAgentStack } from './stack.js';

/** The visible toast (it is also announced through the app's one live region). */
const toast = (page: Page) => page.getByTestId('toast');

test.describe.configure({ mode: 'serial' });

let stack: AgentStack;
let agent: { email: string; password: string };
let owen: { id: string; name: string; phone: string };
let dana: { id: string; name: string; phone: string };

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startAgentStack();
  agent = await stack.fixture('/world');
  owen = await stack.fixture('/contact', { firstName: 'Owen', lastName: 'Price', inbound: 'Thanks, got it', optOut: true });
  const tried = await stack.fixture<{ result: string }>('/attempt', { contactId: owen.id, body: 'Still interested in the condo?' });
  expect(tried.result).toBe('blocked');
  dana = await stack.fixture('/contact', { firstName: 'Dana', lastName: 'Whitfield', intent: 'seller' });
  await stack.fixture('/dnc', { contactId: dana.id });
});
test.afterAll(async () => {
  await stack?.stop();
});

const today = (iso = new Date().toISOString()) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(iso));

async function signIn(page: Page) {
  await page.goto(`${stack.webUrl}/login`);
  await page.getByLabel('Email').fill(agent.email);
  await page.getByLabel('Password').fill(agent.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
}

test('R-CONSENT-7: Owen texted STOP: Text is disabled with the exact sentence; Email and Call stay enabled; the thread says why the later attempt was not sent', async ({ page }) => {
  await signIn(page);
  await page.goto(`${stack.webUrl}/contacts/${owen.id}`);
  const sentence = `Texted STOP on ${today()}`;
  await expect(page.getByText(sentence, { exact: true })).toBeVisible({ timeout: 15_000 });
  const text = page.getByRole('button', { name: 'Text', exact: true });
  await expect(text).toBeDisabled();
  await expect(text).toHaveAccessibleDescription(sentence);
  await expect(page.getByRole('button', { name: 'Email', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Call', exact: true }).first()).toBeEnabled();

  await page.goto(`${stack.webUrl}/contacts/${owen.id}/thread?compose=sms`);
  await expect(page.getByText(`Not sent: texted STOP on ${today()}`)).toBeVisible({ timeout: 15_000 });
  // module 37: the box never offers Text (disabled, with the exact sentence) and writes by email, saying why
  const textOption = page.getByRole('radio', { name: 'Text' });
  await expect(textOption).toBeDisabled({ timeout: 15_000 });
  await expect(textOption).toHaveAccessibleDescription(`Text not offered: ${sentence}`);
  await expect(page.getByRole('radio', { name: 'Email' })).toBeChecked();
  await expect(page.getByTestId('channel-why')).toHaveText('Writing by email: texting is blocked.');
  await expect(page.getByRole('textbox', { name: 'Text message' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /anyway/ })).toHaveCount(0);
  // email is still open from the same box
  await page.getByRole('textbox', { name: 'Email message' }).fill('One more thing');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
});

test('an agent-recorded do-not-call disables Call with who recorded it and when; Text stays enabled', async ({ page }) => {
  await signIn(page);
  await page.goto(`${stack.webUrl}/contacts/${dana.id}`);
  const caption = page.getByText(new RegExp(`^Asked not to be called \\(recorded by .+ on ${today()}\\)$`));
  await expect(caption).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Call', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Text', exact: true })).toBeEnabled();
});

test('E27: a text held because Jane replied says so in the thread; Send anyway sends it (checked again at send time)', async ({ page }) => {
  const jane = await stack.fixture<{ id: string; phone: string }>('/contact', { firstName: 'Jane', lastName: 'Doe' });
  const held = await stack.fixture<{ status: string; statusReason: string }>('/held', { contactId: jane.id, phone: jane.phone, body: 'See you at the open house at 10', reply: 'Can we make it 11?' });
  expect(held).toMatchObject({ status: 'queued', statusReason: 'CLIENT_REPLIED_SINCE_SCHEDULED' });
  await signIn(page);
  await page.goto(`${stack.webUrl}/contacts/${jane.id}/thread`);
  await expect(page.getByText('Held because Jane replied')).toBeVisible({ timeout: 15_000 });
  const group = page.getByRole('group', { name: 'Held message' });
  await expect(group.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await group.getByRole('button', { name: 'Send anyway' }).click();
  await expect(toast(page).getByText('Sent to Jane.')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Held because Jane replied')).toHaveCount(0, { timeout: 15_000 });
});

test('E27: Cancel on a held text cancels it; nothing is sent', async ({ page }) => {
  const lena = await stack.fixture<{ id: string; phone: string }>('/contact', { firstName: 'Lena', lastName: 'Park' });
  await stack.fixture('/held', { contactId: lena.id, phone: lena.phone, body: 'Here are the HOA docs', reply: 'Never mind, found them' });
  await signIn(page);
  await page.goto(`${stack.webUrl}/contacts/${lena.id}/thread`);
  await expect(page.getByText('Held because Lena replied')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('group', { name: 'Held message' }).getByRole('button', { name: 'Cancel' }).click();
  await expect(toast(page).getByText('Canceled. Nothing was sent.')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Canceled, not sent')).toBeVisible({ timeout: 15_000 });
});
