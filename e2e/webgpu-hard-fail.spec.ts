import { expect, test } from '@playwright/test';

/**
 * Default (WebGPU) boot must never silently start WebGL.
 * On machines without WebGPU this asserts the blocking overlay + breadcrumbs.
 * If WebGPU happens to work, usingWebGL must still be false.
 */
test.describe('WebGPU hard-fail policy', () => {
  test('does not start WebGL on a failed or successful WebGPU default boot', async ({ page }) => {
    await page.goto('/?renderer=webgpu');

    await page.waitForFunction(
      () => window.usingWebGPU === true
        || (window.usingWebGL === false && window.rendererType === null),
      undefined,
      { timeout: 30_000 },
    );

    const crumbs = await page.evaluate(() => ({
      rendererType: window.rendererType,
      usingWebGPU: window.usingWebGPU,
      usingWebGL: window.usingWebGL,
    }));

    expect(crumbs.usingWebGL).toBe(false);

    if (crumbs.usingWebGPU) {
      expect(crumbs.rendererType).toBe('webgpu');
      return;
    }

    expect(crumbs.rendererType).toBeNull();
    await expect(page.getByText('WebGPU is required and failed to initialize.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open WebGL diagnostic session' })).toBeVisible();
  });
});
