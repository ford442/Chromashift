import { expect, test } from '@playwright/test';
import {
  DUAL_NEON_PRESET,
  DUAL_SYNC_OFF_PRESET,
  encodePresetParam,
} from './helpers/presetParam';
import { setE2eViewport, stubMinimalCorpus } from './helpers/mockCorpus';
import { primeOverlaySections } from './helpers/overlaySections';
import { waitForWebGPU } from './helpers/renderer';

test.describe('Preset compare URL hydration', () => {
  test.beforeEach(async ({ page }) => {
    await setE2eViewport(page);
    await stubMinimalCorpus(page);
    await primeOverlaySections(page, { viewport: true });
  });

  test('hydrates dual layout and slot B label from ?preset=', async ({ page }) => {
    test.setTimeout(60_000);

    const preset = encodePresetParam(DUAL_NEON_PRESET);
    await page.goto(`/?renderer=webgpu&preset=${preset}`);
    await waitForWebGPU(page);

    await expect.poll(async () =>
      page.evaluate(() => window.compareLayout),
    ).toBe('dual');

    await expect(page.getByText('B · Neon')).toBeVisible();
    await expect(page.getByTestId('compare-canvas-a')).toBeVisible();
    await expect(page.getByTestId('compare-canvas-b')).toBeVisible();
  });

  test('round-trips dual preset through reload', async ({ page }) => {
    test.setTimeout(60_000);

    const preset = encodePresetParam(DUAL_NEON_PRESET);
    const url = `/?renderer=webgpu&preset=${preset}`;
    await page.goto(url);
    await waitForWebGPU(page);

    await expect.poll(async () =>
      page.evaluate(() => window.compareLayout),
    ).toBe('dual');
    await expect(page.getByText('B · Neon')).toBeVisible();

    await page.reload();
    await waitForWebGPU(page);

    await expect.poll(async () =>
      page.evaluate(() => window.compareLayout),
    ).toBe('dual');
    await expect(page.getByText('B · Neon')).toBeVisible();

    const syncBtn = page.getByRole('button', { name: /Sync Play/i });
    await expect(syncBtn).toBeVisible();
    await expect(syncBtn).toHaveClass(/bg-amber-600/);
  });

  test('hydrates syncPlay: false from ?preset=', async ({ page }) => {
    test.setTimeout(60_000);

    const preset = encodePresetParam(DUAL_SYNC_OFF_PRESET);
    await page.goto(`/?renderer=webgpu&preset=${preset}`);
    await waitForWebGPU(page);

    await expect.poll(async () =>
      page.evaluate(() => window.compareLayout),
    ).toBe('dual');

    const syncBtn = page.getByRole('button', { name: /Sync Play/i });
    await expect(syncBtn).toBeVisible();
    await expect(syncBtn).toHaveClass(/bg-zinc-800/);
  });
});
