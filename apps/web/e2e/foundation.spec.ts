// Foundation smoke: the app document loads on both viewports and is set up for iOS safe areas.
import { expect, test } from 'playwright/test';

test('index document loads with a phone-ready viewport', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#root')).toHaveCount(1);
  const viewport = await page.locator('meta[name="viewport"]').getAttribute('content');
  expect(viewport).toContain('width=device-width');
  expect(viewport).toContain('viewport-fit=cover');
});
