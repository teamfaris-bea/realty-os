// module 46 e2e helpers: a second browser context for the client (her own cookies), and the portal's steps.
import { readFileSync } from 'node:fs';
import { type Browser, type BrowserContext, type Page, type TestInfo, expect } from 'playwright/test';
import { isPhone, tap } from '../journeys/helpers.js';
import type { PortalStack } from './stack.js';
import { portalUrl } from './stack.js';

export const ACCEPTED =
  'If that email or phone number is the one your agent set up, and it can get messages from us, we sent a sign-in link. It works once, for 15 minutes. Nothing after a few minutes? Ask your agent.';
export const LINK_USED = 'That sign-in link no longer works. Links work once, for 15 minutes; ask for a new one.';
export const NOT_AVAILABLE = 'Client sign-in is not available right now. Ask your agent.';

/** A fresh context with this project's device (phone or desktop) and no cookies. */
export async function newClientContext(browser: Browser, info: TestInfo, extra: Parameters<Browser['newContext']>[0] = {}): Promise<BrowserContext> {
  const { viewport, deviceScaleFactor, isMobile, hasTouch, userAgent, colorScheme } = info.project.use;
  return browser.newContext({ ...(viewport ? { viewport } : {}), ...(deviceScaleFactor ? { deviceScaleFactor } : {}), ...(isMobile !== undefined ? { isMobile } : {}), ...(hasTouch !== undefined ? { hasTouch } : {}), ...(userAgent ? { userAgent } : {}), ...(colorScheme ? { colorScheme } : {}), acceptDownloads: true, ...extra });
}

/** Jane asks for a link by email on the portal page and gets 45's sentence; returns the link from the fake email. */
export async function requestLink(page: Page, stack: PortalStack, slug: string, email: string): Promise<string> {
  const before = await stack.emailCount(email);
  await page.goto(portalUrl(stack, slug));
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in to your client portal' })).toBeVisible({ timeout: 20_000 });
  await page.getByLabel('Email address').fill(email);
  await tap(page, page.getByRole('button', { name: 'Send me a sign-in link' }));
  await expect(page.locator('main').getByText(ACCEPTED)).toBeVisible();
  const l = await stack.link(email, before);
  if (!l.link) throw new Error('no sign-in link reached the fake email');
  return l.link;
}

/** Opens a sign-in link and taps Sign in (one counted tap). */
export async function openLinkAndSignIn(page: Page, link: string, taps?: { taps: number }) {
  await page.goto(link);
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible({ timeout: 20_000 });
  expect(page.url()).not.toContain('token');
  await tap(page, page.getByRole('button', { name: 'Sign in' }), taps);
}

export const pdfOf = (b64: string) => Buffer.from(b64, 'base64');
export const fileBytes = (path: string) => readFileSync(path);
export { isPhone };
