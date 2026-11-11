// Module 37 (web/inbox) against the REAL API (stack.ts: a fresh per-test Postgres database, the RLS-bound
// app_user, fake providers), on the phone (iPhone 13, 390 × 844) and desktop (1440 × 900) projects:
//   - a web-chat conversation and a text appear in one thread, each with its channel tag (R-INBOX-1);
//   - compose opens on the client's last open channel (web chat) and says so; replying is 2 taps from the
//     person (Open conversation → Send); the web-chat send is the STUB(22) route, answered here by a fake of
//     the §5.4 interface (the real API accepts sms | email only until module 22 lands);
//   - a reply to a chat that ended is not sent and the box moves to text, saying why (E77);
//   - a STOP texted from a phone the agent later removed still blocks texting, also on a phone added after the
//     STOP: Text is never offered and the reason names the removed number (D1, R-PAR-12); the box writes by
//     email and says why.
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Page, type Route, expect, test } from 'playwright/test';
import { type InboxStack, startInboxStack } from './stack.js';

const SHOTS = resolve(dirname(fileURLToPath(import.meta.url)), '../../test-results/inbox');
async function shot(page: Page, name: string, project: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: resolve(SHOTS, `${name}-${project}.png`), fullPage: false });
}

test.describe.configure({ mode: 'serial' });

let stack: InboxStack;
let agent: { email: string; password: string };
let jane: { id: string; name: string };
let omar: { id: string; name: string; phones: string[] };

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startInboxStack();
  agent = await stack.fixture('/world');
  jane = await stack.fixture('/contact', { firstName: 'Jane', lastName: 'Doe', text: 'Does Saturday work for 12 Oak St?', webChat: ['Hi, it is Jane again from your website', 'Is the open house still on?'] });
  omar = await stack.fixture('/contact', { firstName: 'Omar', lastName: 'Haddad', secondPhone: true, text: 'Thanks for the list', stopFromFirst: true, removeFirst: true });
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

/**
 * STUB(22): the web-chat branch of POST /contacts/:id/messages, answered by a fake of the §5.4 interface. Any
 * other send (sms, email) goes to the real API untouched.
 */
async function fakeWebChatSend(page: Page, answer: 'sent' | 'ended', seen: unknown[]) {
  await page.route(`**/api/contacts/${jane.id}/messages`, async (route: Route) => {
    const req = route.request();
    const body = req.method() === 'POST' ? (req.postDataJSON() as { channel?: string; body?: string; idempotencyKey?: string }) : null;
    if (!body || body.channel !== 'web_chat') return route.fallback();
    seen.push(body);
    if (answer === 'ended') return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'CHANNEL_NOT_CONNECTED', requestId: 'fake-22' } }) });
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ message: { id: '01900000-0000-7000-8000-0000000e5501', channel: 'web_chat', status: 'sent', statusReason: null, purpose: 'informational', body: body.body, subject: null, scheduledFor: null, dispatchedAt: new Date().toISOString() }, decision: { id: null, outcome: 'allow', reasons: [], explanation: 'Allowed', phase: 'send' }, result: 'sent' }),
    });
  });
}

test('R-INBOX-1: a web-chat conversation and a text appear in one thread with their channel tags', async ({ page }) => {
  await signIn(page);
  await page.goto(`${stack.webUrl}/contacts/${jane.id}/thread`);
  const convo = page.getByRole('list', { name: 'Conversation' });
  await expect(convo.getByText('Is the open house still on?')).toBeVisible({ timeout: 15_000 });
  await expect(convo.getByText('Does Saturday work for 12 Oak St?')).toBeVisible();
  // oldest first: the text, then the two chat messages, each tagged
  await expect(convo.locator('[data-channel-tag]')).toHaveText(['SMS', 'Web chat', 'Web chat']);
  const textRow = convo.locator('li', { hasText: 'Does Saturday work' });
  const chatRow = convo.locator('li', { hasText: 'Is the open house still on?' });
  await expect(textRow.locator('[data-channel-tag]')).toHaveText('SMS');
  await expect(chatRow.locator('[data-channel-tag]')).toHaveText('Web chat');
});

test('compose opens on the client\'s last open channel (web chat) and says why; replying is 2 taps from the person', async ({ page }, info) => {
  const seen: unknown[] = [];
  await signIn(page);
  await fakeWebChatSend(page, 'sent', seen);
  await page.goto(`${stack.webUrl}/contacts/${jane.id}`);
  // tap 1: open the conversation
  await page.getByRole('link', { name: 'Open' }).click();
  const chat = page.getByRole('radio', { name: 'Web chat' });
  await expect(chat).toBeChecked({ timeout: 15_000 });
  await expect(page.getByTestId('channel-why')).toHaveText('Replying in web chat, where Jane wrote last.');
  // Text and Email stay offered: nothing blocks them
  await expect(page.getByRole('radio', { name: 'Text' })).toBeEnabled();
  await expect(page.getByRole('radio', { name: 'Email' })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Web chat message' }).fill('Yes, Saturday 10 to 12. See you there!');
  await shot(page, 'thread-webchat', info.project.name);
  // tap 2: Send
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('toast').getByText('Sent to Jane.')).toBeVisible({ timeout: 15_000 });
  expect(seen).toEqual([expect.objectContaining({ channel: 'web_chat', body: 'Yes, Saturday 10 to 12. See you there!', idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_:.-]{8,100}$/) })]);
  // no Messenger, Instagram or messaging-window copy anywhere on the page (D2)
  await expect(page.locator('main')).not.toContainText(/messenger|instagram|messaging window|24 hours/i);
});

test('E77: a reply to a chat that ended is not sent; the box keeps the text, moves to text and says why', async ({ page }) => {
  const seen: unknown[] = [];
  await signIn(page);
  await fakeWebChatSend(page, 'ended', seen);
  await page.goto(`${stack.webUrl}/contacts/${jane.id}/thread`);
  await expect(page.getByRole('radio', { name: 'Web chat' })).toBeChecked({ timeout: 15_000 });
  await page.getByRole('textbox', { name: 'Web chat message' }).fill('Are you still there?');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText(/Not sent: the chat has ended \(Jane left the page, or the chat was turned off\)/)).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Web chat' })).toBeDisabled();
  await expect(page.getByRole('radio', { name: 'Text' })).toBeChecked();
  await expect(page.getByTestId('channel-why')).toHaveText('Writing by text: the web chat has ended.');
  await expect(page.getByRole('textbox', { name: 'Text message' })).toHaveValue('Are you still there?');
  expect(seen).toHaveLength(1);
});

test('D1 R-PAR-12 E168: a STOP from a phone the agent removed still blocks texting; Text is never offered and the reason names the removed number', async ({ page }, info) => {
  await signIn(page);
  await page.goto(`${stack.webUrl}/contacts/${omar.id}/thread?compose=sms`);
  const text = page.getByRole('radio', { name: 'Text' });
  await expect(text).toBeDisabled({ timeout: 15_000 });
  const hint = `•••‑•••‑${omar.phones[0]!.slice(-4)}`;
  await expect(text).toHaveAccessibleDescription(`Text not offered: Texted STOP from ${hint} (removed number) on ${today()}`);
  await expect(page.getByRole('radio', { name: 'Email' })).toBeChecked();
  await expect(page.getByTestId('channel-why')).toHaveText('Writing by email: texting is blocked.');
  await expect(page.getByRole('textbox', { name: 'Email message' })).toBeVisible();
  await shot(page, 'compose-removed-stop', info.project.name);
});
