import { expect, test } from '@playwright/test';
import { domClick } from './helpers/domClick';
import { setE2eViewport, stubMinimalCorpus } from './helpers/mockCorpus';
import { primeOverlaySections } from './helpers/overlaySections';
import { waitForWebGPU } from './helpers/renderer';

test.describe('Compare quad layout', () => {
  test.beforeEach(async ({ page }) => {
    await setE2eViewport(page);
    await stubMinimalCorpus(page);
    await primeOverlaySections(page, { viewport: true });
  });

  test('opens quad layout, shows four cells, and cycles layer label', async ({ page }) => {
    test.setTimeout(60_000);

    await page.goto('/?renderer=webgpu');
    await waitForWebGPU(page);

    await domClick(page.getByRole('button', { name: /Quad/i }));

    await expect.poll(async () =>
      page.evaluate(() => window.compareLayout),
    ).toBe('quad');

    await expect(page.getByTestId('quad-cell-original')).toBeVisible();
    await expect(page.getByTestId('quad-cell-layers')).toBeVisible();
    await expect(page.getByTestId('quad-cell-tracer')).toBeVisible();
    await expect(page.getByTestId('quad-cell-composite')).toBeVisible();

    const layerButton = page.getByTestId('quad-layer-cycle');
    await expect(layerButton).toHaveText('Layer 0');
    await domClick(layerButton);
    await expect(layerButton).toHaveText('Layer 1');
    await domClick(layerButton);
    await expect(layerButton).toHaveText('Layer 2');
  });
});
