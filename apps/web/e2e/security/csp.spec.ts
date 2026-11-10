// Browser policy (security-headers.ts) on the PRODUCTION build: builds the app with `vite build`,
// serves it with `vite preview` (which sends webSecurityHeaders), loads it in Chromium on the phone
// and desktop projects, and asserts the headers and the injected <meta> CSP are present, the login
// page renders, and the page raises zero CSP violations. A control test proves violations are
// detected (an injected inline script is blocked and reported).
// The API is not needed: /api/* is answered by Playwright with "signed out".
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Page, expect, test } from 'playwright/test';
import { type PreviewServer, build, preview } from 'vite';
import { contentSecurityPolicy, metaContentSecurityPolicy, webSecurityHeaders } from '../../security-headers.js';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test.describe.configure({ mode: 'serial' });

let outDir: string;
let server: PreviewServer;
let baseUrl: string;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  outDir = await mkdtemp(join(tmpdir(), 'realty-web-csp-'));
  const configFile = resolve(webRoot, 'vite.config.ts');
  await build({ root: webRoot, configFile, logLevel: 'error', build: { outDir, emptyOutDir: true } });
  server = await preview({ root: webRoot, configFile, logLevel: 'error', build: { outDir }, preview: { port: 0, host: '127.0.0.1', proxy: {} } });
  const url = server.resolvedUrls?.local[0];
  if (!url) throw new Error('vite preview did not report a URL');
  baseUrl = url.replace(/\/$/, '');
});

test.afterAll(async () => {
  await server?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

interface Violations {
  events: string[];
  console: string[];
}

/** Records securitypolicyviolation events (from before any page script runs) and CSP console errors. */
async function watchViolations(page: Page): Promise<Violations> {
  const v: Violations = { events: [], console: [] };
  await page.exposeFunction('__cspViolation', (s: string) => v.events.push(s));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      (window as unknown as { __cspViolation(s: string): void }).__cspViolation(`${e.violatedDirective} blocked ${e.blockedURI || '(inline)'} at ${e.sourceFile}:${e.lineNumber}`);
    });
  });
  page.on('console', (m) => {
    const t = m.text();
    if (/Content Security Policy|Refused to|violates/i.test(t)) v.console.push(t);
  });
  await page.route('**/api/**', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAUTHENTICATED', requestId: 'e2e' } }) }));
  return v;
}

test('the production build is served with the security headers and a matching <meta> CSP', async ({ page }) => {
  await watchViolations(page);
  const res = await page.goto(`${baseUrl}/login`);
  expect(res?.status()).toBe(200);
  const headers = res!.headers();
  for (const [name, value] of Object.entries(webSecurityHeaders)) expect(headers[name.toLowerCase()], name).toBe(value);
  const csp = headers['content-security-policy'] ?? '';
  expect(csp).toBe(contentSecurityPolicy);
  expect(csp).not.toContain('unsafe-inline');
  expect(csp).not.toContain('unsafe-eval');
  expect(csp).toContain("frame-ancestors 'none'");
  const meta = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(meta).toBe(metaContentSecurityPolicy);
  expect(meta).not.toContain('frame-ancestors');
  // the CSP meta comes before every script and stylesheet
  const first = await page.evaluate(() => [...document.head.children].findIndex((el) => el.matches('script, link[rel="stylesheet"], style')));
  const metaIndex = await page.evaluate(() => [...document.head.children].findIndex((el) => el.matches('meta[http-equiv="Content-Security-Policy"]')));
  expect(metaIndex).toBeGreaterThanOrEqual(0);
  expect(metaIndex).toBeLessThan(first);
});

test('the login page renders with zero CSP violations', async ({ page }) => {
  const v = await watchViolations(page);
  await page.goto(`${baseUrl}/`);
  // signed out: the app routes to the sign-in page
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  await expect(page.getByLabel('Email')).toBeVisible();
  // styles applied (the external stylesheet loaded under style-src 'self')
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).not.toBe('');
  expect(await page.evaluate(() => document.styleSheets.length)).toBeGreaterThan(0);
  // client-side navigation to another public page still raises nothing
  await page.getByRole('link', { name: /forgot/i }).click();
  await expect(page).toHaveURL(/\/forgot-password$/);
  await page.waitForLoadState('networkidle');
  expect(v.events).toEqual([]);
  expect(v.console).toEqual([]);
});

const TENANT = { id: '01900000-0000-7000-8000-000000000001', name: 'Harbor Home Team', slug: 'harbor', role: 'owner' };
const OWNER_SESSION = {
  user: { id: '01900000-0000-7000-8000-0000000000aa', email: 'olivia@example.test', displayName: 'Olivia Owner' },
  tenant: TENANT,
  tenants: [TENANT],
  mfa: { enabled: true, verified: true, enrollmentRequired: false },
  reauthenticatedAt: null,
  csrfToken: 'csrf-e2e',
};

test('the signed-in shell and every surface page load with zero CSP violations', async ({ page }) => {
  test.setTimeout(120_000);
  const v = await watchViolations(page);
  // signed in as an Owner (sees every page); every other API call answers "not found", so each
  // surface draws its error state, which exercises the shell, design system and lazy chunks
  await page.route('**/api/**', (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path === '/api/auth/session') return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(OWNER_SESSION) });
    return r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'NOT_FOUND', requestId: 'e2e' } }) });
  });
  const id = '01900000-0000-7000-8000-0000000000c1';
  const paths = ['/', '/approvals', `/contacts/${id}`, `/contacts/${id}/thread`, '/deals', `/deals/${id}`, '/imports', `/imports/${id}`, '/listings', `/listings/${id}`, '/pond', '/search', '/tasks', '/team', '/team/scoreboard', '/settings/playbooks', `/settings/playbooks/${id}`, '/settings/compliance', '/settings/team', '/admin/members', '/admin/routing', '/admin/numbers', '/account', '/more'];
  for (const path of paths) {
    await page.goto(`${baseUrl}${path}`);
    await expect(page.locator('main, [role="main"]').first(), path).toBeVisible();
    await page.waitForLoadState('networkidle');
    // really signed in: no bounce to an auth screen
    expect(new URL(page.url()).pathname, path).not.toMatch(/^\/(login|mfa)/);
    await expect(page.getByRole('navigation').first(), path).toBeVisible();
  }
  expect(v.events).toEqual([]);
  expect(v.console).toEqual([]);
});

test('control: an injected inline script is blocked and reported', async ({ page }) => {
  // (eval is not tested here: code run through page.evaluate is DevTools-originated and exempt from
  // CSP; the header assertions above cover the absence of 'unsafe-eval')
  const v = await watchViolations(page);
  await page.goto(`${baseUrl}/login`);
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  const ran = await page.evaluate(async () => {
    const w = window as unknown as { __inlineRan?: boolean };
    const s = document.createElement('script');
    s.textContent = 'window.__inlineRan = true;';
    document.body.appendChild(s);
    await new Promise((r) => setTimeout(r, 50));
    return w.__inlineRan === true;
  });
  expect(ran).toBe(false);
  await expect.poll(() => v.events.length).toBeGreaterThanOrEqual(1);
  expect(v.events.some((e) => e.startsWith('script-src'))).toBe(true);
  // the console listener sees the same violation, so the zero-console assertion above is meaningful
  await expect.poll(() => v.console.join('\n')).toMatch(/inline script/i);
});
