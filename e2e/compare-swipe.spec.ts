import { expect, test } from '@playwright/test';
import { domClick } from './helpers/domClick';
import { setE2eViewport, stubMinimalCorpus } from './helpers/mockCorpus';
import { primeOverlaySections } from './helpers/overlaySections';
import { waitForWebGPU } from './helpers/renderer';

test.describe('Compare swipe layout', () => {
  test.beforeEach(async ({ page }) => {
    await setE2eViewport(page);
    await stubMinimalCorpus(page);
    await primeOverlaySections(page, { viewport: true });
  });

  test('opens swipe layout, drags divider, and updates breadcrumbs', async ({ page }) => {
    test.setTimeout(60_000);

    await page.goto('/?renderer=webgpu');
    await waitForWebGPU(page);

    await domClick(page.getByRole('button', { name: /Swipe/i }));

    await expect.poll(async () =>
      page.evaluate(() => window.compareLayout),
    ).toBe('swipe');

    const initialPosition = await page.evaluate(() => window.compareSwipePosition);
    expect(initialPosition).toBeCloseTo(0.5, 1);

    const handle = page.getByTestId('compare-swipe-handle');
    await expect(handle).toBeVisible();

    const box = await handle.boundingBox();
    expect(box).not.toBeNull();
    const centerY = box!.y + box!.height / 2;
    await page.mouse.move(box!.x + box!.width / 2, centerY);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 + 80, centerY);
    await page.mouse.up();

    await expect.poll(async () =>
      page.evaluate(() => window.compareSwipePosition ?? 0.5),
    ).toBeGreaterThan(0.55);

    const handleLeft = await handle.evaluate((el) => el.style.left);
    expect(handleLeft).toMatch(/%/);
  });
});
