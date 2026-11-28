import { expect, test } from './gate';
import { domClick } from '../helpers/domClick';
import { openApp, useTinyCorpus } from './helpers';

/**
 * Every upscaler the panel offers completes a real upscale, and a failure is
 * shown to the user (#269).
 *
 * The model list is read from the panel's own <select>: an upscaler that is
 * offered is tested, and one that stops being offered stops being tested, so
 * this cannot drift from the UI. Real model downloads and CPU inference on a
 * software rasterizer take minutes each, hence the project's long timeout.
 */

const MODEL_SELECT = 'select:has(optgroup[label^="waifu2x"])';

async function offeredModels(page: import('@playwright/test').Page): Promise<string[]> {
  await openApp(page, 'webgpu', { sections: { upscale: true } });
  return page.locator(`${MODEL_SELECT} option`).evaluateAll((options) =>
    options.map((o) => (o as HTMLOptionElement).value),
  );
}

test.describe('upscalers', () => {
  test('the panel offers both families', async ({ page }) => {
    await useTinyCorpus(page);
    const models = await offeredModels(page);
    expect(models.some((m) => m.startsWith('realesrgan:'))).toBe(true);
    expect(models.some((m) => m.startsWith('realcugan:'))).toBe(true);
    expect(models.some((m) => m.startsWith('swin_unet:'))).toBe(true);
  });

  // The offered models are known at collection time only by reading the panel,
  // so the list below is asserted equal to it by the test after it.
  const KNOWN = [
    'realesrgan:general_plus',
    'realesrgan:general_fast',
    'realesrgan:anime_plus',
    'realesrgan:anime_fast',
    'realcugan:2:conservative',
    'realcugan:4:conservative',
    'swin_unet:art',
    'swin_unet:art_scan',
    'swin_unet:photo',
  ];

  test('the models tested here are exactly the ones the panel offers', async ({ page }) => {
    await useTinyCorpus(page);
    expect(await offeredModels(page)).toEqual(KNOWN);
  });

  for (const model of KNOWN) {
    test(`${model} completes a real upscale`, async ({ page }) => {
      await useTinyCorpus(page);
      await openApp(page, 'webgpu', { sections: { upscale: true } });
      await page.locator(MODEL_SELECT).selectOption(model);
      await domClick(page.getByRole('button', { name: 'Upscale Source' }));

      const outcome = page.locator('[data-testid="upscale-status"], [data-testid="upscale-error"]');
      await expect(outcome.first()).toBeVisible({ timeout: 540_000 });
      await expect(page.getByTestId('upscale-error'), 'the upscale must not fail').toHaveCount(0);
      const text = (await page.getByTestId('upscale-status').innerText()).trim();
      const size = /^Done — (\d+)×(\d+)$/.exec(text);
      expect(size, `unexpected status "${text}"`).not.toBeNull();
      expect(Number(size![1])).toBeGreaterThan(24);
      expect(Number(size![2])).toBeGreaterThan(24);
    });
  }

  test('a forced failure is shown in the panel, not only in the console', async ({ page, gate }) => {
    gate.allow({ kind: 'console-error', match: /Upscale failed|Failed to load resource|model/i, reason: 'The model host is forced to answer 500, so the upscale fails and the app logs it.' });
    gate.allow({ kind: 'http-error', match: /realesrgan.*model\.json/, reason: 'The model host is forced to answer 500.' });
    await useTinyCorpus(page);
    await page.route('**/realesrgan/**', (route) => route.fulfill({ status: 500, headers: { 'access-control-allow-origin': '*' }, body: 'forced failure' }));
    await openApp(page, 'webgpu', { sections: { upscale: true } });
    await page.locator(MODEL_SELECT).selectOption('realesrgan:general_fast');
    await domClick(page.getByRole('button', { name: 'Upscale Source' }));

    const alert = page.getByTestId('upscale-error');
    await expect(alert).toBeVisible({ timeout: 120_000 });
    await expect(alert).toContainText('Upscale failed');
    await expect(page.getByTestId('upscale-progress')).toHaveCount(0);
    // And it stays: the busy bar is gone and the message did not go with it.
    await page.waitForTimeout(2000);
    await expect(alert).toBeVisible();
    // The panel recovers: the next job clears the old error.
    await expect(page.getByRole('button', { name: 'Upscale Source' })).toBeEnabled();
  });
});
