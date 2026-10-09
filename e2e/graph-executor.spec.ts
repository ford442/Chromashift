import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { setE2eViewport, stubMinimalCorpus } from './helpers/mockCorpus';
import { encodePresetParam } from './helpers/presetParam';
import { waitForWebGPU } from './helpers/renderer';
import {
  frameDifference,
  frameDistinctColours,
  installGpuCanvasReadback,
  readStableGpuCanvasFrame,
  type CanvasFrame,
} from './helpers/gpuCanvasReadback';
import { STRUCTURED_FIXTURE_PNG } from './helpers/structuredFixture';

/**
 * Pass-graph **executor** (docs/PASS_GRAPH.md Phase 2).
 *
 * `pass-graph.spec.ts` covers the compiler's breadcrumbs on the WebGL
 * diagnostic backend, where the graph compiles but nothing draws it. These
 * specs are the other half: on WebGPU, `?graph=1` hands the compiled graph to
 * `WebGpuGraphExecutor`, which encodes it instead of the hand-written topology.
 *
 * Frames are read back from the swap-chain texture (see
 * `helpers/gpuCanvasReadback.ts`), not screenshotted, and every pixel
 * comparison *fails* on a blank frame rather than skipping: a black canvas is
 * the bug these specs exist to catch, not a property of the runner.
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
 * Zero tracer durations make the frame a function of the settled scene alone.
 * The image, its classification mask and its average luminance land
 * asynchronously, so for a few frames the stamp describes a scene that is
 * still arriving; with any decay at all, those frames leave residue that
 * quantises to a fixed point and never fades, and *how much* depends on frame
 * pacing. Measured: ±1 on 5–43 of 731k pixels between two runs of the same
 * encoder. With the multiplier at 0 there is no history to disagree about.
 */
const FROZEN_SCENE = encodePresetParam({
  version: 1,
  settings: {
    // `opacity` is here so a test can confirm the preset arrived: the Layers
    // panel renders it as "66%", a signal that does not depend on the canvas.
    layers: { angles: [0, 40, 80], extensions: [0, 0, 0], opacity: 0.66 },
    tracers: { aboveDuration: 0, belowDuration: 0 },
  },
});

const SETTLE_MS = 2500;

/**
 * `?no_gpu_compute` pins the hand encoder's persistence to the fused fragment
 * pass — the one the graph emits. With compute available, `PersistencePass`
 * instead stamps overlaps in a compute kernel and decays against that, which
 * is equivalent math quantised differently. See the bounded comparison below.
 */
function url(graph: string, { compute = true }: { compute?: boolean } = {}): string {
  return `/?renderer=webgpu&graph=${graph}&preset=${FROZEN_SCENE}${compute ? '' : '&no_gpu_compute'}`;
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

/** Uncaptured WebGPU errors the session logged. Any one of them can drop a frame. */
function collectGpuErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().includes('Uncaptured error')) {
      errors.push(message.text());
    }
  });
  return errors;
}

async function openScene(page: Page, target: string): Promise<void> {
  await installGpuCanvasReadback(page);
  await stubMinimalCorpus(page);
  await stubStructuredFixture(page);
  await setE2eViewport(page);
  await page.goto(target);
  await waitForWebGPU(page);
  await page.waitForTimeout(SETTLE_MS);
}

async function captureFrame(page: Page, target: string): Promise<CanvasFrame> {
  await openScene(page, target);
  return readStableGpuCanvasFrame(page);
}

/** A frame with more than one colour — the renderer drew *something*. */
function expectContent(frame: CanvasFrame, what: string): void {
  expect(
    frameDistinctColours(frame),
    `${what} is a single flat colour: nothing was drawn`,
  ).toBeGreaterThan(1);
}

test.describe('pass-graph executor', () => {
  test('encodes the default graph in place of the hand-written topology', async ({ page }) => {
    test.setTimeout(90_000);
    await openScene(page, url('1'));

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

  test('default graph via the executor is byte-identical to the hand encoder', async ({ page }) => {
    test.setTimeout(180_000);
    const handEncoded = await captureFrame(page, url('0', { compute: false }));
    expectContent(handEncoded, 'the hand-encoded frame');
    const graphEncoded = await captureFrame(page, url('1', { compute: false }));
    expect(await page.evaluate(() => window.passGraphExecuting)).toBe('default');
    expect(frameDifference(handEncoded, graphEncoded)).toEqual({ differingPixels: 0, maxChannelDelta: 0 });
  });

  test('stays within one step of the hand encoder’s compute-fed persistence', async ({ page }) => {
    // The one known divergence, bounded rather than hidden. The compute lane
    // writes the overlap stamp to a texture and decays against it; the fused
    // pass never quantises the stamp. Measured here: ±1 on 3 of 731k pixels.
    // A wrong pass, binding or uniform moves far more than that.
    test.setTimeout(180_000);
    const handEncoded = await captureFrame(page, url('0'));
    expectContent(handEncoded, 'the hand-encoded frame');
    const graphEncoded = await captureFrame(page, url('1'));
    const { differingPixels, maxChannelDelta } = frameDifference(handEncoded, graphEncoded);
    expect(maxChannelDelta).toBeLessThanOrEqual(1);
    expect(differingPixels).toBeLessThanOrEqual(handEncoded.width * handEncoded.height * 0.0005);
  });

  test('the frozen-scene preset is applied at all', async ({ page }) => {
    test.setTimeout(90_000);
    await openScene(page, url('1'));
    await expect(page.getByText('NUNIF Controls')).toBeVisible();

    // Reads an applied value out of the UI rather than inferring one from
    // pixels. If this fails, the frozen scene is not frozen and no comparison
    // here means what it says.
    const layersSection = page.locator('.section-divider').filter({ hasText: '🌍 Layers & Global' });
    await expect(layersSection.getByText('66%', { exact: true })).toBeVisible();
  });

  test.describe('non-default shapes draw', () => {
    for (const { name, marker, scheduled, rings, differs } of [
      { name: 'blur', marker: 'layer0-blur-y', scheduled: [], rings: 0, differs: true },
      { name: 'warp', marker: 'layer0-warp', scheduled: [], rings: 0, differs: true },
      { name: 'feedback', marker: 'layer0-warp', scheduled: [], rings: 0, differs: true },
      // The frozen scene is a still image with no motion: its flow field is
      // zero, so `displace` is the identity, and the history of a still frame
      // is that frame. What the smear must prove here is that it compiles,
      // allocates its ring and draws without a GPU error — not that a still
      // image looks smeared.
      {
        name: 'smear',
        marker: 'smear-displace',
        scheduled: ['smear-history', 'smear-displace', 'motion'],
        rings: 4,
        differs: false,
      },
    ] as const) {
      test(`?graph=${name} compiles, schedules, allocates and draws`, async ({ page }) => {
        test.setTimeout(180_000);
        const gpuErrors = collectGpuErrors(page);

        const shaped = await captureFrame(page, url(name));
        const crumbs = await page.evaluate(() => ({
          error: window.passGraphError,
          executing: window.passGraphExecuting,
          executed: window.passGraphExecutedPasses ?? [],
          scheduled: window.passGraphPasses ?? [],
          rings: window.passGraphRingFrames ?? {},
        }));
        expect(crumbs.error).toBeNull();
        expect(crumbs.executing).toBe(name);
        expect(crumbs.executed).toContain(marker);
        expect(crumbs.scheduled).toEqual(expect.arrayContaining([...scheduled]));
        expect(crumbs.rings.layer ?? 0).toBe(rings);
        // The breadcrumbs above were all true of a `?graph=warp` whose shader
        // the device rejected — every frame dropped, the canvas black. These
        // two are what "draws" means.
        expect(gpuErrors).toEqual([]);
        expectContent(shaped, `the ?graph=${name} frame`);

        if (differs) {
          const base = await captureFrame(page, url('1'));
          expect(
            frameDifference(shaped, base).differingPixels,
            `?graph=${name} drew the default graph's pixels`,
          ).toBeGreaterThan(0);
        }
      });
    }
  });

  test('refuses a graph whose pipelines the device rejects, and keeps drawing', async ({ page }) => {
    // Invalid WGSL is not an exception: it is an invalid pipeline, and the
    // first frame to bind it is dropped whole. Corrupt the warp shader on its
    // way to the device and the executor must name the refusal and leave the
    // hand encoder on screen — not adopt the graph and draw black.
    test.setTimeout(120_000);
    await page.addInitScript(() => {
      const create = GPUDevice.prototype.createShaderModule;
      GPUDevice.prototype.createShaderModule = function (descriptor: GPUShaderModuleDescriptor) {
        const code = descriptor.code.includes('WarpUniforms')
          ? `${descriptor.code}\nthis is not WGSL;`
          : descriptor.code;
        return create.call(this, { ...descriptor, code });
      };
    });
    const frame = await captureFrame(page, url('warp'));

    const crumbs = await page.evaluate(() => ({
      error: window.passGraphError,
      executing: window.passGraphExecuting ?? null,
    }));
    expect(crumbs.error).toMatch(/^invalid-pipeline: /);
    expect(crumbs.executing).toBeNull();
    expectContent(frame, 'the frame after the refusal');
  });

  test('a parameter change does not recompile or rebuild the graph', async ({ page }) => {
    test.setTimeout(90_000);
    await openScene(page, url('1'));
    expect(await page.evaluate(() => window.passGraphCompileCount)).toBe(1);

    await page.mouse.move(400, 300);
    await page.mouse.move(700, 500);
    await page.waitForTimeout(1000);

    expect(await page.evaluate(() => window.passGraphCompileCount)).toBe(1);
    expect(await page.evaluate(() => window.passGraphExecuting)).toBe('default');
  });
});
