import { expect, test } from '@playwright/test';

/**
 * Default (WebGPU) boot must never silently start WebGL.
 */
test.describe('WebGPU hard-fail policy', () => {
  test('does not start WebGL when the WebGPU probe fails', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'gpu', { configurable: true, get: () => undefined });
    });

    await page.goto('/?renderer=webgpu');

    await expect(page.getByText('WebGPU is required and failed to initialize.')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('button', { name: 'Open WebGL diagnostic session' })).toBeVisible();

    const crumbs = await page.evaluate(() => ({
      rendererType: window.rendererType ?? null,
      usingWebGPU: window.usingWebGPU === true,
      usingWebGL: window.usingWebGL === true,
      probeStage: window.webgpuProbe?.stage ?? null,
    }));

    expect(crumbs.usingWebGL).toBe(false);
    expect(crumbs.usingWebGPU).toBe(false);
    expect(crumbs.rendererType).toBeNull();
    expect(crumbs.probeStage).toBe('navigator-gpu');
  });

  test('successful or in-flight WebGPU boot still never sets usingWebGL', async ({ page }) => {
    await page.goto('/?renderer=webgpu');
    await page.waitForFunction(() => window.webgpuProbe != null, undefined, { timeout: 15_000 });

    const usingWebGL = await page.evaluate(() => window.usingWebGL === true);
    expect(usingWebGL).toBe(false);
  });
});
