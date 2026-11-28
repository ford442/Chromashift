import { domClick } from '../helpers/domClick';
import { expect, test } from './gate';
import { expectDrawing, openApp, shoot } from './helpers';

/**
 * Compare layouts: dual, swipe and quad. WebGPU only (`*.webgpu.spec.ts` is not run
 * by the WebGL project): the WebGL diagnostic backend is single-view, docs/COMPARE_VIEWS.md.
 */

test.describe('compare layouts', () => {
  test('dual: two canvases, both drawing, labelled', async ({ page, renderer }) => {
    await openApp(page, renderer, { sections: { viewport: true, presets: true } });
    await domClick(page.getByRole('button', { name: '▢▢ Dual', exact: true }));
    await expect.poll(() => page.evaluate(() => window.compareLayout)).toBe('dual');
    await expect(page.getByTestId('compare-canvas-a')).toBeVisible();
    await expect(page.getByTestId('compare-canvas-b')).toBeVisible();
    await expect(page.getByText('A · Live')).toBeVisible();
    await expect(page.getByText('B · Preset B')).toBeVisible();
    await expectDrawing(page, renderer, 'main');
    await expectDrawing(page, renderer, 'compare-b');
    await shoot(page, 'compare-dual', renderer, 'Dual compare layout');
  });

  test('swipe: a draggable split over one image', async ({ page, renderer }) => {
    await openApp(page, renderer, { sections: { viewport: true } });
    await domClick(page.getByRole('button', { name: /Swipe/ }).first());
    await expect.poll(() => page.evaluate(() => window.compareLayout)).toBe('swipe');
    await expect(page.getByTestId('compare-swipe-handle')).toBeVisible();
    await expectDrawing(page, renderer, 'main');
    await shoot(page, 'compare-swipe', renderer, 'Swipe compare layout');
  });

  test('quad: four analytical cells', async ({ page, renderer }) => {
    await openApp(page, renderer, { sections: { viewport: true } });
    await domClick(page.getByRole('button', { name: /Quad/ }).first());
    await expect.poll(() => page.evaluate(() => window.compareLayout)).toBe('quad');
    for (const cell of ['original', 'layers', 'tracer', 'composite']) {
      await expect(page.getByTestId(`quad-cell-${cell}`)).toBeVisible();
    }
    await expect(page.getByTestId('quad-layer-cycle')).toBeVisible();
    await shoot(page, 'compare-quad', renderer, 'Quad compare layout');
  });
});
