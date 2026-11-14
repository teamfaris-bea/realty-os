// module 46 (R-PORTALWEB-2; VERIFY 6): the portal's own browser policy on the PRODUCTION build. `vite build` (both
// entries), `vite preview` (realty-portal-preview sends portalSecurityHeaders for /portal.html), Chromium on the phone
// and desktop projects; /api/portal/** is answered by Playwright with bodies checked against module 45's contract.
// Zero CSP and Trusted Types violations on landing, sign-in, home, documents and a download; POSTs carry the page's
// Origin (Referrer-Policy: same-origin); /login and /portal keep the staff headers; the controls prove an inline
// script and an innerHTML write are blocked and reported.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Page, type Route, expect, test } from 'playwright/test';
import { type PreviewServer, build, preview } from 'vite';
import { portalContentSecurityPolicy, portalMetaContentSecurityPolicy, portalSecurityHeaders, webSecurityHeaders } from '../../security-headers.js';
import * as F from '../../src/portal/test/fixtures.js';
import { portalApiError, portalRequestViolations, portalResponseViolations, portalRouteFor } from '../../src/portal/test/portalContract.js';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test.describe.configure({ mode: 'serial' });

let outDir: string;
let server: PreviewServer;
let baseUrl: string;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  outDir = await mkdtemp(join(tmpdir(), 'realty-portal-csp-'));
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

interface Watch {
  events: string[];
  console: string[];
  posts: { path: string; origin: string | undefined; referer: string | undefined }[];
  problems: string[];
}

/** Violations from before any script runs, and the portal API played by its contract. */
async function watch(page: Page, signedIn = { value: false }): Promise<Watch> {
  const w: Watch = { events: [], console: [], posts: [], problems: [] };
  await page.exposeFunction('__cspViolation', (s: string) => w.events.push(s));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      (window as unknown as { __cspViolation(s: string): void }).__cspViolation(`${e.violatedDirective} blocked ${e.blockedURI || '(inline)'} at ${e.sourceFile}:${e.lineNumber}`);
    });
  });
  page.on('console', (m) => {
    const t = m.text();
    if (/Content Security Policy|Refused to|violates|TrustedHTML|Trusted Type/i.test(t)) w.console.push(t);
  });
  const answer = async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const key = portalRouteFor(req.method(), url.pathname);
    const headers = await req.allHeaders();
    if (req.method() === 'POST') w.posts.push({ path: url.pathname, origin: headers.origin, referer: headers.referer });
    const reply = (status: number, body?: unknown) => route.fulfill({ status, contentType: 'application/json', body: body === undefined ? '' : JSON.stringify(body) });
    if (!key) return reply(404, portalApiError('NOT_FOUND').body);
    const body = req.postData() ? JSON.parse(req.postData()!) : undefined;
    w.problems.push(...portalRequestViolations(key, body, Object.fromEntries(url.searchParams)).map((v) => `${key} ${v}`));
    const ok = (b: unknown) => {
      w.problems.push(...portalResponseViolations(key, b).map((v) => `fake ${key} ${v}`));
      return reply(200, b);
    };
    switch (key) {
      case 'GET /portal/me':
        return signedIn.value ? ok(F.me()) : reply(401, portalApiError('PORTAL_SESSION_REQUIRED').body);
      case 'POST /portal/login':
        return reply(202, F.accepted());
      case 'POST /portal/session':
        signedIn.value = true;
        return ok(F.session());
      case 'GET /portal/timeline':
        return ok(F.timeline());
      case 'GET /portal/documents':
        return ok(F.documents());
      case 'POST /portal/documents/:itemId/stream-token':
        return ok(F.streamToken());
      case 'GET /portal/files/:token':
        return route.fulfill({ status: 200, headers: { 'content-type': 'application/pdf', 'content-length': '8', 'content-disposition': 'attachment' }, body: Buffer.from(F.PDF) });
      case 'POST /portal/logout':
        signedIn.value = false;
        return route.fulfill({ status: 204, body: '' });
      default:
        return reply(404, portalApiError('NOT_FOUND').body);
    }
  };
  await page.route('**/api/portal/**', answer);
  await page.route('**/api/**', (r) => (new URL(r.request().url()).pathname.startsWith('/api/portal/') ? r.fallback() : r.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAUTHENTICATED', requestId: 'e2e' } }) })));
  return w;
}

test('R-PORTALWEB-2: /portal.html has the portal headers and a matching meta tag before every script and stylesheet', async ({ page }) => {
  await watch(page);
  const res = await page.goto(`${baseUrl}/portal.html?team=harbor`);
  expect(res?.status()).toBe(200);
  const h = res!.headers();
  for (const [name, value] of Object.entries(portalSecurityHeaders)) expect(h[name.toLowerCase()], name).toBe(value);
  expect(h['content-security-policy']).toBe(portalContentSecurityPolicy);
  expect(h['cache-control']).toBe('no-store');
  expect(h['referrer-policy']).toBe('same-origin');
  expect(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')).toBe(portalMetaContentSecurityPolicy);
  const first = await page.evaluate(() => [...document.head.children].findIndex((el) => el.matches('script, link[rel="stylesheet"], style')));
  const meta = await page.evaluate(() => [...document.head.children].findIndex((el) => el.matches('meta[http-equiv="Content-Security-Policy"]')));
  expect(meta).toBeGreaterThanOrEqual(0);
  expect(meta).toBeLessThan(first);
});

test('R-PORTALWEB-2, VERIFY 6: zero CSP and Trusted Types violations on sign-in, landing, home, documents and a download; POSTs carry the Origin', async ({ page }) => {
  const w = await watch(page);
  await page.goto(`${baseUrl}/portal.html?team=harbor`);
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in to your client portal' })).toBeVisible();
  await page.getByLabel('Email address').fill('jane@example.test');
  await page.getByRole('button', { name: 'Send me a sign-in link' }).click();
  await expect(page.locator('main').getByText(/^If that email or phone number/)).toBeVisible();
  await page.goto(`${baseUrl}/portal.html#token=${F.TOKEN}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Your home purchase' })).toBeVisible();
  if ((page.viewportSize()?.width ?? 1440) < 768) await page.getByRole('tab', { name: 'Documents' }).click();
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download Purchase contract.pdf' }).click();
  expect((await dl).suggestedFilename()).toBe('Purchase contract.pdf');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { level: 1, name: "You're signed out" })).toBeVisible();
  expect(w.events).toEqual([]);
  expect(w.console).toEqual([]);
  expect(w.problems).toEqual([]);
  expect(w.posts.map((p) => p.path)).toEqual(['/api/portal/login', '/api/portal/session', `/api/portal/documents/${F.DOC_1}/stream-token`, '/api/portal/logout']);
  for (const p of w.posts) {
    expect(p.origin, p.path).toBe(baseUrl);
    expect(p.referer ?? '', p.path).not.toContain('token');
  }
});

test('E697: /login, / and /portal keep the staff headers (the portal policy is /portal.html only)', async ({ page }) => {
  await watch(page);
  for (const path of ['/login', '/', '/portal']) {
    const res = await page.goto(`${baseUrl}${path}`);
    expect(res?.status(), path).toBe(200);
    expect(res!.headers()['content-security-policy'], path).toBe(webSecurityHeaders['Content-Security-Policy']);
    await expect(page.getByLabel('Password'), path).toBeVisible();
  }
});

test('control: an injected inline script and an innerHTML write are blocked and reported on the portal', async ({ page }) => {
  const w = await watch(page);
  await page.goto(`${baseUrl}/portal.html?team=harbor`);
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in to your client portal' })).toBeVisible();
  const r = await page.evaluate(async () => {
    const win = window as unknown as { __inlineRan?: boolean };
    const attempt = (f: () => void) => {
      try {
        f();
        return 'allowed';
      } catch (e) {
        return (e as Error).name;
      }
    };
    // a string into a script (Trusted Types refuses it before CSP even sees an inline script)
    const scriptText = attempt(() => {
      const s = document.createElement('script');
      s.textContent = 'window.__inlineRan = true;';
      document.body.appendChild(s);
    });
    // a script whose text arrives as a node (no TT sink): CSP script-src blocks it
    const node = attempt(() => {
      const s = document.createElement('script');
      s.appendChild(document.createTextNode('window.__inlineRan = true;'));
      document.body.appendChild(s);
    });
    const html = attempt(() => {
      document.createElement('div').innerHTML = '<b>x</b>';
    });
    await new Promise((ok) => setTimeout(ok, 50));
    return { scriptText, node, html, inline: win.__inlineRan === true };
  });
  expect(r.inline).toBe(false);
  expect(r.scriptText).toBe('TypeError');
  expect(r.html).toBe('TypeError'); // Trusted Types with no policy: a string never reaches an HTML or script sink
  await expect.poll(() => w.events.some((e) => /require-trusted-types-for/.test(e))).toBe(true);
  await expect.poll(() => w.events.length).toBeGreaterThanOrEqual(2);
});
