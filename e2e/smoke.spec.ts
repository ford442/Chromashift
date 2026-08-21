import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForWebGL } from './helpers/renderer';
import { primeOverlaySections } from './helpers/overlaySections';

const screenshotsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'test-screenshots',
);

test.describe('Chromashift smoke', () => {
  test('boots with WebGL renderer and publishes breadcrumbs', async ({ page }) => {
    await page.goto('/?renderer=webgl');

    await waitForWebGL(page);

    const breadcrumbs = await page.evaluate(() => ({
      rendererType: window.rendererType,
      usingWebGL: window.usingWebGL,
      usingWebGPU: window.usingWebGPU,
    }));

    expect(breadcrumbs.rendererType).toBe('webgl');
    expect(breadcrumbs.usingWebGL).toBe(true);
    expect(breadcrumbs.usingWebGPU).toBe(false);

    await expect(page.locator('canvas').first()).toBeVisible();

    fs.mkdirSync(screenshotsDir, { recursive: true });
    await page.screenshot({
      path: path.join(screenshotsDir, 'webgl-smoke.png'),
      fullPage: true,
    });
  });

  test('Renderer panel WebGL control explains diagnostic / XR, not fallback', async ({ page }) => {
    await primeOverlaySections(page, { renderer: true });
    await page.goto('/?renderer=webgl');
    await waitForWebGL(page);

    const webglButton = page.getByRole('button', { name: 'WEBGL', exact: true });
    await expect(webglButton).toBeEnabled();
    await expect(webglButton).toHaveAttribute('title', /diagnostic \/ XR/i);
    await expect(webglButton).toHaveAttribute('title', /not an automatic fallback/i);
  });
});
