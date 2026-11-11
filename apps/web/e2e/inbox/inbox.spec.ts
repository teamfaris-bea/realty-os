// Module 37 (web/inbox) against the REAL API (stack.ts: a fresh per-test Postgres database, the RLS-bound
// app_user, fake providers) and module 22's real routes, on the phone (iPhone 13, 390 × 844) and desktop
// (1440 × 900) projects:
//   - a lead who started a chat on the team's website (the public chat routes, as a widget calls them), was accepted,
//     then texted from the phone the agent added and wrote again in the chat: one thread, each message tagged with
//     its channel (R-INBOX-1);
//   - compose opens on web chat while the chat is open (the reachability summary's web_chat entry) and says why;
//     replying is 2 taps from the person (Open conversation → Send), and the reply reaches the visitor's own poll,
//     from the team (R-GATE-14);
//   - when the visitor has gone (E77) a reply is not sent: the box keeps the text, moves to text and says why; on
//     the next visit the summary already says the chat ended, so Web chat is shown closed with that reason;
//   - a STOP texted from a phone the agent later removed still blocks texting, also on a phone added after the
//     STOP: Text is never offered and the reason names the removed number (D1, R-PAR-12); the box writes by
//     email and says why.
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Page, expect, test } from 'playwright/test';
import { type ChatLead, type InboxStack, type Poll, type World, startInboxStack } from './stack.js';

const SHOTS = resolve(dirname(fileURLToPath(import.meta.url)), '../../test-results/inbox');
async function shot(page: Page, name: string, project: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: resolve(SHOTS, `${name}-${project}.png`), fullPage: false });
}

test.describe.configure({ mode: 'serial' });

let stack: InboxStack;
let world: World;
let jane: ChatLead;
let omar: { id: string; name: string; phones: string[] };

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startInboxStack();
  world = await stack.fixture<World>('/world');
  jane = await stack.fixture<ChatLead>('/chat-lead', { name: 'Jane Doe', opening: 'Hi, it is Jane from your website. Is 12 Oak St still available?', text: 'Does Saturday work for 12 Oak St?', chat: ['Is the open house still on?'] });
  omar = await stack.fixture('/contact', { firstName: 'Omar', lastName: 'Haddad', secondPhone: true, text: 'Thanks for the list', stopFromFirst: true, removeFirst: true });
});
test.afterAll(async () => {
  await stack?.stop();
});

const today = (iso = new Date().toISOString()) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(iso));

async function signIn(page: Page) {
  await page.goto(`${stack.webUrl}/login`);
  await page.getByLabel('Email').fill(world.email);
  await page.getByLabel('Password').fill(world.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
}

test('R-INBOX-1: a chat started on the website, a text and the chat again appear in one thread with their channel tags', async ({ page }) => {
  await signIn(page);
  await page.goto(`${stack.webUrl}/contacts/${jane.id}/thread`);
  const convo = page.getByRole('list', { name: 'Conversation' });
  await expect(convo.getByText('Is the open house still on?')).toBeVisible({ timeout: 15_000 });
  await expect(convo.getByText('Does Saturday work for 12 Oak St?')).toBeVisible();
  await expect(convo.getByText('Hi, it is Jane from your website. Is 12 Oak St still available?')).toBeVisible();
  // oldest first: the chat's opening message, the text, then the chat again, each tagged
  await expect(convo.locator('[data-channel-tag]')).toHaveText(['Web chat', 'SMS', 'Web chat']);
  await expect(convo.locator('li', { hasText: 'Does Saturday work' }).locator('[data-channel-tag]')).toHaveText('SMS');
  await expect(convo.locator('li', { hasText: 'Is the open house still on?' }).locator('[data-channel-tag]')).toHaveText('Web chat');
});

test("R-GATE-14: compose opens on the open web chat, where Jane wrote last, and says so; replying is 2 taps from the person and reaches Jane's chat from the team", async ({ page }, info) => {
  await signIn(page);
  await page.goto(`${stack.webUrl}/contacts/${jane.id}`);
  // tap 1: open the conversation
  await page.getByRole('link', { name: 'Open' }).click();
  const chat = page.getByRole('radio', { name: 'Web chat' });
  await expect(chat).toBeChecked({ timeout: 15_000 });
  await expect(page.getByTestId('channel-why')).toHaveText('Replying in web chat, where Jane wrote last.');
  // Text stays offered (nothing blocks it); Email is not, because the address Jane typed in the chat is only an
  // unverified claim, never a contact point (E138, E154); a chat reply cannot be scheduled
  await expect(page.getByRole('radio', { name: 'Text' })).toBeEnabled();
  await expect(page.getByRole('radio', { name: 'Email' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send later' })).toHaveCount(0);
  const reply = 'Yes, Saturday 10 to 12. See you there!';
  await page.getByRole('textbox', { name: 'Web chat message' }).fill(reply);
  await shot(page, 'thread-webchat', info.project.name);
  // tap 2: Send
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('toast').getByText('Sent to Jane.')).toBeVisible({ timeout: 15_000 });
  // the reply is in the thread, tagged, and in the visitor's own chat, from the team (not the assistant)
  await expect(page.getByRole('list', { name: 'Conversation' }).locator('li', { hasText: reply }).locator('[data-channel-tag]')).toHaveText('Web chat');
  const poll = await stack.fixture<Poll>('/poll', { token: jane.token });
  expect(poll.messages.map((m) => [m.from, m.body])).toEqual([['team', reply]]);
  expect(poll.open).toBe(true);
  // no Messenger, Instagram or messaging-window copy anywhere on the page (D2)
  await expect(page.locator('main')).not.toContainText(/messenger|instagram|messaging window|24 hours/i);
});

test('E77: once Jane has left the page, a reply is not sent; the box keeps the text, moves to text and says why; the next visit shows the chat closed with the reason', async ({ page }) => {
  await signIn(page);
  await page.goto(`${stack.webUrl}/contacts/${jane.id}/thread`);
  await expect(page.getByRole('radio', { name: 'Web chat' })).toBeChecked({ timeout: 15_000 });
  const before = await stack.fixture<Poll>('/poll', { token: jane.token });
  // Jane closed the page half an hour ago (clock fixture), after this box was opened
  await stack.fixture('/age-chat', { token: jane.token });
  await page.getByRole('textbox', { name: 'Web chat message' }).fill('Are you still there?');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText(/Not sent: the chat has ended \(Jane left the page, or the chat was turned off\)/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('radio', { name: 'Text' })).toBeChecked();
  await expect(page.getByRole('textbox', { name: 'Text message' })).toHaveValue('Are you still there?');
  await expect(page.getByRole('radio', { name: 'Web chat' })).toBeDisabled();
  // nothing reached Jane's chat
  const after = await stack.fixture<Poll>('/poll', { token: jane.token, after: before.cursor });
  expect(after).toMatchObject({ messages: [], open: false });
  // the next visit: the summary says so before anyone types
  await page.reload();
  const web = page.getByRole('radio', { name: 'Web chat' });
  await expect(web).toBeDisabled({ timeout: 15_000 });
  await expect(web).toHaveAccessibleDescription('Web chat not offered: The chat has ended: they left the page');
  await expect(page.getByRole('radio', { name: 'Text' })).toBeChecked();
  await expect(page.getByTestId('channel-why')).toHaveText('Writing by text: the web chat has ended.');
  await expect(page.getByRole('list', { name: 'Conversation' }).getByText('Not sent: the chat had ended')).toBeVisible();
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
