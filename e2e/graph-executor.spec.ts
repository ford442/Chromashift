import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { setE2eViewport, stubMinimalCorpus } from './helpers/mockCorpus';
import { encodePresetParam } from './helpers/presetParam';
import { primeOverlaySections } from './helpers/overlaySections';
import { domClick } from './helpers/domClick';
import { waitForWebGPU } from './helpers/renderer';
import {
  frameDifference,
  frameDistinctColours,
  installGpuCanvasReadback,
  readGpuCanvasFrame,
  readStableGpuCanvasFrame,
  type CanvasFrame,
} from './helpers/gpuCanvasReadback';
import { STRUCTURED_FIXTURE_PNG } from './helpers/structuredFixture';
import { UPDATING_FRAME_GOLDENS, readFrameGolden, writeFrameGolden } from './helpers/framePng';

/**
 * Pass-graph **executor** (docs/PASS_GRAPH.md).
 *
 * `pass-graph.spec.ts` covers the compiler's breadcrumbs on the WebGL
 * diagnostic backend, where the graph compiles but nothing draws it. These
 * specs are the other half: on WebGPU, `WebGpuGraphExecutor` draws every frame.
 *
 * Frames are read back from the swap-chain texture (see
 * `helpers/gpuCanvasReadback.ts`), not screenshotted, and every pixel
 * comparison *fails* on a blank frame rather than skipping: a black canvas is
 * the bug these specs exist to catch, not a property of the runner.
 *
 * Until the hand encoder was deleted, the default graph's frames were compared
 * with its frames on the same device. Those frames are now pinned in
 * `e2e/__golden__/` — captured from the hand encoder at the last commit that
 * had one, with the executor drawing them byte-identically on the same runner
 * — and `expectHandEncoderFrame` compares against them.
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
function frozenScene(
  tracers: Record<string, unknown> = {},
  viewport?: Record<string, unknown>,
): string {
  return encodePresetParam({
    // Canvas HDR arrived in schema v8; everything else here is v1.
    version: viewport ? 8 : 1,
    settings: {
      // `opacity` is here so a test can confirm the preset arrived: the Layers
      // panel renders it as "66%", a signal that does not depend on the canvas.
      layers: { angles: [0, 40, 80], extensions: [0, 0, 0], opacity: 0.66 },
      tracers: { aboveDuration: 0, belowDuration: 0, ...tracers },
      ...(viewport ? { viewport } : {}),
    },
  });
}

const FROZEN_SCENE = frozenScene();

/**
 * The frozen scene with the temporal term on, in `gate` mode: a stamp survives
 * only where the frame changed. The scene is a still image, so its motion
 * field is zero everywhere and gate removes every stamp — a frame that differs
 * from `off` wherever the bands overlap, and that both encoders must agree on
 * exactly, since no stamp is left for the compute-fed lane to round.
 */
const GATE_SCENE = frozenScene({ motionMode: 'gate' });

/** The frozen scene presented on an `hdr-extended` canvas (opt-in Canvas HDR). */
const HDR_SCENE = frozenScene({}, { canvasHdr: true });

const SETTLE_MS = 2500;

/**
 * `?no_gpu_compute` keeps every chore on its CPU lane. It is how the pinned
 * frames were captured: the hand encoder then ran the fused fragment pass the
 * graph emits, instead of stamping overlaps in a compute kernel (equivalent
 * math, quantised differently — see the compute-lane spec below).
 */
function url(
  graph: string,
  { compute = true, scene = FROZEN_SCENE }: { compute?: boolean; scene?: string } = {},
): string {
  return `/?renderer=webgpu&graph=${graph}&preset=${scene}${compute ? '' : '&no_gpu_compute'}`;
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

/**
 * Wait until the primary canvas's executor draws a variant matching `variant`
 * (`window.passGraphDrawnVariant`, e.g. `3:motion:sdr`). Until the device has
 * validated a variant the last one keeps drawing — or, at boot, nothing — so a
 * frame read before this is of the wrong variant.
 */
async function waitForDrawnVariant(page: Page, variant: RegExp): Promise<void> {
  // SwiftShader takes seconds to validate a variant's pipelines.
  await expect.poll(() => page.evaluate(() => window.passGraphDrawnVariant ?? ''), { timeout: 30_000 })
    .toMatch(variant);
}

async function captureFrame(page: Page, target: string, variant = /./): Promise<CanvasFrame> {
  await openScene(page, target);
  await waitForDrawnVariant(page, variant);
  return readStableGpuCanvasFrame(page);
}

/**
 * `frame` is the frame the hand encoder drew for the same scene, pinned as
 * `e2e/__golden__/<name>.png` (see the file comment; `UPDATE_FRAME_GOLDENS=1`
 * rewrites it, which makes it the executor's own output — only for a change
 * meant to move pixels).
 *
 * Exact on the runner the frames were captured on. The bound is the one the
 * compute-fed stamp was held to — ±1 on a few pixels — so a SwiftShader build
 * that rounds a float an ulp differently does not fail it; a wrong pass,
 * binding or uniform moves far more than that.
 */
function expectHandEncoderFrame(frame: CanvasFrame, name: string): void {
  expectContent(frame, `the ${name} frame`);
  if (UPDATING_FRAME_GOLDENS) {
    writeFrameGolden(name, frame);
    return;
  }
  const golden = readFrameGolden(name, frame.format);
  const { differingPixels, maxChannelDelta } = frameDifference(golden, frame);
  expect(maxChannelDelta, `${name}: a channel moved by more than one step from the hand encoder's frame`)
    .toBeLessThanOrEqual(1);
  expect(differingPixels, `${name}: too many pixels differ from the hand encoder's frame`)
    .toBeLessThanOrEqual(frame.width * frame.height * 0.0005);
}

/** A frame with more than one colour — the renderer drew *something*. */
function expectContent(frame: CanvasFrame, what: string): void {
  expect(
    frameDistinctColours(frame),
    `${what} is a single flat colour: nothing was drawn`,
  ).toBeGreaterThan(1);
}

test.describe('pass-graph executor', () => {
  test('encodes the default graph as the five shipped passes', async ({ page }) => {
    test.setTimeout(90_000);
    await openScene(page, url('1'));
    await waitForDrawnVariant(page, /^3:still:sdr$/);

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

  test('reads the retired ?graph=0 as the default graph', async ({ page }) => {
    // `?graph=0` selected the hand encoder for the release it outlived the
    // flip. There is nothing to select now: it draws the default graph.
    await openScene(page, url('0'));
    await waitForDrawnVariant(page, /./);
    expect(await page.evaluate(() => ({
      active: window.passGraphActive,
      name: window.passGraphName,
      executing: window.passGraphExecuting,
    }))).toEqual({ active: true, name: 'default', executing: 'default' });
  });

  test('draws through the executor with no ?graph at all', async ({ page }) => {
    // The gate is on by default: a session that names no graph gets the
    // executor drawing the default one, the frame `?graph=1` draws.
    test.setTimeout(180_000);
    const byDefault = await captureFrame(page, `/?renderer=webgpu&preset=${FROZEN_SCENE}`);
    expectContent(byDefault, 'the default session’s frame');
    expect(await page.evaluate(() => ({
      active: window.passGraphActive,
      name: window.passGraphName,
      executing: window.passGraphExecuting,
      slots: window.passGraphSlotsExecuting,
      error: window.passGraphError,
    }))).toEqual({ active: true, name: 'default', executing: 'default', slots: { main: 'default' }, error: null });

    const gated = await captureFrame(page, url('1'));
    expect(frameDifference(byDefault, gated)).toEqual({ differingPixels: 0, maxChannelDelta: 0 });
  });

  test('the default graph draws the hand encoder’s frame', async ({ page }) => {
    test.setTimeout(120_000);
    const frame = await captureFrame(page, url('1', { compute: false }));
    expect(await page.evaluate(() => window.passGraphExecuting)).toBe('default');
    expectHandEncoderFrame(frame, 'default-composite');
  });

  test('with the GPU compute lanes on, the stamp is still the fused fragment one', async ({ page }) => {
    // The hand encoder stamped overlaps in a compute kernel when it could and
    // decayed against that — ±1 on 3 of 731k pixels from the fused pass,
    // which never quantises the stamp. The graph has no such lane: whatever
    // compute the device offers, its frame is the fused pass's.
    test.setTimeout(120_000);
    expectHandEncoderFrame(await captureFrame(page, url('1')), 'default-composite');
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
    for (const { name, marker, scheduled, rings, differs, settles = true } of [
      { name: 'blur', marker: 'layer0-blur-y', scheduled: [], rings: 0, differs: true },
      { name: 'warp', marker: 'layer0-warp', scheduled: [], rings: 0, differs: true },
      { name: 'feedback', marker: 'layer0-warp', scheduled: [], rings: 0, differs: true },
      // A third tracer timescale, blended under the shipped pair. Its echo is
      // timed by its own node (6 s), not the frozen scene's zero durations, so
      // what the image's asynchronous arrival stamped keeps fading for tens of
      // seconds: the frame never holds byte-still long enough for the stable
      // reader, and one settled frame is read instead.
      {
        name: 'trails3',
        marker: 'tracer-echo',
        scheduled: ['tracer-echo'],
        rings: 0,
        differs: true,
        settles: false,
      },
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

        const shaped = settles
          ? await captureFrame(page, url(name))
          : await openScene(page, url(name)).then(() => readGpuCanvasFrame(page));
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
    // way to the device and the renderer must name the refusal and stand the
    // default graph in for it — not adopt the graph and draw black.
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
      name: window.passGraphName,
      executing: window.passGraphExecuting ?? null,
    }));
    expect(crumbs.error).toMatch(/^invalid-pipeline: /);
    expect(crumbs.name).toBe('warp');
    expect(crumbs.executing).toBe('default');
    expectHandEncoderFrame(frame, 'default-composite');
  });

  test.describe('the temporal term', () => {
    const FIVE_PASSES = ['layer0', 'layer1', 'layer2', 'tracer-below', 'tracer-above', 'composite'];

    test('a motion mode draws through the executor, fused into the accumulators', async ({ page }) => {
      test.setTimeout(120_000);
      const gpuErrors = collectGpuErrors(page);
      const frame = await captureFrame(page, url('1', { scene: GATE_SCENE }), /:motion:/);
      const crumbs = await page.evaluate(() => ({
        error: window.passGraphError,
        executing: window.passGraphExecuting,
        executed: window.passGraphExecutedPasses ?? [],
        scheduled: window.passGraphPasses ?? [],
        backend: window.motionFieldBackend ?? null,
      }));
      // The field is real (the WebGPU lane produced it), so the frame got the
      // variant with the term rather than the pre-motion graph.
      expect(crumbs.backend).toBe('webgpu');
      expect(crumbs.error).toBeNull();
      expect(crumbs.executing).toBe('default');
      expect(crumbs.scheduled).toEqual(expect.arrayContaining(['motion-field', 'coincidence-motion']));
      expect(crumbs.executed).toEqual(FIVE_PASSES);
      expect(gpuErrors).toEqual([]);
      expectContent(frame, 'the gate frame');
    });

    test('gate draws the hand encoder’s frame, and is not the pre-motion frame', async ({ page }) => {
      test.setTimeout(240_000);
      const graphEncoded = await captureFrame(page, url('1', { scene: GATE_SCENE }), /:motion:/);
      expect(await page.evaluate(() => window.passGraphExecuting)).toBe('default');
      expectHandEncoderFrame(graphEncoded, 'gate-composite');

      const off = await captureFrame(page, url('1'));
      expect(
        frameDifference(graphEncoded, off).differingPixels,
        'gate on a still image drew the stamps it should have removed',
      ).toBeGreaterThan(0);
    });

    test('switching the term on and off compiles each variant once', async ({ page }) => {
      test.setTimeout(120_000);
      await primeOverlaySections(page, { tracer: true });
      await openScene(page, url('1'));
      expect(await page.evaluate(() => window.passGraphCompileCount)).toBe(1);

      const select = page.getByTestId('tracer-motion-mode');
      const term = () => page.evaluate(() => (window.passGraphPasses ?? []).includes('coincidence-motion'));
      for (const mode of ['boost', 'off', 'gate', 'off', 'direction'] as const) {
        await select.selectOption(mode);
        // On SwiftShader the first switch on waits seconds for the motion-field
        // lane's first field (the term needs one), and frames can stall while
        // the motion variant's pipelines compile.
        await expect.poll(term, { timeout: 30_000 }).toBe(mode !== 'off');
        // The first switch on validates the motion variant's pipelines, which
        // SwiftShader takes seconds to compile — the still variant keeps
        // drawing meanwhile; every later switch is a cache hit.
        await waitForDrawnVariant(page, mode === 'off' ? /:still:/ : /:motion:/);
        expect(await page.evaluate(() => window.passGraphExecuting)).toBe('default');
      }
      // Moving between boost, gate and direction is a uniform; only on/off is
      // structural, and each of the two variants compiled exactly once.
      expect(await page.evaluate(() => window.passGraphCompileCount)).toBe(2);
    });
  });

  test.describe('any layer count', () => {
    /**
     * A frozen `count`-layer scene with the tracers hidden, so the frame is the
     * band layers alone. Per-layer opacities pick which of them show.
     */
    function layerScene(count: number, opacities: number[]): string {
      return encodePresetParam({
        version: 8,
        settings: {
          layers: {
            count,
            angles: Array.from({ length: count }, (_, i) => i * 40),
            extensions: Array.from({ length: count }, () => 0),
            opacities,
          },
          tracers: { aboveDuration: 0, belowDuration: 0, aboveIntensity: 0, belowIntensity: 0 },
        },
      });
    }
    const opaque = (count: number) => Array.from({ length: count }, () => 1);
    const onlyLayer = (count: number, index: number) =>
      Array.from({ length: count }, (_, i) => (i === index ? 1 : 0));

    for (const count of [1, 7, 10]) {
      test(`layers.count = ${count} draws exactly ${count} band pass${count === 1 ? '' : 'es'}`, async ({ page }) => {
        test.setTimeout(120_000);
        const gpuErrors = collectGpuErrors(page);
        await openScene(page, url('1', { scene: layerScene(count, opaque(count)) }));
        await waitForDrawnVariant(page, new RegExp(`^${count}:`));
        const crumbs = await page.evaluate(() => ({
          executed: window.passGraphExecutedPasses ?? [],
          executing: window.passGraphExecuting,
          error: window.passGraphError,
        }));
        expect(crumbs.error).toBeNull();
        expect(crumbs.executing).toBe('default');
        expect(crumbs.executed).toEqual([
          ...Array.from({ length: count }, (_, i) => `layer${i}`),
          'tracer-below', 'tracer-above', 'composite',
        ]);
        expect(gpuErrors).toEqual([]);
      });
    }

    test('the seventh band draws, which the hand encoder could not', async ({ page }) => {
      // The hand encoder compiled three band passes and drew no more, so this
      // scene was empty there.
      test.setTimeout(240_000);
      // Layer 7 alone (index 6): the executor draws it into the composite...
      const seventh = await captureFrame(page, url('1', { scene: layerScene(7, onlyLayer(7, 6)) }), /^7:/);
      expect(await page.evaluate(() => window.passGraphExecuting)).toBe('default');
      expectContent(seventh, 'layer 7 on its own');
      // ...and with it hidden too, nothing is left: the content above was layer 7.
      const none = await captureFrame(page, url('1', { scene: layerScene(7, Array.from({ length: 7 }, () => 0)) }), /^7:/);
      expect(frameDistinctColours(none)).toBe(1);
    });
  });

  test.describe('main views and stationary previews', () => {
    /** The 2D thumbnail canvas labelled `label` in the preview strip, as distinct colours. */
    const thumbnailColours = (page: Page, label: string) => page.evaluate((text) => {
      const caption = [...document.querySelectorAll('div')]
        .find((el) => el.textContent === text && el.previousElementSibling?.tagName === 'CANVAS');
      const canvas = caption?.previousElementSibling as HTMLCanvasElement | undefined;
      const context = canvas?.getContext('2d');
      if (!canvas || !context) return 0;
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      const seen = new Set<number>();
      for (let i = 0; i < data.length; i += 4) seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
      return seen.size;
    }, label);

    test('Show Full Tracer draws the tracer view the hand encoder drew', async ({ page }) => {
      // Fixed in Phase 3: since the July export refactor, the live frame always
      // drew the processed composite, whatever view the session selected.
      // A half-scale tracer letterboxes, so its view cannot pass for the composite.
      test.setTimeout(180_000);
      const scene = frozenScene({ scale: 0.5 });
      await primeOverlaySections(page, { tracer: true });
      const composite = await captureFrame(page, url('1', { compute: false, scene }));
      expectContent(composite, 'the composite');
      await page.getByRole('button', { name: /Show Full Tracer/ }).click();
      await expect(page.getByRole('button', { name: /Exit Tracer View/ })).toBeVisible();
      await page.waitForTimeout(500);
      const tracer = await readStableGpuCanvasFrame(page);
      expect(frameDifference(composite, tracer).differingPixels, 'drew the composite in the tracer view')
        .toBeGreaterThan(0);
      expect(await page.evaluate(() => window.passGraphExecuting)).toBe('default');
      expectHandEncoderFrame(tracer, 'tracer-view');
    });

    test('Quarter Zoom zooms the WebGPU canvas as the hand encoder zoomed it', async ({ page }) => {
      // Also broken since the July refactor: the WebGPU compositor was always
      // handed 0 for both viewport transforms, so only WebGL honoured them.
      test.setTimeout(180_000);
      await primeOverlaySections(page, { viewport: true });
      const composite = await captureFrame(page, url('1', { compute: false }));
      await page.getByRole('button', { name: /Zoom Bottom-Left Quarter/i }).click();
      await expect(page.getByRole('button', { name: /Exit Quarter Zoom/i })).toBeVisible();
      await page.waitForTimeout(500);
      const zoomed = await readStableGpuCanvasFrame(page);
      expect(frameDifference(composite, zoomed).differingPixels, 'ignored Quarter Zoom').toBeGreaterThan(0);
      expectHandEncoderFrame(zoomed, 'quarter-zoom');
    });

    test('a seven-layer session previews its seventh band', async ({ page }) => {
      test.setTimeout(180_000);
      const scene = encodePresetParam({
        version: 8,
        settings: {
          layers: {
            count: 7,
            angles: [0, 40, 80, 120, 160, 200, 240],
            extensions: [0, 0, 0, 0, 0, 0, 0],
            opacities: [0, 0, 0, 0, 0, 0, 1],
          },
        },
      });
      await openScene(page, url('1', { scene }));
      // The thumbnails are frames of the default graph at the session's count,
      // so the seventh band alone still paints the Separated preview.
      await expect.poll(() => thumbnailColours(page, 'Separated'), { timeout: 60_000 }).toBeGreaterThan(1);
    });
  });

  test.describe('compare slots', () => {
    test('every compare slot draws through its own executor', async ({ page }) => {
      test.setTimeout(180_000);
      const gpuErrors = collectGpuErrors(page);
      await primeOverlaySections(page, { viewport: true });
      await openScene(page, url('1'));

      await domClick(page.getByRole('button', { name: '▢▢ Dual', exact: true }));
      await expect.poll(() => page.evaluate(() => window.compareLayout)).toBe('dual');
      await expect.poll(
        () => page.evaluate(() => window.passGraphSlotsExecuting ?? {}),
        { timeout: 60_000 },
      ).toEqual({ main: 'default', 'compare-b': 'default' });

      await domClick(page.getByRole('button', { name: /Quad/i }));
      await expect.poll(() => page.evaluate(() => window.compareLayout)).toBe('quad');
      // The four quad cells (Original, Layers, Tracer, Composite) are slots too;
      // each one's executor reaches the same compiled programs.
      await expect.poll(async () => {
        const slots = await page.evaluate(() => window.passGraphSlotsExecuting ?? {});
        return Object.values(slots).filter((name) => name === 'default').length;
      }, { timeout: 60_000 }).toBeGreaterThanOrEqual(4);
      // Only the primary canvas describes the session's graph.
      expect(await page.evaluate(() => window.passGraphExecuting)).toBe('default');
      expect(gpuErrors).toEqual([]);
    });
  });

  test.describe('the hdr-extended present', () => {
    test('an HDR canvas draws through the executor, as the hand encoder drew it', async ({ page }) => {
      test.setTimeout(180_000);
      const gpuErrors = collectGpuErrors(page);
      const graphEncoded = await captureFrame(page, url('1', { compute: false, scene: HDR_SCENE }), /:hdr-extended$/);
      // The UA honoured the request: the swap chain is the float format. A
      // runner without extended tone mapping would present SDR, and this
      // comparison would be of an SDR frame — so it says so instead.
      expect(graphEncoded.format, 'the canvas did not present hdr-extended').toBe('rgba16float');
      const crumbs = await page.evaluate(() => ({
        executing: window.passGraphExecuting,
        error: window.passGraphError,
      }));
      expect(crumbs.error).toBeNull();
      expect(crumbs.executing).toBe('default');
      expectHandEncoderFrame(graphEncoded, 'hdr-composite');
      expect(gpuErrors).toEqual([]);
    });
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
