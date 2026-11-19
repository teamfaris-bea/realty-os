// Real CSS/layout, synthetic API only. Also exercise the smallest supported phone width.
import { expect, test } from 'playwright/test';

for (const width of [320, 390, 1440]) {
  test(`stage guidance fits ${width}px with reachable Cancel and locked choices`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 568 });
    const writes: string[] = [];
    await page.route('**/api/**', async (route) => {
      if (route.request().method() !== 'GET') writes.push(route.request().url());
      await route.fulfill({ status: 200, json: { reachability: { channels: {} } } });
    });
    await page.route('**/src/main.tsx', (route) => route.fulfill({ contentType: 'text/javascript', body: 'import "/src/surfaces/people-edit/testing/StagePill.fixture.tsx";' }));
    await page.goto('/');
    await page.getByRole('button', { name: 'Stage: New. Change stage' }).click();
    const dialog = page.getByRole('dialog');
    const options = dialog.getByRole('list', { name: 'Stages' }).getByRole('button');
    await expect(options).toHaveCount(8);
    if (process.env.STAGE_SHOTS_DIR) await page.screenshot({ path: `${process.env.STAGE_SHOTS_DIR}/stage-${width}-top.png` });
    for (const option of await options.all()) {
      await option.scrollIntoViewIfNeeded();
      const box = await option.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      expect(await option.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
    const custom = dialog.getByRole('button', { name: 'ABCDEFGHIJKLMNOPQRSTUVWX Locked' });
    await expect(custom).toBeDisabled();
    await expect(custom).toHaveAccessibleDescription(/Use while a purchase or sale is under contract.*Reach them first/s);
    const cancel = dialog.getByRole('button', { name: 'Cancel' });
    await expect(cancel).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (process.env.STAGE_SHOTS_DIR) {
      await custom.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${process.env.STAGE_SHOTS_DIR}/stage-${width}.png` });
    }
    await cancel.click();
    await expect(dialog).toHaveCount(0);
    expect(writes).toEqual([]);
  });
}
