import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { stubMinimalCorpus } from './helpers/mockCorpus';
import { encodePresetParam } from './helpers/presetParam';
import { waitForWebGL } from './helpers/renderer';
import { STRUCTURED_FIXTURE_PNG } from './helpers/structuredFixture';
import { frameDifference, frameDistinctColours, type CanvasFrame } from './helpers/gpuCanvasReadback';
import { UPDATING_FRAME_GOLDENS, readFrameGolden, writeFrameGolden } from './helpers/framePng';

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

/** The WebGL canvas's last frame, read through a 2D copy (RGBA8, top row first). */
async function readCanvasFrame(page: Page): Promise<CanvasFrame> {
  const raw = await page.evaluate(() => {
    const canvas = document.querySelector('canvas')!;
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    const context = copy.getContext('2d')!;
    context.drawImage(canvas, 0, 0);
    const { data } = context.getImageData(0, 0, copy.width, copy.height);
    let binary = '';
    for (let i = 0; i < data.length; i += 0x8000) {
      binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
    }
    return { width: copy.width, height: copy.height, rgba: btoa(binary) };
  });
  return { width: raw.width, height: raw.height, pixels: Buffer.from(raw.rgba, 'base64'), format: 'rgba8unorm' };
}

/**
 * A frame once two consecutive reads agree — the corpus, upload and luminance
 * land asynchronously. A flat frame is the canvas before the image arrived,
 * not a settled scene, so it never counts as stable.
 */
async function readStableCanvasFrame(page: Page, attempts = 20, gapMs = 300): Promise<CanvasFrame> {
  let previous = await readCanvasFrame(page);
  for (let i = 0; i < attempts; i += 1) {
    await page.waitForTimeout(gapMs);
    const next = await readCanvasFrame(page);
    if (next.pixels.equals(previous.pixels) && frameDistinctColours(next) > 1) return next;
    previous = next;
  }
  throw new Error(`Canvas never settled: ${attempts + 1} frames ${gapMs}ms apart all differed.`);
}

/**
 * A frozen scene (see `graph-executor.spec.ts`): no spin, distinct angles so the
 * bands overlap and the stamp fires, and zero tracer durations so the frame is
 * a function of the settled scene alone.
 */
const FROZEN_SCENE = encodePresetParam({
  version: 1,
  settings: {
    layers: { angles: [0, 40, 80], extensions: [0, 0, 0], opacity: 0.66 },
    tracers: { aboveDuration: 0, belowDuration: 0 },
  },
});

/**
 * Small enough that the canvas's long edge is under the WebGL internal-scale
 * floor (480 px), so the adaptive budget cannot step the frame's resolution
 * down mid-test on a loaded runner: the scale is pinned at 1.
 */
const GOLDEN_VIEWPORT = { width: 900, height: 480 } as const;

/**
 * Hide the extensions that make `RGBA16F` renderable, so the executor's pool
 * falls back to the `RGBA8` targets the hand-written passes drew into — what
 * `webgl-default-composite.png` was captured from.
 */
async function withEightBitTargets(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const original = WebGL2RenderingContext.prototype.getExtension as (this: WebGL2RenderingContext, name: string) => unknown;
    WebGL2RenderingContext.prototype.getExtension = function (this: WebGL2RenderingContext, name: string) {
      if (name === 'EXT_color_buffer_half_float' || name === 'EXT_color_buffer_float') return null;
      return original.call(this, name);
    } as WebGL2RenderingContext['getExtension'];
  });
}

async function openWebglScene(page: Page, query: string): Promise<void> {
  await stubMinimalCorpus(page);
  await page.route('**/e2e-fixture.png', (route) => route.fulfill({
    contentType: 'image/png',
    body: STRUCTURED_FIXTURE_PNG,
  }));
  await page.setViewportSize(GOLDEN_VIEWPORT);
  await page.goto(`/?renderer=webgl${query}&preset=${FROZEN_SCENE}`);
  await waitForWebGL(page);
}

/**
 * The `?graph` gate (docs/PASS_GRAPH.md): which graph shape the session draws.
 *
 * On WebGL the graph is the renderer too: `WebGLGraphExecutor` draws every
 * frame of every shape, so these specs assert both the breadcrumbs and that
 * something is on the canvas. Shader identity is pinned in
 * `src/engine/graph/shaderParity.test.ts`; the default graph's WebGL frame is
 * pinned in `e2e/__golden__/webgl-default-composite.png`.
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

  test('compiles with no ?graph at all, and the WebGL executor draws it', async ({ page }) => {
    await page.goto('/?renderer=webgl');
    await waitForWebGL(page);
    await page.waitForFunction(() => window.passGraphExecuting === 'default');

    const crumbs = await page.evaluate(() => ({
      active: window.passGraphActive,
      name: window.passGraphName,
      compileCount: window.passGraphCompileCount,
      error: window.passGraphError,
      executing: window.passGraphExecuting ?? null,
      slots: window.passGraphSlotsExecuting,
      executed: window.passGraphExecutedPasses,
    }));
    // The renderer's variant is the gate's graph, so it compiles nothing more.
    expect(crumbs).toEqual({
      active: true,
      name: 'default',
      compileCount: 1,
      error: null,
      executing: 'default',
      slots: { main: 'default' },
      executed: ['layer0', 'layer1', 'layer2', 'tracer-below', 'tracer-above', 'composite'],
    });
  });

  test('draws the default graph as the hand-written WebGL passes did, pixel for pixel', async ({ page }) => {
    await withEightBitTargets(page);
    await openWebglScene(page, '');
    await page.waitForFunction(() => window.passGraphExecuting === 'default');
    const frame = await readStableCanvasFrame(page);
    expect(await page.evaluate(() => window.webglInternalScale)).toBe(1);
    expect(await page.evaluate(() => window.webglInternalFormat)).toBe('rgba8');
    expect(frameDistinctColours(frame)).toBeGreaterThan(8);

    // Captured from the hand-drawn layer / persistence / compositor passes at
    // the last commit that had them. `RGBA` / `UNSIGNED_BYTE` targets: not
    // the WebGPU frames in this directory, which come from another backend.
    if (UPDATING_FRAME_GOLDENS) {
      writeFrameGolden('webgl-default-composite', frame);
      return;
    }
    const golden = readFrameGolden('webgl-default-composite', frame.format);
    expect(frameDifference(frame, golden)).toEqual({ differingPixels: 0, maxChannelDelta: 0 });
  });

  test('draws the same frame over half-float targets, short of 8-bit rounding', async ({ page }) => {
    await openWebglScene(page, '');
    await page.waitForFunction(() => window.passGraphExecuting === 'default');
    test.skip(
      await page.evaluate(() => window.webglInternalFormat) !== 'rgba16f',
      'this context cannot render RGBA16F',
    );
    expect(await page.evaluate(() => window.webglInternalFormatNote)).toBeNull();
    const frame = await readStableCanvasFrame(page);
    const golden = readFrameGolden('webgl-default-composite', frame.format);
    // The layers and tracers no longer round to 8 bits between passes, so the
    // frame moves by a rounding step or two — and by nothing more.
    expect(frameDifference(frame, golden).maxChannelDelta).toBeLessThanOrEqual(2);
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

  // The shapes WebGL used to refuse by name. Each now draws through the
  // executor: the breadcrumbs say so, and the canvas is not black.
  for (const [name, node] of [
    ['feedback', 'layer0-warp'],
    ['smear', 'smear-history'],
    ['trails3', 'tracer-echo'],
    ['warp', 'layer0-warp'],
    ['blur', 'layer0-blur-x'],
  ] as const) {
    test(`draws ?graph=${name} through the WebGL executor`, async ({ page }) => {
      await openWebglScene(page, `&graph=${name}`);
      await page.waitForFunction((shape) => window.passGraphExecuting === shape, name);

      const crumbs = await page.evaluate(() => ({
        active: window.passGraphActive,
        error: window.passGraphError,
        name: window.passGraphName,
        slots: window.passGraphSlotsExecuting,
        executed: window.passGraphExecutedPasses,
      }));
      expect(crumbs.active).toBe(true);
      expect(crumbs.error).toBeNull();
      expect(crumbs.name).toBe(name);
      expect(crumbs.slots).toEqual({ main: name });
      expect(crumbs.executed).toContain(node);

      await expect.poll(() => canvasDistinctColours(page), { timeout: 15_000 }).toBeGreaterThan(8);
    });
  }

  test('a different shape draws different pixels: ?graph=feedback is not the default graph', async ({ page }) => {
    await openWebglScene(page, '&graph=feedback');
    await page.waitForFunction(() => window.passGraphExecuting === 'feedback');
    const frame = await readStableCanvasFrame(page);
    expect(frameDistinctColours(frame)).toBeGreaterThan(8);
    test.skip(UPDATING_FRAME_GOLDENS, 'goldens are being rewritten');
    const golden = readFrameGolden('webgl-default-composite', frame.format);
    expect(frameDifference(frame, golden).differingPixels).toBeGreaterThan(1000);
  });
});
