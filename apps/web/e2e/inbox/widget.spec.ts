// Module 37: the website chat widget on the phone (iPhone 13, 390 × 844) and desktop (1440 × 900) projects,
// on the stand-in brokerage page src/widget/preview.html served by the dev server (the config's webServer).
// Module 22's public chat routes do not exist yet: every /api/public/chat/** request is answered by a fake of
// the PHASE2_3_PLAN §5.4 interface (STUB(22)), which also records exactly what the widget sent.
//   - the brokerage name, the disclosure and "The first reply may come from the team's assistant." are shown
//     before the visitor can write; start sends the §5.4 body with the disclosure id;
//   - the team's reply appears only once the server returns it; no typing indicator or presence ever;
//   - an ended chat says so (E77); a rate-limited start says so (E137);
//   - axe-clean in light and dark at every step; on a phone the panel takes the whole screen with 44 px targets.
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { type Page, type Route, expect, test } from 'playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(here, '../../test-results/inbox');
const PAGE = '/src/widget/preview.html';
const KEY = 'wk_preview_0123456789abcdef';
const DISCLOSURE_ID = '01900000-0000-7000-8000-0000000d15c1';
const TOKEN = 'st_e2e_0123456789abcdef0123456789ab';
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
const PRESENCE = /typing|is writing|online|available now|active now|seen|read receipt|replies in/i;

interface Fake22 {
  starts: unknown[];
  sends: unknown[];
  polls: string[];
  /** messages the "team" has sent; the fake returns them from the next poll */
  team: { id: string; body: string }[];
  ended: boolean;
  limit: boolean;
}

async function fake22(page: Page): Promise<Fake22> {
  const s: Fake22 = { starts: [], sends: [], polls: [], team: [], ended: false, limit: false };
  const at = () => new Date().toISOString();
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/public/chat/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === 'POST' && url.pathname === `/api/public/chat/${KEY}/start`) {
      s.starts.push(req.postDataJSON());
      if (s.limit) return json(route, 429, { error: { code: 'RATE_LIMITED' } });
      const b = req.postDataJSON() as { message: string };
      return json(route, 201, { token: TOKEN, messages: [{ id: 'v1', from: 'visitor', body: b.message, at: at() }], cursor: 'c1' });
    }
    if (req.method() === 'POST' && url.pathname === `/api/public/chat/session/${TOKEN}/messages`) {
      s.sends.push(req.postDataJSON());
      if (s.ended) return json(route, 410, { error: { code: 'CHANNEL_NOT_CONNECTED' } });
      const b = req.postDataJSON() as { body: string };
      return json(route, 201, { message: { id: `v${s.sends.length + 1}`, from: 'visitor', body: b.body, at: at() } });
    }
    if (req.method() === 'GET' && url.pathname === `/api/public/chat/session/${TOKEN}/poll`) {
      s.polls.push(url.searchParams.get('after') ?? '');
      const out = s.team.splice(0).map((m) => ({ ...m, from: 'team', at: at() }));
      return json(route, 200, { messages: out, cursor: `c${s.polls.length + 1}`, ended: s.ended });
    }
    return json(route, 404, { error: { code: 'NOT_FOUND' } });
  });
  return s;
}

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

test('R-INBOX-5: the widget shows the brokerage name, the disclosure and the assistant line before the visitor writes; a conversation shows only what the server returned', async ({ page }, info) => {
  const s = await fake22(page);
  await page.goto(PAGE);
  const launch = page.getByRole('button', { name: 'Chat with Harbor Realty LLC' });
  await expect(launch).toBeVisible();
  expect(await axe(page)).toEqual([]);
  await shot(page, 'closed', info.project.name);

  // tap 1: open
  await launch.click();
  const panel = page.getByRole('dialog', { name: 'Harbor Realty LLC' });
  await expect(panel).toBeVisible();
  await expect(panel.getByText('By starting a chat, you agree that Harbor Realty LLC may reply here and keep a record of this conversation.')).toBeVisible();
  await expect(panel.getByText("The first reply may come from the team's assistant.")).toBeVisible();
  await expect(panel.getByRole('textbox', { name: 'Your name' })).toBeFocused();
  if (isPhone(page)) {
    const box = await panel.boundingBox();
    expect(box).toMatchObject({ x: 0, y: 0, width: 390 });
    expect(await smallTargets(page)).toEqual([]);
  }
  expect(await axe(page)).toEqual([]);
  await shot(page, 'start', info.project.name);

  await panel.getByRole('textbox', { name: 'Your name' }).fill('Pat Lee');
  await panel.getByRole('textbox', { name: 'Phone or email' }).fill('pat@example.com');
  await panel.getByRole('textbox', { name: 'Message' }).fill('Is 12 Oak St still available?');
  // tap 2: Start chat
  await panel.getByRole('button', { name: 'Start chat' }).click();
  const log = panel.getByRole('log', { name: 'Conversation' });
  await expect(log.getByText('Is 12 Oak St still available?')).toBeVisible();
  expect(s.starts).toEqual([{ name: 'Pat Lee', email: 'pat@example.com', message: 'Is 12 Oak St still available?', disclosureId: DISCLOSURE_ID }]);
  await expect(panel).not.toContainText(PRESENCE);

  // the assistant's first reply appears only after the server has it (the next poll)
  await page.waitForTimeout(3500);
  await expect(log.locator('li')).toHaveCount(1);
  await expect(panel).not.toContainText(PRESENCE);
  s.team.push({ id: 't1', body: 'Hi Pat, this is the Harbor team assistant. Yes, it is. Ava will follow up shortly.' });
  await expect(log.getByText(/this is the Harbor team assistant/)).toBeVisible({ timeout: 10_000 });
  await expect(log.locator('li')).toHaveCount(2);
  expect(s.polls[0]).toBe('c1');

  await panel.getByRole('textbox', { name: 'Your reply' }).fill('Great, can I see it Saturday?');
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(log.getByText('Great, can I see it Saturday?')).toBeVisible();
  expect(s.sends).toEqual([{ body: 'Great, can I see it Saturday?' }]);
  await expect(panel).not.toContainText(PRESENCE);
  if (isPhone(page)) expect(await smallTargets(page)).toEqual([]);
  expect(await axe(page)).toEqual([]);
  await shot(page, 'chat', info.project.name);

  // E77: the session ends; the widget says so and offers a new chat
  s.ended = true;
  await expect(panel.getByText('This chat has ended.')).toBeVisible({ timeout: 10_000 });
  await expect(panel.getByRole('button', { name: 'Start a new chat' })).toBeVisible();
  await expect(panel.getByRole('textbox', { name: 'Your reply' })).toHaveCount(0);
  expect(await axe(page)).toEqual([]);
  await shot(page, 'ended', info.project.name);

  // Escape closes and returns focus to the chat button
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(launch).toBeFocused();
});

test('E137: a rate-limited start says so in words and keeps what the visitor typed', async ({ page }) => {
  const s = await fake22(page);
  s.limit = true;
  await page.goto(`${PAGE}#realty-chat-open`);
  const panel = page.getByRole('dialog', { name: 'Harbor Realty LLC' });
  await panel.getByRole('textbox', { name: 'Your name' }).fill('Pat Lee');
  await panel.getByRole('textbox', { name: 'Phone or email' }).fill('(415) 555-0101');
  await panel.getByRole('textbox', { name: 'Message' }).fill('Hello');
  await panel.getByRole('button', { name: 'Start chat' }).click();
  await expect(panel.getByRole('alert')).toHaveText('Too many messages right now. Please wait a minute and try again.');
  await expect(panel.getByRole('textbox', { name: 'Message' })).toHaveValue('Hello');
  expect(s.starts).toEqual([{ name: 'Pat Lee', phone: '(415) 555-0101', message: 'Hello', disclosureId: DISCLOSURE_ID }]);
});
