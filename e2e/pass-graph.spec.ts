import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { stubMinimalCorpus } from './helpers/mockCorpus';
import { waitForWebGL } from './helpers/renderer';
import { STRUCTURED_FIXTURE_PNG } from './helpers/structuredFixture';

/**
 * Distinct colours in the main canvas, read from the canvas itself so no UI
 * painted over it can count. WebGL preserves its drawing buffer under
 * automation (`resolveWebGL2PreserveDrawingBuffer`), so the last frame is
 * still there to read.
 */
async function canvasDistinctColours(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas')!;
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    const context = copy.getContext('2d')!;
    context.drawImage(canvas, 0, 0);
    const { data } = context.getImageData(0, 0, copy.width, copy.height);
    const seen = new Set<number>();
    for (let i = 0; i < data.length; i += 4) seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
    return seen.size;
  });
}

/**
 * The `?graph` gate (docs/PASS_GRAPH.md): which graph shape the session draws.
 *
 * The default graph is the pipeline the renderer already runs, so these specs
 * assert the breadcrumbs — not the pixels. Pixel identity is pinned in
 * `src/engine/graph/shaderParity.test.ts`, which compares every emitted shader
 * against the pre-refactor source.
 */
test.describe('pass graph', () => {
  test('reads the retired ?graph=0 as the default graph', async ({ page }) => {
    // The opt-out to the hand encoder outlived the flip by one release; with
    // the WebGPU hand encoder gone it selects nothing, on either backend.
    await page.goto('/?renderer=webgl&graph=0');
    await waitForWebGL(page);

    expect(await page.evaluate(() => window.passGraphActive)).toBe(true);
    expect(await page.evaluate(() => window.passGraphName)).toBe('default');
  });

  test('compiles with no ?graph at all, and the WebGL backend still draws it by hand', async ({ page }) => {
    await page.goto('/?renderer=webgl');
    await waitForWebGL(page);

    const crumbs = await page.evaluate(() => ({
      active: window.passGraphActive,
      name: window.passGraphName,
      compileCount: window.passGraphCompileCount,
      error: window.passGraphError,
      executing: window.passGraphExecuting ?? null,
    }));
    expect(crumbs).toEqual({ active: true, name: 'default', compileCount: 1, error: null, executing: null });
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

  // The diagnostic backend has no GLSL template for these kinds, so it must
  // refuse the shape by name — and keep drawing the default look, never a
  // black canvas or a quiet approximation of the graph it was asked for.
  for (const [name, node, kind] of [
    ['warp', 'layer0-warp', 'warp'],
    ['blur', 'layer0-blur-x', 'blur'],
    ['feedback', 'layer0-warp', 'warp'],
    ['smear', 'smear-history', 'history'],
  ] as const) {
    test(`refuses ?graph=${name} by name and keeps drawing`, async ({ page }) => {
      await stubMinimalCorpus(page);
      await page.route('**/e2e-fixture.png', (route) => route.fulfill({
        contentType: 'image/png',
        body: STRUCTURED_FIXTURE_PNG,
      }));
      await page.goto(`/?renderer=webgl&graph=${name}`);
      await waitForWebGL(page);

      const crumbs = await page.evaluate(() => ({
        active: window.passGraphActive,
        error: window.passGraphError,
        executing: window.passGraphExecuting ?? null,
      }));
      expect(crumbs.active).toBe(true);
      expect(crumbs.error).toMatch(/^unsupported-node: /);
      expect(crumbs.error).toContain(node);
      expect(crumbs.error).toContain(kind);
      expect(crumbs.executing).toBeNull();

      await expect.poll(() => canvasDistinctColours(page), { timeout: 15_000 }).toBeGreaterThan(1);
    });
  }
});
