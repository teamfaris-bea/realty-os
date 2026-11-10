// Phone polish and keyboard use (lane a11y-mobile), against the real stack (stack.ts).
// Phone project: reflow at 320 px and at 200 % zoom without sideways scroll or cut-off text, the
// right keyboard for each kind of input, the tab bar inside the home-indicator safe area, and
// reduced motion. Desktop project: every page is usable by keyboard with a visible focus ring, the
// skip link works, and the re-authentication dialog traps focus, closes on Escape and gives focus back.
import { type Page, expect, test } from 'playwright/test';
import { clippedText, phoneProblems } from './checks.js';
import { SWEEP_PAGES } from './pages.js';
import { settle, signIn } from './session.js';
import { type A11yStack, type World, startA11yStack } from './stack.js';

test.describe.configure({ mode: 'serial' });

let stack: A11yStack;
let world: World;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startA11yStack();
  world = await stack.world();
});
test.afterAll(async () => {
  await stack?.stop();
});

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 768;
const OWNER_PAGES = SWEEP_PAGES.filter((p) => p.roles.includes('owner'));

test.describe('phone', () => {
  test.beforeEach(({ page }) => test.skip(!isPhone(page), 'phone only'));

  test('every page reflows at 320 px and at 200 % zoom: no sideways scroll, no cut-off text', async ({ page }) => {
    test.setTimeout(300_000);
    await signIn(page, stack, world, 'owner');
    const own: string[] = [];
    const foreign: string[] = [];
    for (const p of OWNER_PAGES) {
      const found: string[] = [];
      await page.setViewportSize({ width: 320, height: 700 });
      await page.goto(`${stack.webUrl}${p.url(world.ids)}`);
      await settle(page);
      found.push(...(await phoneProblems(page)).map((x) => `320px ${p.path}: ${x}`));
      // 200 % zoom on a 390 px phone: CSS zoom scales layout and text exactly like browser zoom
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => ((document.documentElement.style as CSSStyleDeclaration & { zoom: string }).zoom = '2'));
      await page.waitForTimeout(100);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 0) found.push(`200% ${p.path}: scrolls sideways by ${overflow}px`);
      found.push(...(await clippedText(page)).map((x) => `200% ${p.path}: ${x}`));
      (p.foreignLane ? foreign : own).push(...found);
    }
    if (foreign.length) test.info().annotations.push({ type: 'other lane (optout-visibility) reflow findings', description: foreign.join('\n') });
    expect(own).toEqual([]);
  });

  test('inputs raise the right keyboard: email, numbers, and the one-time code', async ({ page }) => {
    await page.goto(`${stack.webUrl}/login`);
    const email = page.getByLabel('Email');
    await expect(email).toHaveAttribute('type', 'email');
    await expect(email).toHaveAttribute('autocomplete', 'username');
    await email.fill(world.users.owner.email);
    await page.getByLabel('Password').fill(world.users.owner.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    const code = page.getByLabel('Code');
    await expect(code).toHaveAttribute('inputmode', 'numeric');
    await expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    await code.fill(await stack.totp(world.users.owner.email));
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();

    await page.goto(`${stack.webUrl}/admin/members`);
    await settle(page);
    await expect(page.getByLabel('Email')).toHaveAttribute('type', 'email');
    await page.goto(`${stack.webUrl}/admin/numbers`);
    await settle(page);
    await expect(page.getByLabel('Area code (optional)')).toHaveAttribute('inputmode', 'numeric');
    await expect(page.getByRole('textbox', { name: 'Domain', exact: true })).toHaveAttribute('inputmode', 'url');
    await expect(page.getByLabel('From address')).toHaveAttribute('type', 'email');
    await page.goto(`${stack.webUrl}/admin/routing`);
    await settle(page);
    for (const label of ['Time to accept an offer (minutes)', 'Offers before a lead goes to the pond', 'First contact due within (minutes)']) {
      await expect(page.getByLabel(label)).toHaveAttribute('inputmode', 'numeric');
    }
    await page.goto(`${stack.webUrl}/settings/team`);
    await settle(page);
    await expect(page.getByLabel('Keep recordings for (days)')).toHaveAttribute('inputmode', 'numeric');
  });

  test('the tab bar sits inside the safe area, and the page ends above it', async ({ page }) => {
    await signIn(page, stack, world, 'agent');
    const cdp = await page.context().newCDPSession(page);
    // iPhone 13 portrait: 47 px top (notch), 34 px bottom (home indicator)
    const emulated = await cdp
      .send('Emulation.setSafeAreaInsetsOverride' as never, { insets: { top: 47, bottom: 34, left: 0, right: 0 } } as never)
      .then(() => true)
      .catch(() => false);
    await page.goto(`${stack.webUrl}/tasks`);
    await settle(page);
    const bar = page.getByRole('navigation', { name: 'Main tabs' });
    const pad = await bar.evaluate((e) => getComputedStyle(e).paddingBottom);
    const rule = await page.evaluate(() => [...document.styleSheets].flatMap((s) => [...s.cssRules]).some((r) => r.cssText.includes('.pb-safe') && r.cssText.includes('safe-area-inset-bottom')));
    expect(rule, 'pb-safe pads by env(safe-area-inset-bottom)').toBe(true);
    if (emulated) expect(pad).toBe('34px');
    test.info().annotations.push({ type: 'safe-area emulation', description: emulated ? `tab bar padding-bottom ${pad}` : 'CDP inset override unavailable; checked the CSS rule only' });
    // the tab links are full-height 44 px targets and the bar does not cover the last content
    for (const link of await bar.getByRole('link').all()) {
      const box = (await link.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    expect(await phoneProblems(page)).toEqual([]);
  });

  test('reduced motion: nothing on the page keeps animating', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await signIn(page, stack, world, 'agent');
    for (const url of ['/', '/tasks', '/deals', `/deals/${world.ids.dealId}`]) {
      await page.goto(`${stack.webUrl}${url}`);
      await settle(page);
      const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length);
      expect(running, url).toBe(0);
    }
    // the spinner is still drawn, just not spun
    const spin = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.className = 'motion-safe:animate-spin';
      document.body.appendChild(probe);
      const name = getComputedStyle(probe).animationName;
      probe.remove();
      return name;
    });
    expect(spin).toBe('none');
  });
});

test.describe('keyboard', () => {
  test.beforeEach(({ page }) => test.skip(isPhone(page), 'desktop keyboard'));

  test('the skip link is the first stop and jumps to the page', async ({ page }) => {
    await signIn(page, stack, world, 'owner');
    await page.goto(`${stack.webUrl}/tasks`);
    await settle(page);
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press('Enter');
    await expect(page.locator('main')).toBeFocused();
  });

  test('every control on every page is reachable by Tab and shows a visible focus ring', async ({ page }) => {
    test.setTimeout(300_000);
    await signIn(page, stack, world, 'owner');
    const own: string[] = [];
    const foreign: string[] = [];
    for (const p of OWNER_PAGES) {
      await page.goto(`${stack.webUrl}${p.url(world.ids)}`);
      await settle(page);
      const problems = await tabThrough(page);
      (p.foreignLane ? foreign : own).push(...problems.map((x) => `${p.path}: ${x}`));
    }
    if (foreign.length) test.info().annotations.push({ type: 'other lane (optout-visibility) keyboard findings', description: foreign.join('\n') });
    expect(own).toEqual([]);
  });

  test('the re-authentication dialog traps focus, closes on Escape and gives focus back', async ({ page }) => {
    await signIn(page, stack, world, 'owner');
    await stack.staleReauth(world.users.owner.email);
    await page.goto(`${stack.webUrl}/admin/members`);
    await settle(page);
    const card = page.getByRole('listitem').filter({ hasText: 'Isla Grant' });
    const suspend = card.getByRole('button', { name: /Suspend/ });
    await suspend.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: "Confirm it's you" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Password')).toBeFocused();
    // Tab never leaves the dialog
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    }
    // the page behind is inert
    expect(await page.locator('#root').getAttribute('inert')).not.toBeNull();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(suspend).toBeFocused();
    expect(await page.locator('#root').getAttribute('inert')).toBeNull();
    await expect(card.getByText(/Suspended/)).toHaveCount(0);
  });
});

/** Tabs through the page (up to 400 stops) and reports controls in <main> that never got focus,
 *  and focus stops with no visible indicator or outside the viewport. */
async function tabThrough(page: Page): Promise<string[]> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator('body').focus();
  const reached = new Set<string>();
  const problems: string[] = [];
  let first = '';
  for (let i = 0; i < 400; i++) {
    await page.keyboard.press('Tab');
    const r = await page.evaluate(() => {
      const e = document.activeElement as HTMLElement | null;
      if (!e || e === document.body) return null;
      if (!e.dataset.kbId) e.dataset.kbId = String(Math.random());
      const s = getComputedStyle(e);
      const ring = (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2) || (s.boxShadow !== 'none' && s.boxShadow !== '');
      const b = e.getBoundingClientRect();
      const inView = b.bottom > 0 && b.top < window.innerHeight && b.right > 0 && b.left < window.innerWidth;
      return { id: e.dataset.kbId, ring, inView, label: (e.getAttribute('aria-label') ?? e.innerText ?? e.tagName).trim().slice(0, 40) || e.tagName };
    });
    if (!r) continue;
    // a date or time input takes several Tabs (one per field); stop only when focus comes round again
    if (reached.size > 1 && r.id === first) break;
    if (reached.has(r.id)) continue;
    if (reached.size === 0) first = r.id;
    reached.add(r.id);
    if (!r.ring) problems.push(`no visible focus ring on "${r.label}"`);
    if (!r.inView) problems.push(`focused "${r.label}" is off screen`);
  }
  const missed = await page.evaluate((ids) => {
    const sel = 'main button:not([disabled]), main a[href], main input:not([disabled]):not([type=hidden]), main select:not([disabled]), main textarea:not([disabled]), main summary';
    return [...document.querySelectorAll<HTMLElement>(sel)]
      .filter((e) => e.getBoundingClientRect().width > 0 && !e.closest('[inert]'))
      .filter((e) => !ids.includes(e.dataset.kbId ?? ''))
      // one radio of a group is a single tab stop (arrow keys move within it)
      .filter((e) => !(e instanceof HTMLInputElement && e.type === 'radio') && e.getAttribute('role') !== 'radio')
      .map((e) => (e.getAttribute('aria-label') ?? e.innerText ?? e.tagName).trim().slice(0, 40) || e.tagName);
  }, [...reached]);
  for (const m of missed) problems.push(`"${m}" cannot be reached by Tab`);
  return problems;
}
