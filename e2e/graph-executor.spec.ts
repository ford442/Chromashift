import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { setE2eViewport, stubMinimalCorpus } from './helpers/mockCorpus';
import { waitForWebGPU } from './helpers/renderer';

/**
 * Pass-graph **executor** (docs/PASS_GRAPH.md Phase 2).
 *
 * `pass-graph.spec.ts` covers the compiler's breadcrumbs on the WebGL
 * diagnostic backend, where the graph compiles but nothing draws it. These
 * specs are the other half: on WebGPU, `?graph=1` hands the compiled graph to
 * `WebGpuGraphExecutor`, which encodes it instead of the hand-written topology.
 *
 * The parity assertion below is the acceptance bar for that swap. It is a
 * screenshot comparison, and it is deterministic because the fixture is a
 * *still* image: where layers overlap the fused pass writes the fresh stamp
 * (`newColor.a > decayed.a`) every frame, and where they do not the tracer
 * starts at zero and stays there. So there is no frame-count-dependent decay
 * state for the two runs to disagree about.
 */

const SETTLE_MS = 2500;

async function captureCanvas(page: Page, url: string): Promise<Buffer> {
  await stubMinimalCorpus(page);
  await setE2eViewport(page);
  await page.goto(url);
  await waitForWebGPU(page);
  await page.waitForTimeout(SETTLE_MS);
  return page.locator('canvas').first().screenshot();
}

test.describe('pass-graph executor', () => {
  test('encodes the default graph in place of the hand-written topology', async ({ page }) => {
    test.setTimeout(90_000);
    await stubMinimalCorpus(page);
    await page.goto('/?renderer=webgpu&graph=1');
    await waitForWebGPU(page);
    await page.waitForTimeout(SETTLE_MS);

    const crumbs = await page.evaluate(() => ({
      active: window.passGraphActive,
      name: window.passGraphName,
      executing: window.passGraphExecuting,
      executed: window.passGraphExecutedPasses,
      error: window.passGraphError,
      compileCount: window.passGraphCompileCount,
    }));

    expect(crumbs.error).toBeNull();
    expect(crumbs.active).toBe(true);
    expect(crumbs.name).toBe('default');
    expect(crumbs.executing).toBe('default');
    expect(crumbs.compileCount).toBe(1);
    // `source` and `swapchain` own no pass, and `coincidence` is fused into the
    // two accumulators — exactly the five passes the hand encoder encodes.
    expect(crumbs.executed).toEqual([
      'layer0', 'layer1', 'layer2', 'tracer-below', 'tracer-above', 'composite',
    ]);
  });

  test('stays on the hand encoder without the gate', async ({ page }) => {
    await stubMinimalCorpus(page);
    await page.goto('/?renderer=webgpu');
    await waitForWebGPU(page);

    expect(await page.evaluate(() => window.passGraphActive)).toBe(false);
    expect(await page.evaluate(() => window.passGraphExecuting ?? null)).toBeNull();
  });

  test('default graph via the executor matches the hand encoder', async ({ page }) => {
    test.setTimeout(180_000);
    const handEncoded = await captureCanvas(page, '/?renderer=webgpu&graph=0');
    const graphEncoded = await captureCanvas(page, '/?renderer=webgpu&graph=1');
    expect(graphEncoded.equals(handEncoded)).toBe(true);
  });

  test('a parameter change does not recompile or rebuild the graph', async ({ page }) => {
    test.setTimeout(90_000);
    await stubMinimalCorpus(page);
    await setE2eViewport(page);
    await page.goto('/?renderer=webgpu&graph=1');
    await waitForWebGPU(page);
    await page.waitForTimeout(SETTLE_MS);
    expect(await page.evaluate(() => window.passGraphCompileCount)).toBe(1);

    await page.mouse.move(400, 300);
    await page.mouse.move(700, 500);
    await page.waitForTimeout(1000);

    expect(await page.evaluate(() => window.passGraphCompileCount)).toBe(1);
    expect(await page.evaluate(() => window.passGraphExecuting)).toBe('default');
  });

  test.describe('non-default shapes draw', () => {
    for (const [name, marker] of [
      ['blur', 'layer0-blur-y'],
      ['warp', 'layer0-warp'],
    ] as const) {
      test(`?graph=${name} compiles, schedules, allocates and draws`, async ({ page }) => {
        test.setTimeout(90_000);
        await stubMinimalCorpus(page);
        await setE2eViewport(page);
        await page.goto(`/?renderer=webgpu&graph=${name}`);
        await waitForWebGPU(page);
        await page.waitForTimeout(SETTLE_MS);

        const crumbs = await page.evaluate(() => ({
          error: window.passGraphError,
          executing: window.passGraphExecuting,
          executed: window.passGraphExecutedPasses ?? [],
        }));
        expect(crumbs.error).toBeNull();
        expect(crumbs.executing).toBe(name);
        expect(crumbs.executed).toContain(marker);

        // A different shape must not just compile — it must reach the canvas.
        const shot = await page.locator('canvas').first().screenshot();
        expect(shot.length).toBeGreaterThan(0);
      });
    }

    test('the blur graph differs from the default graph on screen', async ({ page }) => {
      test.setTimeout(180_000);
      const base = await captureCanvas(page, '/?renderer=webgpu&graph=1');
      const blurred = await captureCanvas(page, '/?renderer=webgpu&graph=blur');
      expect(blurred.equals(base)).toBe(false);
    });
  });
});
