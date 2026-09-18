import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { setE2eViewport, stubMinimalCorpus } from './helpers/mockCorpus';
import { encodePresetParam } from './helpers/presetParam';
import { waitForWebGPU } from './helpers/renderer';
import { STRUCTURED_FIXTURE_PNG } from './helpers/structuredFixture';

/**
 * Pass-graph **executor** (docs/PASS_GRAPH.md Phase 2).
 *
 * `pass-graph.spec.ts` covers the compiler's breadcrumbs on the WebGL
 * diagnostic backend, where the graph compiles but nothing draws it. These
 * specs are the other half: on WebGPU, `?graph=1` hands the compiled graph to
 * `WebGpuGraphExecutor`, which encodes it instead of the hand-written topology.
 */

/**
 * A frozen scene, so two independently booted sessions render the same frame.
 *
 * `extensions: [0, 0, 0]` is the load-bearing part: the shipped default is
 * `[130, 230, 330]`, so the layers spin and the angle at capture time depends
 * on how many frames elapsed since boot.
 *
 * The angles are distinct on purpose. At a common angle every layer samples the
 * same source pixel, so the bands stay disjoint, nothing overlaps and the
 * coincidence stamp never fires. Distinct angles bring different source regions
 * onto the same screen pixel, which is what makes it fire.
 *
 * Given a still frame the tracers are then steady: where layers overlap the
 * fused pass writes the fresh stamp every frame (`newColor.a > decayed.a`), and
 * where they do not the accumulator starts at zero and stays there. So there is
 * no frame-count-dependent state left for two runs to disagree about.
 */
const frozenScene = (tracers?: Record<string, number>) => encodePresetParam({
  version: 1,
  settings: {
    layers: { angles: [0, 40, 80], extensions: [0, 0, 0] },
    ...(tracers ? { tracers } : {}),
  },
});

const FROZEN_SCENE = frozenScene();
/** The same scene with the tracers composited at zero opacity. */
const NO_TRACERS = frozenScene({ aboveIntensity: 0, belowIntensity: 0 });

const SETTLE_MS = 2500;

function url(graph: string, preset: string = FROZEN_SCENE): string {
  return `/?renderer=webgpu&graph=${graph}&preset=${preset}`;
}

/**
 * Serve a source image with real luminance structure.
 *
 * The shipped `public/e2e-fixture.png` is 8x8 and a single flat colour, which
 * makes every comparison here vacuous: one luminance means one active band
 * layer, so nothing overlaps, the tracers stay black, and blurring or warping a
 * constant is a no-op — a blur graph renders byte-identically to the default.
 */
async function stubStructuredFixture(page: Page): Promise<void> {
  await page.route('**/e2e-fixture.png', (route) => route.fulfill({
    contentType: 'image/png',
    body: STRUCTURED_FIXTURE_PNG,
  }));
}

async function openScene(page: Page, graph: string, preset: string = FROZEN_SCENE): Promise<void> {
  await stubMinimalCorpus(page);
  await stubStructuredFixture(page);
  await setE2eViewport(page);
  await page.goto(url(graph, preset));
  await waitForWebGPU(page);
  await page.waitForTimeout(SETTLE_MS);
}

async function captureCanvas(page: Page, graph: string, preset: string = FROZEN_SCENE): Promise<Buffer> {
  await openScene(page, graph, preset);
  return page.locator('canvas').first().screenshot({ animations: 'disabled' });
}

test.describe('pass-graph executor', () => {
  test('encodes the default graph in place of the hand-written topology', async ({ page }) => {
    test.setTimeout(90_000);
    await openScene(page, '1');

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
    await stubStructuredFixture(page);
    await page.goto(url('0'));
    await waitForWebGPU(page);

    expect(await page.evaluate(() => window.passGraphActive)).toBe(false);
    expect(await page.evaluate(() => window.passGraphExecuting ?? null)).toBeNull();
  });

  test('default graph via the executor matches the hand encoder', async ({ page }) => {
    test.setTimeout(180_000);
    const handEncoded = await captureCanvas(page, '0');
    const graphEncoded = await captureCanvas(page, '1');
    expect(graphEncoded.equals(handEncoded)).toBe(true);
  });

  /**
   * Guards every comparison below. If the tracers contribute nothing to the
   * composite — a flat source, a failed fixture route, a stamp that never fires
   * — then a graph that only changes the *tracer* inputs cannot change the
   * frame, and "blur differs from default" would fail for a reason that has
   * nothing to do with the executor. This is the test that tells the two apart.
   */
  test('the scene exercises the tracer path', async ({ page }) => {
    test.setTimeout(180_000);
    const withTracers = await captureCanvas(page, '1');
    const withoutTracers = await captureCanvas(page, '1', NO_TRACERS);
    expect(withTracers.equals(withoutTracers)).toBe(false);
  });

  test.describe('non-default shapes draw', () => {
    for (const [name, marker] of [
      ['blur', 'layer0-blur-y'],
      ['warp', 'layer0-warp'],
    ] as const) {
      test(`?graph=${name} compiles, schedules, allocates and draws`, async ({ page }) => {
        test.setTimeout(180_000);

        const shot = await captureCanvas(page, name);
        const crumbs = await page.evaluate(() => ({
          error: window.passGraphError,
          executing: window.passGraphExecuting,
          executed: window.passGraphExecutedPasses ?? [],
        }));
        expect(crumbs.error).toBeNull();
        expect(crumbs.executing).toBe(name);
        expect(crumbs.executed).toContain(marker);

        // A different shape must not merely compile — it has to change the
        // pixels. Comparing against the default graph's frame is what proves
        // the extra passes ran: a blank canvas, or a silently ignored node,
        // would render byte-identical to the default.
        const base = await captureCanvas(page, '1');
        expect(shot.equals(base)).toBe(false);
      });
    }
  });

  test('a parameter change does not recompile or rebuild the graph', async ({ page }) => {
    test.setTimeout(90_000);
    await openScene(page, '1');
    expect(await page.evaluate(() => window.passGraphCompileCount)).toBe(1);

    await page.mouse.move(400, 300);
    await page.mouse.move(700, 500);
    await page.waitForTimeout(1000);

    expect(await page.evaluate(() => window.passGraphCompileCount)).toBe(1);
    expect(await page.evaluate(() => window.passGraphExecuting)).toBe('default');
  });
});
