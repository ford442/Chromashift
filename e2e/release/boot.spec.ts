import { test, expect } from './gate';
import { appUrl, expectDrawing, openApp, shoot } from './helpers';

/**
 * Boot, and what a deployed build must answer for itself: the build stamp, the
 * renderer breadcrumbs, a frame that is not black, the no-adapter screen.
 */

test.describe('boot', () => {
  test('the live version.json is the expected commit and clean', async ({ request }) => {
    const response = await request.get('version.json');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toMatch(/application\/json/);
    const stamp = (await response.json()) as { sha: string; dirty: boolean; builtAt: string };
    expect(stamp.sha).toMatch(/^[0-9a-f]{40}$/);
    if (process.env.RELEASE_ALLOW_DIRTY !== '1') {
      expect(stamp.dirty, 'a dirty build is not an identifiable release').toBe(false);
    }
    expect(Number.isNaN(Date.parse(stamp.builtAt))).toBe(false);
    const expected = process.env.RELEASE_SHA?.trim();
    if (expected) expect(stamp.sha, 'live version.json sha').toBe(expected);
    test.info().annotations.push({ type: 'version', description: JSON.stringify(stamp) });
  });

  test('the page publishes the same stamp as version.json', async ({ page, request, renderer }) => {
    await openApp(page, renderer);
    const live = (await (await request.get('version.json')).json()) as { sha: string };
    const onPage = await page.evaluate(() => window.chromashiftBuild);
    expect(onPage?.sha).toBe(live.sha);
  });

  test('boots, publishes breadcrumbs and draws a frame', async ({ page, renderer }) => {
    await openApp(page, renderer);

    const crumbs = await page.evaluate(() => ({
      rendererType: window.rendererType,
      usingWebGPU: window.usingWebGPU === true,
      usingWebGL: window.usingWebGL === true,
    }));
    expect(crumbs.rendererType).toBe(renderer);
    expect(crumbs.usingWebGPU).toBe(renderer === 'webgpu');
    expect(crumbs.usingWebGL).toBe(renderer === 'webgl');

    await expect(page.getByText('NUNIF Controls')).toBeVisible();
    if (renderer === 'webgl') await expect(page.getByTestId('webgl2-banner')).toContainText('WEBGL2 active');
    else await expect(page.getByTestId('webgl2-banner')).toHaveCount(0);

    await expectDrawing(page, renderer);
    await shoot(page, `boot-${renderer}`, renderer, 'Cold boot, first corpus image');
  });
});

test.describe('no WebGPU adapter', () => {
  test.beforeEach(({ renderer }) => {
    test.skip(renderer !== 'webgpu', 'The no-adapter screen belongs to the WebGPU session');
  });

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
