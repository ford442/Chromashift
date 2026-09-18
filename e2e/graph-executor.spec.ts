import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { setE2eViewport, stubMinimalCorpus } from './helpers/mockCorpus';
import { encodePresetParam } from './helpers/presetParam';
import { waitForWebGPU } from './helpers/renderer';
import { distinctColourCount } from './helpers/pngPixels';
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
const frozenScene = (
  overrides: { tracers?: Record<string, number>; output?: Record<string, number> } = {},
) => encodePresetParam({
  version: 1,
  settings: {
    // `opacity` is here purely so a test can confirm the preset arrived: the
    // Layers panel renders it as "66%", which is a non-pixel signal that the
    // document was parsed and applied. Without that, a silently dropped preset
    // turns the parity comparison into two captures of a *spinning* scene and
    // every assertion in this file starts measuring something else.
    layers: { angles: [0, 40, 80], extensions: [0, 0, 0], opacity: 0.66 },
    ...(overrides.tracers ? { tracers: overrides.tracers } : {}),
    ...(overrides.output ? { output: overrides.output } : {}),
  },
});

const FROZEN_SCENE = frozenScene();
/** The same scene with the tracers composited at zero opacity. */
const NO_TRACERS = frozenScene({ tracers: { aboveIntensity: 0, belowIntensity: 0 } });
/**
 * `outputMode: 3` makes the compositor output its *own* freshly computed
 * overlap stamp, straight from the layer textures. It never reads an
 * accumulator, so it reports on the scene alone.
 */
const STAMP_ONLY = frozenScene({ output: { outputMode: 3 } });
/** `outputMode: 2` suppresses the live layers and shows only the accumulators. */
const TRACERS_ONLY = frozenScene({ output: { outputMode: 2 } });

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

/**
 * Screenshot the canvas once the frame has stopped changing.
 *
 * A fixed settle delay is not enough: the corpus fetch, the texture upload and
 * the classification-mask pass all land asynchronously, and an image load calls
 * `clearPersistence()` — so a capture can catch the tracers just after they were
 * cleared and before they have re-accumulated. That is a race, and it showed up
 * as a test that failed and then passed on retry.
 *
 * Polling until two consecutive captures are byte-identical waits for the real
 * condition instead of guessing a duration. A scene that never settles (layer
 * spin still running, say) exhausts the attempts and fails loudly, which is the
 * outcome we want rather than a coin-flip comparison.
 */
async function captureStable(page: Page, attempts = 12, gapMs = 400): Promise<Buffer> {
  const canvas = page.locator('canvas').first();
  let previous = await canvas.screenshot({ animations: 'disabled' });
  for (let i = 0; i < attempts; i += 1) {
    await page.waitForTimeout(gapMs);
    const next = await canvas.screenshot({ animations: 'disabled' });
    if (next.equals(previous)) return next;
    previous = next;
  }
  throw new Error(
    `Canvas never settled: ${attempts} captures ${gapMs}ms apart all differed. `
    + 'The scene is still animating, so no frame comparison in this file is meaningful.',
  );
}

async function captureCanvas(page: Page, graph: string, preset: string = FROZEN_SCENE): Promise<Buffer> {
  await openScene(page, graph, preset);
  return captureStable(page);
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
   * The two guards below stand in front of every comparison in this file.
   *
   * Every assertion here is of the form "these two frames differ" or "these two
   * frames match", and both are satisfied trivially by a frame with no content.
   * That is not hypothetical: the shipped 8x8 fixture is a single colour whose
   * shader luminance (111.9, after the `rgba8unorm-srgb` decode) falls below
   * the band table's lowest threshold of 125, so *no* band layer was ever
   * active and the composite was black everywhere. Every comparison passed or
   * failed for reasons that had nothing to do with the executor.
   *
   * So: assert the frame has content, then assert the tracer path contributes
   * to it. A failure in either one localises the fault to the scene rather than
   * the code under test.
   */
  test('the default graph draws a frame with content', async ({ page }) => {
    test.setTimeout(90_000);
    const frame = await captureCanvas(page, '1');
    // A black or flat canvas is 1. The structured fixture through the band
    // layers and compositor is hundreds.
    expect(distinctColourCount(frame)).toBeGreaterThan(64);
  });

  /**
   * Splits the ways the tracer comparison below can fail, which it cannot do on
   * its own: the scene may not overlap any layers, the accumulators may be
   * empty, or the preset override may simply never have reached the renderer.
   *
   * Every assertion here compares two *different configurations* rather than
   * testing one frame against an absolute threshold. That matters: a threshold
   * like "more than one colour" is satisfied by a frame that ignored the
   * override entirely and rendered the default composite, which is exactly how
   * the earlier `shot.length > 0` check managed to assert nothing.
   */
  test('the frozen-scene preset is applied at all', async ({ page }) => {
    test.setTimeout(90_000);
    await openScene(page, '1');
    await expect(page.getByText('NUNIF Controls')).toBeVisible();

    // Same check the shipped preset-URL spec makes, for the same reason: it
    // reads an applied value out of the UI rather than inferring one from
    // pixels. If this fails, nothing else in this file means what it says.
    const layersSection = page.locator('.section-divider').filter({ hasText: '🌍 Layers & Global' });
    await expect(layersSection.getByText('66%', { exact: true })).toBeVisible();
  });

  test('the output-mode overrides reach the renderer and the stamp has content', async ({ page }) => {
    test.setTimeout(240_000);

    const base = await captureCanvas(page, '1');
    const stampOnly = await captureCanvas(page, '1', STAMP_ONLY);
    const tracersOnly = await captureCanvas(page, '1', TRACERS_ONLY);

    // Asserted as one object so a failure's diff reports every signal at once.
    // Sequential assertions mask each other: an earlier throw meant the
    // outputMode=2 result was never measured, which cost a whole CI round.
    const counts = {
      base: distinctColourCount(base),
      stampOnly: distinctColourCount(stampOnly),
      tracersOnly: distinctColourCount(tracersOnly),
    };
    console.log('distinct colour counts:', JSON.stringify(counts));

    expect({
      // The overrides arrive at all: neither a stamp-only nor a tracer-only
      // frame can equal the full composite unless the preset was dropped.
      stampOverrideApplied: !stampOnly.equals(base),
      tracerOverrideApplied: !tracersOnly.equals(base),
      // The scene overlaps: outputMode=3 is the compositor's own stamp, taken
      // from the layer textures with no accumulator read.
      stampHasContent: counts.stampOnly > 1,
      // The accumulators hold it: outputMode=2 shows only them.
      tracersHaveContent: counts.tracersOnly > 1,
    }).toEqual({
      stampOverrideApplied: true,
      tracerOverrideApplied: true,
      stampHasContent: true,
      tracersHaveContent: true,
    });
  });

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
