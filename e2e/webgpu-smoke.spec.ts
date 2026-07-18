import { expect, test } from '@playwright/test';
import { waitForWebGPU } from './helpers/renderer';

test.describe('Chromashift WebGPU smoke', () => {
  test('boots with WebGPU renderer and shows canvas', async ({ page }) => {
    test.setTimeout(60_000);

    await page.goto('/?renderer=webgpu');
    await waitForWebGPU(page);

    const breadcrumbs = await page.evaluate(() => ({
      rendererType: window.rendererType,
      usingWebGPU: window.usingWebGPU,
      usingWebGL: window.usingWebGL,
      rendererFallbackReason: window.rendererFallbackReason ?? null,
    }));

    expect(breadcrumbs.rendererType).toBe('webgpu');
    expect(breadcrumbs.usingWebGPU).toBe(true);
    expect(breadcrumbs.usingWebGL).toBe(false);
    expect(breadcrumbs.rendererFallbackReason).toBeNull();

    await expect(page.locator('canvas').first()).toBeVisible();
  });
});
