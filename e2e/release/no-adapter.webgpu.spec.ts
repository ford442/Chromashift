import { test, expect } from './gate';
import { appUrl, shoot } from './helpers';

/** The no-adapter screen belongs to the WebGPU session (`*.webgpu.spec.ts`: not run by the WebGL project). */

test.describe('no WebGPU adapter', () => {
  test('shows the blocking screen, never starts WebGL by itself, and its two buttons work', async ({ page, gate, renderer }) => {
    gate.allow({
      kind: 'console-error',
      match: /WebGPU|navigator\.gpu|adapter/i,
      reason: 'The app reports the missing adapter with console.error on purpose; this scenario removes navigator.gpu.',
    });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'gpu', { configurable: true, get: () => undefined });
    });
    await page.goto(appUrl('webgpu'));

    await expect(page.getByText('WebGPU is required and failed to initialize.')).toBeVisible({ timeout: 30_000 });
    const crumbs = await page.evaluate(() => ({ gl: window.usingWebGL === true, gpu: window.usingWebGPU === true }));
    expect(crumbs).toEqual({ gl: false, gpu: false });
    await shoot(page, 'no-adapter', renderer, 'navigator.gpu removed: the blocking screen');

    // Button 1: reload the page — the same screen comes back.
    await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'Reload page' }).click()]);
    await expect(page.getByText('WebGPU is required and failed to initialize.')).toBeVisible({ timeout: 30_000 });

    // Button 2: a WebGL diagnostic session, which boots and draws.
    await page.getByRole('button', { name: 'Open WebGL diagnostic session' }).click();
    await page.waitForFunction(() => window.usingWebGL === true, undefined, { timeout: 30_000 });
    await expect(page).toHaveURL(/renderer=webgl/);
    await expect(page.getByTestId('webgl2-banner')).toBeVisible();
  });
});
