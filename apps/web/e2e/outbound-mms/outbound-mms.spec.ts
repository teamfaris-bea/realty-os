// D5a (outbound photo and video texts, R-MMS-8, R-MMS-9) against the REAL API (stack.ts: a fresh per-test Postgres
// database, the RLS-bound app_user, fake providers: nothing real is ever sent), on the phone (iPhone 13, 390 × 844)
// and desktop (1440 × 900) projects:
//   - a photo built here (PNG bytes) is attached through the real file input, prepared in the browser (re-encoded to
//     JPEG on a canvas), uploaded, shown as a thumbnail, removed (the staged upload is deleted), attached again and
//     sent; the outbound bubble shows the photo from the thread's attachments, and its status;
//   - an MP4 over 500 KB is refused in words before any upload, with its size and the link advice;
//   - a person blocked by a STOP sent from a phone the agent later removed: no Photo or video button, and the reason;
//   - the segment counter's emoji note, and a text over 1,600 characters refused;
//   - axe in light and dark, the 44 px tap targets and no sideways scroll (e2e/a11y/checks.ts) with two photos attached.
import { mkdirSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from 'playwright/test';
import { phoneProblems } from '../a11y/checks.js';
import { type MmsStack, type Person, type World, startMmsStack } from './stack.js';

const SHOTS = process.env.E2E_SHOTS ?? '/tmp/claude-0/sp/shots';
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

test.describe.configure({ mode: 'serial' });

let stack: MmsStack;
let world: World;
let jane: Person;
let omar: Person;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startMmsStack();
  world = await stack.fixture<World>('/world');
  jane = await stack.fixture<Person>('/contact', { firstName: 'Jane', lastName: 'Doe', text: 'Can you send me photos of the kitchen?' });
  omar = await stack.fixture<Person>('/contact', { firstName: 'Omar', lastName: 'Haddad', noEmail: true, text: 'Thanks for the list', stopFromFirst: true, secondPhone: true, removeFirst: true });
});
test.afterAll(async () => {
  await stack?.stop();
});

/** A real PNG (RGB, a gradient) of w × h, built byte by byte. */
function png(w: number, h: number, seed = 0): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    const row = y * (w * 3 + 1);
    for (let x = 0; x < w; x += 1) {
      raw[row + 1 + x * 3] = (x * 255) / w;
      raw[row + 2 + x * 3] = (y * 255) / h;
      raw[row + 3 + x * 3] = (seed * 90) % 256;
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** An MP4-looking file of `size` bytes: an ftyp box with the isom brand, then padding. */
function mp4(size: number): Buffer {
  const b = Buffer.alloc(size);
  b.writeUInt32BE(24, 0);
  b.write('ftypisom', 4, 'ascii');
  b.writeUInt32BE(0x200, 12);
  b.write('isomiso2', 16, 'ascii');
  b.writeUInt32BE(size - 24, 24);
  b.write('mdat', 28, 'ascii');
  return b;
}

async function signIn(page: Page) {
  await page.goto(`${stack.webUrl}/login`);
  await page.getByLabel('Email').fill(world.email);
  await page.getByLabel('Password').fill(world.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
}

async function openText(page: Page, who: Person) {
  await page.goto(`${stack.webUrl}/contacts/${who.id}/thread?compose=sms`);
  await expect(page.getByRole('textbox', { name: 'Text message' })).toBeVisible({ timeout: 15_000 });
}

const input = (page: Page) => page.getByTestId('media-input');
const tray = (page: Page) => page.getByTestId('media-tray');
const tiles = (page: Page) => tray(page).getByRole('listitem');

async function axe(page: Page): Promise<string[]> {
  const r = await new AxeBuilder({ page: page as never }).withTags(AXE_TAGS).analyze();
  return r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

test('R-MMS-8: a photo is prepared, uploaded and shown; Remove deletes it; attached again and sent, the outbound bubble shows the photo and its status', async ({ page }) => {
  await signIn(page);
  await openText(page, jane);
  // before a pick the limits and location are the camera button's description; the lines show once a file is picked
  await expect(page.getByRole('button', { name: 'Photo or video' })).toHaveAccessibleDescription(/^Up to 10 photos or videos, 5 MB in all; videos up to 500 KB\. Location is removed/);
  await input(page).setInputFiles({ name: 'kitchen.png', mimeType: 'image/png', buffer: png(800, 600) });
  await expect(tiles(page)).toHaveCount(1);
  await expect(tray(page).getByText('Up to 10 photos or videos, 5 MB in all; videos up to 500 KB.')).toBeVisible();
  await expect(tray(page).getByText("Location is removed from photos and videos before they're sent.")).toBeVisible();
  await expect(tiles(page).first().getByText('Ready')).toBeVisible({ timeout: 15_000 });
  // the thumbnail is the prepared JPEG, from an object URL
  const thumb = tiles(page).first().locator('img');
  await expect(thumb).toHaveAttribute('src', /^blob:/);
  expect(await thumb.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
  await expect(page.locator('[aria-live="polite"]', { hasText: 'Photo 1 ready' })).toHaveCount(1);
  expect((await stack.fixture<{ n: number }>('/live-uploads')).n).toBe(1);
  await tiles(page).first().getByRole('button', { name: 'Remove photo 1' }).click();
  await expect(tiles(page)).toHaveCount(0);
  await expect.poll(async () => (await stack.fixture<{ n: number }>('/live-uploads')).n).toBe(0);
  // attached again (the same file can be picked again) and sent with words
  await input(page).setInputFiles({ name: 'kitchen.png', mimeType: 'image/png', buffer: png(800, 600) });
  await expect(tiles(page).first().getByText('Ready')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('segment-summary')).toHaveText(/^Picture message · 1 of 10 · [\d.]+ KB of 5 MB$/);
  await page.getByRole('textbox', { name: 'Text message' }).fill('The kitchen, as promised');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('toast').getByText('Sent to Jane.')).toBeVisible({ timeout: 15_000 });
  await expect(tiles(page)).toHaveCount(0);
  const row = page.getByRole('list', { name: 'Conversation' }).locator('li[id]', { hasText: 'The kitchen, as promised' });
  const photo = row.getByRole('img', { name: 'Photo 1 of 1' });
  await expect(photo).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => photo.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBeGreaterThan(0);
  await expect(row.locator('[data-channel-tag]')).toHaveText('MMS'); // R-MMS-8 E558
  await expect(row).not.toContainText(/Not sent|Not delivered/);
  // the upload now belongs to the message: nothing is waiting
  expect((await stack.fixture<{ n: number }>('/live-uploads')).n).toBe(0);
});

test('R-MMS-8: a video over 500 KB is refused in words, with its size and the link advice, before anything is uploaded', async ({ page }) => {
  await signIn(page);
  await openText(page, jane);
  await input(page).setInputFiles({ name: 'tour.mp4', mimeType: 'video/mp4', buffer: mp4(600_001) });
  await expect(tray(page).getByRole('alert')).toHaveText('This video is 600.1 KB. A text can carry a video of at most 500 KB. For a longer video, send a link instead.');
  await expect(tiles(page)).toHaveCount(0);
  expect((await stack.fixture<{ n: number }>('/live-uploads')).n).toBe(0);
});

test('R-MMS-8 (b8 texting ui/F10): on a text thread the sticky compose bar is no taller before a photo is attached, measured at 390 x 844', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'the phone bar (iPhone 13, 390 x 844)');
  // iPhone 13's screen; the device profile's viewport is the page area under the browser bar (390 x 664)
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await openText(page, jane);
  const button = page.getByRole('button', { name: 'Photo or video' });
  await expect(button).toBeVisible();
  await expect(tray(page)).toHaveCount(0);
  const bar = page.locator('[data-sticky]');
  const box = page.getByRole('textbox', { name: 'Text message' });
  // let the bar settle (preview, counter), then measure it with the button, and again with the button taken out
  await page.waitForTimeout(500);
  const withButton = (await bar.boundingBox())!.height;
  const b = (await button.boundingBox())!;
  const t = (await box.boundingBox())!;
  // the button sits in the text field's row, a 44 px target
  expect(b.height).toBeGreaterThanOrEqual(44);
  expect(b.width).toBeGreaterThanOrEqual(44);
  expect(b.y).toBeGreaterThanOrEqual(t.y - 1);
  expect(b.y + b.height).toBeLessThanOrEqual(t.y + t.height + 1);
  const handle = await button.elementHandle();
  await handle!.evaluate((el) => ((el as HTMLElement).style.display = 'none'));
  const withoutButton = (await bar.boundingBox())!.height;
  await handle!.evaluate((el) => ((el as HTMLElement).style.display = ''));
  expect(withButton).toBe(withoutButton);
  // and the conversation keeps most of the phone: the bar's top is well below the header
  // (at a68eb12 the idle tray made this bar 427 px, its top at 233 px; now about 296 px, its top near 492 px)
  const barTop = (await bar.boundingBox())!.y;
  expect(barTop).toBeGreaterThanOrEqual(420);
  info.annotations.push({ type: 'measure', description: `compose bar ${withButton}px (without the camera button ${withoutButton}px); bar top at ${barTop}px of 844` });
  console.log(`ui/F10 measure: compose bar ${withButton}px, without the camera button ${withoutButton}px, bar top ${barTop}px of 844`);
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/compose-idle-text-thread-phone.png` });
});

test('R-MMS-8 R-PAR-12: a person blocked by a STOP sent from a phone the agent removed has no Photo or video button, and the reason is shown', async ({ page }) => {
  await signIn(page);
  await page.goto(`${stack.webUrl}/contacts/${omar.id}/thread?compose=sms`);
  const box = page.getByRole('textbox', { name: 'Text message' });
  await expect(box).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-reason="blocked"]')).toContainText(/^Texted STOP from .+ \(removed number\) on /);
  await expect(page.getByRole('button', { name: 'Photo or video' })).toHaveCount(0);
  await expect(page.getByTestId('media-tray')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
});

test('R-MMS-9: the counter names the emoji that makes each message hold 70 characters, and refuses a text over 1,600 characters', async ({ page }) => {
  await signIn(page);
  await openText(page, jane);
  const box = page.getByRole('textbox', { name: 'Text message' });
  await box.fill('See you at 3 😊');
  await expect(page.getByTestId('segment-special')).toHaveText('Because of 😊, each text message holds 70 characters instead of 160.');
  await expect(page.getByTestId('segment-summary')).toHaveText('1 text message · 15/70');
  await expect(box).toHaveAccessibleDescription(/^1 text message · 15\/70/);
  await box.fill('z'.repeat(1642));
  const tooLong = 'Too long for a text: 1,642 of 1,600 characters. Shorten it or send an email.';
  await expect(page.getByText(tooLong)).toBeVisible();
  const send = page.getByRole('button', { name: 'Send', exact: true });
  await expect(send).toBeDisabled();
  await expect(send).toHaveAccessibleDescription(tooLong);
});

test('R-MMS-8 R-MMS-9: with two photos and the counter, the box passes axe in light and dark, keeps 44 px targets and never scrolls sideways', async ({ page }, info) => {
  await signIn(page);
  await openText(page, jane);
  await page.getByRole('textbox', { name: 'Text message' }).fill('Here are the kitchen and the garden. I’ll call you after.');
  await input(page).setInputFiles([
    { name: 'kitchen.png', mimeType: 'image/png', buffer: png(1200, 900, 1) },
    { name: 'garden.png', mimeType: 'image/png', buffer: png(900, 1200, 2) },
  ]);
  await expect(tiles(page)).toHaveCount(2);
  await expect(tiles(page).getByText('Ready')).toHaveCount(2, { timeout: 15_000 });
  await expect(page.getByTestId('segment-summary')).toHaveText(/^Picture message · 2 of 10 · [\d.]+ KB of 5 MB$/);
  mkdirSync(SHOTS, { recursive: true });
  await page.getByRole('textbox', { name: 'Text message' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/compose-two-photos-${info.project.name}.png` });
  const found: string[] = [];
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    // switching the scheme in place starts colour transitions: let them finish so axe reads the settled colours
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
    found.push(...(await axe(page)).map((v) => `${scheme}: ${v}`));
  }
  await page.emulateMedia({ colorScheme: 'light' });
  expect(found).toEqual([]);
  expect(await phoneProblems(page)).toEqual([]);
  // the same box with only words: the counter names the curly apostrophe and offers Use plain quotes
  await tiles(page).first().getByRole('button', { name: 'Remove photo 1' }).click();
  await tiles(page).first().getByRole('button', { name: 'Remove photo 1' }).click();
  await expect(tiles(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Use plain quotes' })).toBeVisible();
  expect(await phoneProblems(page)).toEqual([]);
  await page.screenshot({ path: `${SHOTS}/compose-counter-${info.project.name}.png` });
});
