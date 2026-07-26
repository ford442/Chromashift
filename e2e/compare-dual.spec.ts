import { expect, test } from '@playwright/test';
import { domClick } from './helpers/domClick';
import { setE2eViewport, stubMinimalCorpus } from './helpers/mockCorpus';
import { primeOverlaySections } from './helpers/overlaySections';
import { waitForWebGPU } from './helpers/renderer';

test.describe('Compare dual layout', () => {
  test.beforeEach(async ({ page }) => {
    await setE2eViewport(page);
    await stubMinimalCorpus(page);
    await primeOverlaySections(page, { viewport: true, presets: true });
  });

  test('enables dual layout with two canvases and slot labels', async ({ page }) => {
    test.setTimeout(60_000);

    await page.goto('/?renderer=webgpu');
    await waitForWebGPU(page);

    await domClick(page.getByRole('button', { name: '▢▢ Dual', exact: true }));

    await expect.poll(async () =>
      page.evaluate(() => window.compareLayout),
    ).toBe('dual');

    await expect(page.getByTestId('compare-canvas-a')).toBeVisible();
    await expect(page.getByTestId('compare-canvas-b')).toBeVisible();
    await expect(page.getByText('A · Live')).toBeVisible();
    await expect(page.getByText('B · Preset B')).toBeVisible();
  });

  test('loads a builtin preset into slot B via Compare with', async ({ page }) => {
    test.setTimeout(60_000);

    await page.goto('/?renderer=webgpu');
    await waitForWebGPU(page);

    await domClick(
      page
        .locator('div.flex.items-center')
        .filter({ hasText: 'Soft Glow' })
        .getByRole('button', { name: '⇄' }),
    );

    await expect.poll(async () =>
      page.evaluate(() => window.compareLayout),
    ).toBe('dual');

    await expect(page.getByText('B · Soft Glow')).toBeVisible();
    await expect(page.getByText(/Comparing with/)).toBeVisible();
    await expect(page.getByTestId('compare-canvas-b')).toBeVisible();
  });

  test('toggles sync-play button styling', async ({ page }) => {
    test.setTimeout(60_000);

    await page.goto('/?renderer=webgpu');
    await waitForWebGPU(page);

    await domClick(page.getByRole('button', { name: '▢▢ Dual', exact: true }));

    await expect.poll(async () =>
      page.evaluate(() => window.compareLayout),
    ).toBe('dual');

    const syncBtn = page.getByRole('button', { name: /Sync Play/i });
    await expect(syncBtn).toBeVisible();
    await expect(syncBtn).toHaveClass(/bg-amber-600/);

    await domClick(syncBtn);
    await expect(syncBtn).toHaveClass(/bg-zinc-800/);

    await domClick(syncBtn);
    await expect(syncBtn).toHaveClass(/bg-amber-600/);
  });

  test('shows multi-view performance banner when dual is active', async ({ page }) => {
    test.setTimeout(60_000);

    await page.goto('/?renderer=webgpu');
    await waitForWebGPU(page);

    await domClick(page.getByRole('button', { name: '▢▢ Dual', exact: true }));

    await expect.poll(async () =>
      page.evaluate(() => window.compareLayout),
    ).toBe('dual');

    await expect(page.getByText(/Multi-view \(2× GPU\)/)).toBeVisible();
  });
});
