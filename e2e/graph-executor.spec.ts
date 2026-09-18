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
const FROZEN_SCENE = encodePresetParam({
  version: 1,
  settings: {
    // `opacity` is here so a test can confirm the preset arrived: the Layers
    // panel renders it as "66%", a signal that survives even where the canvas
    // does not render.
    layers: { angles: [0, 40, 80], extensions: [0, 0, 0], opacity: 0.66 },
  },
});

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
  await hideEverythingButTheCanvas(page);
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

/**
 * Hide every element that is not the render canvas.
 *
 * Playwright's element screenshot captures the element's *region of the page*,
 * so anything painted over the canvas — overlay panels, labels — lands in the
 * buffer. That is not a detail: measured on this app, a capture of the main
 * canvas read 1867 distinct colours with the UI up and exactly 1 (pure black)
 * with it hidden. Every pixel in that first buffer was chrome. Comparisons
 * built on it compared the UI to itself and passed no matter what the renderer
 * did, which is exactly how a parity assertion here came to prove nothing.
 */
async function hideEverythingButTheCanvas(page: Page): Promise<void> {
  await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    if (!canvas) return;
    document.querySelectorAll<HTMLElement>('body *').forEach((el) => {
      if (el !== canvas && !el.contains(canvas)) el.style.visibility = 'hidden';
    });
    canvas.style.visibility = 'visible';
  });
  await page.waitForTimeout(250);
}

/**
 * True when the frame carries something a comparison can be about.
 *
 * A single-colour canvas means this environment did not render the scene —
 * software WebGPU here cannot create the compute pipelines the chore backend
 * needs, and the canvas comes back pure black on the hand encoder and the graph
 * executor alike. Comparing two blank frames "passes" while checking nothing,
 * so the tests below skip on it and say so rather than bank a false green.
 */
function renderedSomething(frame: Buffer): boolean {
  return distinctColourCount(frame) > 1;
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

  /**
   * The pixel comparisons below all guard on `renderedSomething()` first.
   *
   * Under software WebGPU the canvas comes back pure black — on the hand
   * encoder and the graph executor alike — because the compute pipelines the
   * chore backend needs cannot be created. A "these frames match" assertion is
   * satisfied by two blank frames and a "these frames differ" assertion can
   * never hold, so on such a runner these skip with the reason stated instead
   * of reporting a green that means nothing.
   */
  test('default graph via the executor matches the hand encoder', async ({ page }) => {
    test.setTimeout(180_000);
    const handEncoded = await captureCanvas(page, '0');
    test.skip(
      !renderedSomething(handEncoded),
      'this runner renders a blank canvas, so pixel parity cannot be observed here',
    );
    const graphEncoded = await captureCanvas(page, '1');
    expect(graphEncoded.equals(handEncoded)).toBe(true);
  });

  test('the frozen-scene preset is applied at all', async ({ page }) => {
    test.setTimeout(90_000);
    await openScene(page, '1');
    await expect(page.getByText('NUNIF Controls')).toBeVisible();

    // Reads an applied value out of the UI rather than inferring one from
    // pixels, so it holds even where the canvas does not render. If this fails,
    // the frozen scene is not frozen and no comparison here means what it says.
    const layersSection = page.locator('.section-divider').filter({ hasText: '🌍 Layers & Global' });
    await expect(layersSection.getByText('66%', { exact: true })).toBeVisible();
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
        // These hold on any runner: the graph compiled, scheduled, allocated,
        // and the executor encoded its extra passes.
        expect(crumbs.error).toBeNull();
        expect(crumbs.executing).toBe(name);
        expect(crumbs.executed).toContain(marker);

        test.skip(
          !renderedSomething(shot),
          'this runner renders a blank canvas, so "the shape changed the pixels" '
          + 'cannot be observed here; the breadcrumbs above still prove it encoded',
        );
        const base = await captureCanvas(page, '1');
        test.skip(
          !renderedSomething(base),
          'this runner renders a blank default graph, so "the shape changed the '
          + 'pixels" cannot be observed here either',
        );
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
