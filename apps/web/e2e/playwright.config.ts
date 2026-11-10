// Playwright is preinstalled globally (browsers in $PLAYWRIGHT_BROWSERS_PATH); apps/web links it with
// "playwright": "link:/opt/node-tools/node_modules/playwright". Specs import from 'playwright/test'.
// Run: pnpm --filter @realty/web test:e2e
import { defineConfig, devices } from 'playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:5173', trace: 'retain-on-failure' },
  projects: [
    // BUILD_PLAN module 17: every FUB-benchmark job is asserted on a phone and on desktop.
    { name: 'phone', use: { ...devices['iPhone 13'], browserName: 'chromium' } },
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 }, browserName: 'chromium' } },
  ],
  webServer: {
    command: 'pnpm exec vite --port 5173 --strictPort',
    cwd: '..',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
