import { expect, test } from '@playwright/test';
import { waitForWebGL } from './helpers/renderer';

/**
 * `?graph=1` gate (docs/PASS_GRAPH.md).
 *
 * The default graph is the pipeline the renderer already runs, so these specs
 * assert the breadcrumbs — not the pixels. Pixel identity is pinned in
 * `src/engine/graph/shaderParity.test.ts`, which compares every emitted shader
 * against the pre-refactor source.
 */
test.describe('pass graph', () => {
  test('stays dark without the gate', async ({ page }) => {
    await page.goto('/?renderer=webgl');
    await waitForWebGL(page);

    expect(await page.evaluate(() => window.passGraphActive)).toBe(false);
    expect(await page.evaluate(() => window.passGraphCompileCount)).toBe(0);
  });

  test('compiles the default graph and publishes the schedule', async ({ page }) => {
    await page.goto('/?renderer=webgl&graph=1');
    await waitForWebGL(page);

    const crumbs = await page.evaluate(() => ({
      active: window.passGraphActive,
      compileCount: window.passGraphCompileCount,
      passes: window.passGraphPasses,
      slots: window.passGraphSlots,
      error: window.passGraphError,
    }));

    expect(crumbs.active).toBe(true);
    expect(crumbs.error).toBeNull();
    expect(crumbs.compileCount).toBe(1);
    expect(crumbs.passes).toEqual([
      'source',
      'layer0',
      'layer1',
      'layer2',
      'coincidence',
      'tracer-below',
      'tracer-above',
      'composite',
      'swapchain',
    ]);
    // 3 layer targets, 1 transient stamp + 2 ping-pong tracers, swapchain output.
    expect(crumbs.slots).toEqual({ source: 0, layer: 3, tracer: 3, output: 0 });

    await expect(page.locator('canvas').first()).toBeVisible();
  });

  test('a parameter change does not recompile the graph', async ({ page }) => {
    await page.goto('/?renderer=webgl&graph=1');
    await waitForWebGL(page);
    expect(await page.evaluate(() => window.passGraphCompileCount)).toBe(1);

    // Drive a real uniform-only change through the running renderer.
    await page.mouse.move(400, 300);
    await page.waitForTimeout(500);

    expect(await page.evaluate(() => window.passGraphCompileCount)).toBe(1);
  });
});
