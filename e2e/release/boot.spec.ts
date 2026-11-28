import { test, expect } from './gate';
import { expectDrawing, openApp, shoot } from './helpers';

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
    if (renderer === 'webgpu') {
      // The renderer runs in the render worker. If its chunk is missing or unloadable the
      // app degrades to the main thread without a console error, so this is the check.
      expect(await page.evaluate(() => window.renderTransport), await page.evaluate(() => window.renderTransportReason)).toBe('worker');
    }
    if (renderer === 'webgl') await expect(page.getByTestId('webgl2-banner')).toContainText('WEBGL2 active');
    else await expect(page.getByTestId('webgl2-banner')).toHaveCount(0);

    await expectDrawing(page, renderer);
    await shoot(page, `boot-${renderer}`, renderer, 'Cold boot, first corpus image');
  });
});
