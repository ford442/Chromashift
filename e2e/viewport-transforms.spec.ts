import { expect, test } from '@playwright/test';
import { domClick } from './helpers/domClick';
import { setE2eViewport, stubMinimalCorpus } from './helpers/mockCorpus';
import { primeOverlaySections } from './helpers/overlaySections';
import {
  encodePresetParam,
  VIEWPORT_HALF_OVERLAY_PRESET,
  VIEWPORT_QUARTER_ZOOM_PRESET,
} from './helpers/presetParam';
import { waitForWebGL } from './helpers/renderer';

test.describe('Viewport transforms', () => {
  test.beforeEach(async ({ page }) => {
    await setE2eViewport(page);
    await stubMinimalCorpus(page);
    await primeOverlaySections(page, { viewport: true });
  });

  test('toggles quarter-zoom and half-overlay buttons', async ({ page }) => {
    test.setTimeout(60_000);

    await page.goto('/?renderer=webgl');
    await waitForWebGL(page);

    const quarterBtn = page.getByRole('button', { name: /Zoom Bottom-Left Quarter/i });
    await domClick(quarterBtn);
    await expect(page.getByRole('button', { name: /Exit Quarter Zoom/i })).toHaveClass(/bg-amber-600/);
    await domClick(page.getByRole('button', { name: /Exit Quarter Zoom/i }));
    await expect(quarterBtn).toBeVisible();

    const halfOverlayBtn = page.getByRole('button', { name: /Overlay Top \+ Bottom Halves/i });
    await domClick(halfOverlayBtn);
    await expect(page.getByRole('button', { name: /Exit Half Overlay/i })).toHaveClass(/bg-amber-600/);
    await domClick(page.getByRole('button', { name: /Exit Half Overlay/i }));
    await expect(halfOverlayBtn).toBeVisible();
  });

  test('mutually excludes quarter-zoom and half-overlay', async ({ page }) => {
    test.setTimeout(60_000);

    const quarterPreset = encodePresetParam(VIEWPORT_QUARTER_ZOOM_PRESET);
    await page.goto(`/?renderer=webgl&preset=${quarterPreset}`);
    await waitForWebGL(page);

    await expect(page.getByRole('button', { name: /Overlay Top \+ Bottom Halves/i })).toBeDisabled();

    const halfPreset = encodePresetParam(VIEWPORT_HALF_OVERLAY_PRESET);
    await page.goto(`/?renderer=webgl&preset=${halfPreset}`);
    await waitForWebGL(page);

    await expect(page.getByRole('button', { name: /Zoom Bottom-Left Quarter/i })).toBeDisabled();
  });

  test('hydrates quarter-zoom from ?preset= URL', async ({ page }) => {
    test.setTimeout(60_000);

    const preset = encodePresetParam(VIEWPORT_QUARTER_ZOOM_PRESET);
    await page.goto(`/?renderer=webgl&preset=${preset}`);
    await waitForWebGL(page);

    await expect(page.getByRole('button', { name: /Exit Quarter Zoom/i })).toBeVisible();
  });
});
