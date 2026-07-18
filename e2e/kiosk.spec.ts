import { expect, test } from '@playwright/test';
import { waitForWebGL } from './helpers/renderer';

test.describe('Kiosk mode', () => {
  test('?kiosk=1 hides NUNIF chrome and shows the bottom remote', async ({ page }) => {
    await page.goto('/?kiosk=1&renderer=webgl');
    await waitForWebGL(page);

    await page.waitForFunction(() => window.kioskMode === true, undefined, {
      timeout: 15_000,
    });

    await expect(page.getByText('NUNIF Controls')).toBeHidden();

    const remote = page.locator('.kiosk-remote-btn').first();
    await expect(remote).toBeVisible();
  });
});
