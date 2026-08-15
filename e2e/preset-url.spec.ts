import { expect, test } from '@playwright/test';
import { setE2eViewport } from './helpers/mockCorpus';
import { primeOverlaySections } from './helpers/overlaySections';
import { encodePresetParam, SAMPLE_PRESET_DOCUMENT } from './helpers/presetParam';
import { waitForWebGL } from './helpers/renderer';
import { skipWhileWebGlDisabled } from './helpers/rendererPhase';

test.describe('Preset URL hydration', () => {
  skipWhileWebGlDisabled();
  test.beforeEach(async ({ page }) => {
    await setE2eViewport(page);
  });

  test('applies layer opacity and tracer intensity from ?preset=', async ({ page }) => {
    const preset = encodePresetParam(SAMPLE_PRESET_DOCUMENT);

    await page.goto(`/?renderer=webgl&preset=${preset}`);
    await waitForWebGL(page);
    await expect(page.getByText('NUNIF Controls')).toBeVisible();

    const layersSection = page.locator('.section-divider').filter({ hasText: '🌍 Layers & Global' });
    await expect(layersSection.getByText('66%', { exact: true })).toBeVisible();

    const tracerSection = page.locator('.section-divider').filter({ hasText: '✨ Dual Tracer' });
    await expect(tracerSection.getByText('42%', { exact: true })).toBeVisible();
  });

  test('shows a friendly error for an invalid ?preset= value', async ({ page }) => {
    await primeOverlaySections(page, { presets: true });
    await page.goto('/?renderer=webgl&preset=%%%broken%%%');
    await waitForWebGL(page);
    await expect(page.getByText('NUNIF Controls')).toBeVisible();

    await expect(
      page.getByText(/could not be read/i),
    ).toBeVisible();
  });
});
