// Module 37: the website chat widget against module 22's REAL public chat routes (stack.ts: the real API, a fresh
// database, fakes for every provider), on the phone (iPhone 13, 390 × 844) and desktop (1440 × 900) projects. The
// widget runs on a stand-in brokerage website (src/widget/preview.html on http://127.0.0.1:<port>) and calls the API
// on another origin (http://localhost:<port>/api), so every call is a real cross-origin request answered by the
// API's own CORS, with no cookie. Each test is its own website visitor (its own IP for the API's rate limits).
//   - the team name, the team's notice and the server's assistant sentence are shown before the visitor writes; the
//     chat starts; the agent replies from compose and the reply appears in the widget, signed by the team; the
//     visitor answers and the agent's thread shows it (R-INBOX-5, R-GATE-14, R-INBOX-1);
//   - no typing indicator or presence ever (genuineness);
//   - a visitor gone 30 minutes: the widget says the chat ended and offers a new one (E77);
//   - the team replaced its notice after the visitor opened the chat: the new notice is shown and the next tap
//     starts the chat (WEBCHAT_DISCLOSURE_STALE);
//   - the brokerage's own link to #realty-chat-open opens the chat in place, every time it is followed;
//   - on a phone the full-screen panel keeps the keyboard inside it (the page behind is inert);
//   - a visitor who moves to another page keeps the chat (the next page polls at once, panel closed);
//   - on a website the widget may not run on, nothing is shown (the API answers 404 there);
//   - a start beyond the per-IP limit is refused in words, keeping what was typed (E137);
//   - axe-clean in light and dark at every step; on a phone the panel takes the whole screen with 44 px targets.
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from 'playwright/test';
import { CHAT_NOTICE, type InboxStack, type World, startInboxStack } from './stack.js';

const here = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(here, '../../test-results/inbox');
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
const PRESENCE = /typing|is writing|online|available now|active now|seen|read receipt|replies in/i;

test.describe.configure({ mode: 'serial' });

let stack: InboxStack;
let world: World;
let ipSeq = 0;
/** a new website visitor: their own IP for the API's per-IP limits */
const newVisitor = () => {
  ipSeq += 1;
  const ip = `203.0.113.${ipSeq + 10}`;
  stack.visitor(ip);
  return ip;
};

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startInboxStack();
  world = await stack.fixture<World>('/world');
});
test.afterAll(async () => {
  await stack?.stop();
});

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 768;

async function axe(page: Page): Promise<string[]> {
  const found: string[] = [];
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const r = await new AxeBuilder({ page: page as never }).withTags(AXE_TAGS).analyze();
    found.push(...r.violations.map((v) => `${scheme} ${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`));
  }
  await page.emulateMedia({ colorScheme: 'light' });
  return found;
}

/** Every visible control inside the widget is at least 44 × 44 px (phone). */
async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const host = document.querySelector('[data-realty-chat]');
    const root = host?.shadowRoot;
    if (!root) return ['no widget'];
    return [...root.querySelectorAll<HTMLElement>('button, input, textarea')]
      .filter((e) => e.offsetParent !== null || getComputedStyle(e).position === 'fixed')
      .map((e) => ({ e, r: e.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && (r.width < 44 || r.height < 44))
      .map(({ e, r }) => `${e.tagName.toLowerCase()} "${e.textContent ?? e.getAttribute('name')}" ${Math.round(r.width)}×${Math.round(r.height)}`);
  });
}

async function shot(page: Page, name: string, project: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: resolve(SHOTS, `widget-${name}-${project}.png`) });
}

/** The visitor's session token, as the widget keeps it in its tab. */
async function tokenOf(page: Page): Promise<string> {
  const saved = await page.evaluate((k) => sessionStorage.getItem(k), `realty-chat:${world.widgetKey}`);
  return (JSON.parse(saved ?? '{}') as { token: string }).token;
}

async function openWidget(page: Page) {
  await page.goto(stack.widgetPage(world.widgetKey));
  const launch = page.getByRole('button', { name: `Chat with ${world.teamName}` });
  await expect(launch).toBeVisible({ timeout: 15_000 });
  await launch.click();
  const panel = page.getByRole('dialog', { name: world.teamName });
  await expect(panel).toBeVisible();
  return panel;
}

async function fillStart(panel: ReturnType<Page['getByRole']>, message: string, contact = 'pat@example.com') {
  await panel.getByRole('textbox', { name: 'Your name' }).fill('Pat Lee');
  await panel.getByRole('textbox', { name: 'Phone or email' }).fill(contact);
  await panel.getByRole('textbox', { name: 'Message' }).fill(message);
}

test('R-INBOX-5 R-GATE-14: the notice comes first; the chat starts across origins; the agent replies from compose and the visitor sees it from the team; the visitor answers and the agent sees it', async ({ page }, info) => {
  test.setTimeout(120_000);
  newVisitor();
  await page.goto(stack.widgetPage(world.widgetKey));
  const launch = page.getByRole('button', { name: `Chat with ${world.teamName}` });
  await expect(launch).toBeVisible({ timeout: 15_000 });
  expect(await axe(page)).toEqual([]);
  await shot(page, 'closed', info.project.name);

  // tap 1: open. The team's notice and the server's assistant sentence come before any field.
  await launch.click();
  const panel = page.getByRole('dialog', { name: world.teamName });
  await expect(panel.getByText(CHAT_NOTICE)).toBeVisible();
  await expect(panel.getByText(world.assistantNotice)).toBeVisible();
  await expect(panel.getByRole('textbox', { name: 'Your name' })).toBeFocused();
  if (isPhone(page)) {
    expect(await panel.boundingBox()).toMatchObject({ x: 0, y: 0, width: 390 });
    expect(await smallTargets(page)).toEqual([]);
  }
  expect(await axe(page)).toEqual([]);
  await shot(page, 'start', info.project.name);

  // tap 2: Start chat
  await fillStart(panel, 'Is 12 Oak St still available?');
  await panel.getByRole('button', { name: 'Start chat' }).click();
  const log = panel.getByRole('log', { name: 'Conversation' });
  await expect(log.locator('[data-from=visitor]')).toHaveText([/Is 12 Oak St still available\?/]);
  await expect(panel).not.toContainText(PRESENCE);

  // the lead reached the team: the agent accepts it and answers from the thread, in web chat (the only channel Pat has)
  const lead = await stack.fixture<{ id: string }>('/accept-chat', { token: await tokenOf(page) });
  const agent = await page.context().newPage();
  await agent.goto(`${stack.webUrl}/login`);
  await agent.getByLabel('Email').fill(world.email);
  await agent.getByLabel('Password').fill(world.password);
  await agent.getByRole('button', { name: 'Sign in' }).click();
  await expect(agent.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
  await agent.goto(`${stack.webUrl}/contacts/${lead.id}/thread`);
  const convo = agent.getByRole('list', { name: 'Conversation' });
  await expect(convo.getByText('Is 12 Oak St still available?')).toBeVisible({ timeout: 15_000 });
  await agent.getByRole('textbox', { name: 'Web chat message' }).fill('Hi Pat, yes it is. Would Saturday at 10 work?');
  await agent.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(agent.getByTestId('toast').getByText('Sent to Pat.')).toBeVisible({ timeout: 15_000 });

  // the reply appears in the widget once the server has it, signed by the team; nothing else was shown meanwhile
  const team = log.locator('[data-from=team]');
  await expect(team).toHaveText([/Hi Pat, yes it is\. Would Saturday at 10 work\?/], { timeout: 15_000 });
  await expect(team.locator('.meta')).toHaveText(new RegExp(`^${world.teamName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} · `));
  await expect(panel).not.toContainText(PRESENCE);

  // the visitor answers; it shows once the server accepted it, and the agent's thread shows it, tagged Web chat
  await panel.getByRole('textbox', { name: 'Your reply' }).fill('Saturday at 10 works!');
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(log.locator('[data-from=visitor]')).toHaveText([/Is 12 Oak St still available\?/, /Saturday at 10 works!/]);
  const answered = convo.locator('li', { hasText: 'Saturday at 10 works!' });
  await expect(answered).toBeVisible({ timeout: 15_000 });
  await expect(answered.locator('[data-channel-tag]')).toHaveText('Web chat');
  await agent.close();

  if (isPhone(page)) expect(await smallTargets(page)).toEqual([]);
  expect(await axe(page)).toEqual([]);
  await shot(page, 'chat', info.project.name);
});

test('E77: when the visitor has been gone 30 minutes the widget says the chat ended, takes no more replies and offers a new chat; Escape returns focus to the chat button', async ({ page }, info) => {
  newVisitor();
  const panel = await openWidget(page);
  await fillStart(panel, 'Do you have anything near the park?');
  await panel.getByRole('button', { name: 'Start chat' }).click();
  await expect(panel.getByRole('textbox', { name: 'Your reply' })).toBeVisible();
  // the visitor's session has been idle 30 minutes (clock fixture): the next poll says the chat is over
  await stack.fixture('/age-chat', { token: await tokenOf(page) });
  await expect(panel.getByText('This chat has ended.', { exact: true }).last()).toBeVisible({ timeout: 10_000 });
  await expect(panel.getByRole('button', { name: 'Start a new chat' })).toBeVisible();
  await expect(panel.getByRole('textbox', { name: 'Your reply' })).toHaveCount(0);
  await expect(panel).not.toContainText('Replies appear here while this page is open.');
  // the tab forgot the session (finding chat-ended-session-readable): the next page view starts a new chat
  await expect.poll(() => page.evaluate((k) => sessionStorage.getItem(k), `realty-chat:${world.widgetKey}`)).toBeNull();
  expect(await axe(page)).toEqual([]);
  await shot(page, 'ended', info.project.name);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole('button', { name: `Chat with ${world.teamName}` })).toBeFocused();
});

test('WEBCHAT_DISCLOSURE_STALE: the team replaced its notice after the visitor opened the chat; the widget shows the new notice, keeps what was typed, and the next tap starts the chat', async ({ page }) => {
  newVisitor();
  const panel = await openWidget(page);
  await fillStart(panel, 'Hello, I have a question about a listing.', '(415) 555-0101');
  const replaced = `${CHAT_NOTICE} We updated this notice on ${new Date().toDateString()}.`;
  await stack.fixture('/replace-notice', { text: replaced });
  await panel.getByRole('button', { name: 'Start chat' }).click();
  await expect(panel.getByRole('alert')).toHaveText('The notice above has just changed. Please read it, then tap Start chat again.');
  await expect(panel.getByText(replaced)).toBeVisible();
  await expect(panel.getByRole('textbox', { name: 'Message' })).toHaveValue('Hello, I have a question about a listing.');
  await expect(panel.getByRole('textbox', { name: 'Phone or email' })).toHaveValue('(415) 555-0101');
  await panel.getByRole('button', { name: 'Start chat' }).click();
  await expect(panel.getByRole('log', { name: 'Conversation' }).locator('[data-from=visitor]')).toHaveText([/Hello, I have a question about a listing\./]);
});

test('a link on the brokerage\'s own page to #realty-chat-open opens the chat in place, without a reload, every time it is followed (findings F6, UXA-4)', async ({ page }) => {
  newVisitor();
  await page.goto(stack.widgetPage(world.widgetKey));
  await expect(page.getByRole('button', { name: `Chat with ${world.teamName}` })).toBeVisible({ timeout: 15_000 });
  const marker = await page.evaluate(() => {
    (window as { __samePage?: boolean }).__samePage = true;
    const a = document.createElement('a');
    a.href = '#realty-chat-open';
    a.textContent = 'Chat with us';
    document.querySelector('main')!.append(a);
    return true;
  });
  expect(marker).toBe(true);
  const dialog = page.getByRole('dialog', { name: world.teamName });
  for (let click = 1; click <= 3; click++) {
    await page.getByRole('link', { name: 'Chat with us' }).click();
    await expect(dialog, `click ${click}`).toBeVisible();
    await dialog.getByRole('button', { name: 'Close chat' }).click();
    await expect(dialog).toHaveCount(0);
  }
  expect(await page.evaluate(() => (window as { __samePage?: boolean }).__samePage)).toBe(true);
  // arriving on a shared link (a fresh page load, not a jump within this one) opens it; afterwards the site's own link
  // still works
  await page.goto('about:blank');
  await page.goto(`${stack.widgetPage(world.widgetKey)}#realty-chat-open`);
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.evaluate(() => {
    const a = document.createElement('a');
    a.href = '#realty-chat-open';
    a.textContent = 'Chat with us';
    document.querySelector('main')!.append(a);
  });
  await page.getByRole('link', { name: 'Chat with us' }).click();
  await expect(dialog).toBeVisible();
});

test('WCAG 2.4.11 (finding UXA-2): on a phone the full-screen chat is modal: Tab and Shift+Tab stay inside it and the page behind is inert; on desktop the page stays usable beside it', async ({ page }) => {
  newVisitor();
  await page.goto(stack.widgetPage(world.widgetKey));
  await page.evaluate(() => {
    const main = document.querySelector('main')!;
    for (const name of ['See our listings', 'Contact the office']) {
      const a = document.createElement('a');
      a.href = `#${name.replace(/ /g, '-')}`;
      a.textContent = name;
      main.append(a);
    }
  });
  await page.getByRole('button', { name: `Chat with ${world.teamName}` }).click();
  const dialog = page.getByRole('dialog', { name: world.teamName });
  await expect(dialog.getByRole('textbox', { name: 'Your name' })).toBeFocused();
  /** where the keyboard is: inside the widget, or on the page (the link text) */
  const focusIn = () => page.evaluate(() => (document.activeElement?.hasAttribute('data-realty-chat') ? 'widget' : (document.activeElement?.textContent ?? 'body')));
  if (isPhone(page)) {
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(page.locator('main')).toHaveAttribute('inert', '');
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Shift+Tab');
      expect(await focusIn(), `Shift+Tab ${i + 1}`).toBe('widget');
    }
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab');
      expect(await focusIn(), `Tab ${i + 1}`).toBe('widget');
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  } else {
    await expect(dialog).not.toHaveAttribute('aria-modal', 'true');
    await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  }
});

test('E77 (findings F2, UXA-1): a visitor who moves to another page of the site keeps the chat: the next page asks the server at once, with the panel still closed, so the session stays open', async ({ page }) => {
  newVisitor();
  const panel = await openWidget(page);
  await fillStart(panel, 'Is the open house still on Sunday?');
  await panel.getByRole('button', { name: 'Start chat' }).click();
  await expect(panel.getByRole('textbox', { name: 'Your reply' })).toBeVisible();
  const polls: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/public/chat/session/') && r.url().includes('/poll')) polls.push(r.url());
  });
  // another page of the brokerage's site in the same tab
  await page.reload();
  await expect(page.getByRole('button', { name: `Chat with ${world.teamName}` })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => polls.length, { timeout: 10_000 }).toBeGreaterThan(0);
  expect(await tokenOf(page)).toBeTruthy();
});

test('on a website the widget may not run on, nothing is shown: the API answers 404 there', async ({ page }) => {
  newVisitor();
  const refused: number[] = [];
  page.on('response', (r) => {
    if (r.url().includes(`/api/public/chat/${world.widgetKey}`)) refused.push(r.status());
  });
  await page.goto(stack.widgetPage(world.widgetKey, { site: stack.webUrl }));
  await expect(page.getByRole('heading', { level: 1, name: 'Chat widget preview' })).toBeVisible();
  await expect.poll(() => refused).toEqual([404]);
  await expect(page.locator('[data-realty-chat]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Chat with/ })).toHaveCount(0);
});

test('E137: a start beyond the per-IP limit is refused in words, and what the visitor typed stays', async ({ page }) => {
  const ip = newVisitor();
  // this visitor's IP already started the most chats a minute allows (real starts on the public route)
  const { starts } = await stack.fixture<{ starts: number }>('/exhaust-starts', { ip });
  expect(starts).toBeGreaterThan(0);
  const panel = await openWidget(page);
  await fillStart(panel, 'Hello');
  await panel.getByRole('button', { name: 'Start chat' }).click();
  // the server's own wait, and words that fit a start (finding UXA-10)
  await expect(panel.getByRole('alert')).toHaveText('Too many chats were started from this connection. Please try again in a minute.');
  await expect(panel.getByRole('textbox', { name: 'Message' })).toHaveValue('Hello');
  await expect(panel.getByRole('log', { name: 'Conversation' })).toHaveCount(0);
});
