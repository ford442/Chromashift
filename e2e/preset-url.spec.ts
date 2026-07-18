import { expect, test } from '@playwright/test';
import { encodePresetParam, SAMPLE_PRESET_DOCUMENT } from './helpers/presetParam';
import { waitForWebGL } from './helpers/renderer';

test.describe('Preset URL hydration', () => {
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
    await page.goto('/?renderer=webgl&preset=%%%broken%%%');
    await waitForWebGL(page);
    await expect(page.getByText('NUNIF Controls')).toBeVisible();

    await page.getByText('💾 Presets').click();
    await expect(
      page.getByText(/could not be read/i),
    ).toBeVisible();
  });
});
