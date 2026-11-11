// Playwright is preinstalled globally (browsers in $PLAYWRIGHT_BROWSERS_PATH); apps/web links it with
// "playwright": "link:/opt/node-tools/node_modules/playwright". Specs import from 'playwright/test'.
// Run: pnpm --filter @realty/web test:e2e
//
// The config's own Vite dev server (for specs without a stack of their own, e.g. foundation.spec.ts) listens on
// E2E_WEB_PORT (default 5173) and is never reused: when the port is taken (`pnpm dev:web`, or another checkout's
// e2e run on the same machine) the run fails at once instead of silently testing that other front end. Two
// checkouts run side by side on different ports: E2E_WEB_PORT=5273 pnpm --filter @realty/web test:e2e
// Specs with a stack (e2e/*/stack.ts) start their own Vite and API on free ports and never use this one.
import { defineConfig, devices } from 'playwright/test';

/** E2E_WEB_PORT, else 5173; anything that is not a TCP port is refused before a server starts. */
function webPort(raw = process.env.E2E_WEB_PORT): number {
  const s = (raw ?? '').trim();
  if (s === '') return 5173;
  const port = /^\d{4,5}$/.test(s) ? Number(s) : NaN;
  if (!(port >= 1024 && port <= 65535)) throw new Error(`E2E_WEB_PORT must be a TCP port from 1024 to 65535, not "${raw}"`);
  return port;
}

const port = webPort();
const webUrl = `http://localhost:${port}`;

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  reporter: [['list']],
  use: { baseURL: webUrl, trace: 'retain-on-failure' },
  projects: [
    // BUILD_PLAN module 17: every FUB-benchmark job is asserted on a phone and on desktop.
    { name: 'phone', use: { ...devices['iPhone 13'], browserName: 'chromium' } },
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 }, browserName: 'chromium' } },
  ],
  webServer: {
    command: `pnpm exec vite --port ${port} --strictPort`,
    cwd: '..',
    url: webUrl,
    // a busy port fails fast (--strictPort, no reuse): never test a front end this run did not start
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
