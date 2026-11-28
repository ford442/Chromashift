/**
 * Shared pieces of the release scenarios: how the app is opened, what "the
 * canvas shows something" means, the generated images the offline corpus serves,
 * and the screenshots the State of the App report embeds.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { armRenderDebug, waitForWebGL, waitForWebGPU } from '../helpers/renderer';
import { readGpuCanvasFrame } from '../helpers/gpuCanvasReadback';
import { primeOverlaySections, type OverlaySectionId } from '../helpers/overlaySections';
import { expect, RESULTS_DIR, type Renderer } from './gate';

/**
 * `RELEASE_STUB_CORPUS=1` (the PR job against `vite preview`): the app's own
 * `images.json` is served as built, but the remote images it points at are
 * answered locally, so the run does not depend on a third-party host. Against a
 * deployed URL it is off and the real corpus host is exercised.
 */
export const STUB_CORPUS = process.env.RELEASE_STUB_CORPUS === '1';

/** The viewport of the report's screenshots (#268 asks for at least 1440x900). */
export const VIEWPORT = { width: 1440, height: 900 } as const;

/** A relative URL, so it resolves under the base URL's path (`/chromashift-staging/`). */
export function appUrl(renderer: Renderer, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({ renderer, ...extra });
  return `?${params.toString()}`;
}

/**
 * A test image that lights up the renderer, different per `seed`. The renderer
 * isolates luminance bands relative to the image's own average, so a flat or
 * narrow-range image composites to black *correctly*; this one sweeps the whole
 * luminance range in both axes (so every band has pixels at any average) and the
 * seed shifts the blue channel, so switching images visibly changes the frame.
 */
export function makePng(seed: number, width = 320, height = 240): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      png.data[i] = Math.round((x * 255) / (width - 1));
      png.data[i + 1] = Math.round((y * 255) / (height - 1));
      png.data[i + 2] = (Math.round(((x + y) * 255) / (width + height - 2)) + seed * 37) & 0xff;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

/** Serve generated images for `url` (the corpus host, or one invented for a scenario). */
export async function serveImages(page: Page, urlGlob: string): Promise<void> {
  await page.route(urlGlob, (route) => {
    const seed = [...route.request().url()].reduce((sum, ch) => (sum * 31 + ch.charCodeAt(0)) >>> 0, 7) % 1000;
    return route.fulfill({
      status: 200,
      contentType: 'image/png',
      headers: { 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' },
      body: makePng(seed),
    });
  });
}

/** In a stubbed run (the PR job) answer the corpus host locally; against a deployed URL do nothing. */
export async function stubRemoteCorpus(page: Page): Promise<void> {
  if (STUB_CORPUS) await serveImages(page, 'https://cr0p.1ink.us/**');
}

export interface OpenOptions {
  query?: Record<string, string>;
  sections?: Partial<Record<OverlaySectionId, boolean>>;
  /** Arm `window.__renderDebug` (frame readback, simulated device loss). Default true. */
  debug?: boolean;
  /**
   * Pause once the first image is up. Default true. The app is a slideshow that
   * moves to another corpus image every second or so and shows black while the
   * next one loads, so a frame sampled while it plays is a coin flip; scenarios
   * that exercise playback pass `false`.
   */
  paused?: boolean;
}

/** Open the app in `renderer` and wait until it is drawing. */
export async function openApp(page: Page, renderer: Renderer, options: OpenOptions = {}): Promise<void> {
  if (options.debug !== false) await armRenderDebug(page);
  if (options.sections) await primeOverlaySections(page, options.sections);
  await stubRemoteCorpus(page);
  await page.goto(appUrl(renderer, options.query));
  if (renderer === 'webgl') {
    await waitForWebGL(page);
  } else {
    await waitForWebGPU(page);
    await page.waitForFunction(() => window.passGraphExecuting === 'default', undefined, { timeout: 60_000 });
  }
  // The corpus manifest and the first image land after the renderer is up.
  await expect(page.getByTestId('corpus-position')).toContainText(/\d+ \/ \d+/, { timeout: 60_000 });
  if (options.paused !== false) await pause(page);
}

/** Pause playback (the slideshow and the rotation) with a DOM click: the fixed panel can intercept a pointer. */
export async function pause(page: Page): Promise<void> {
  const button = page.getByRole('button', { name: '⏸ Pause' });
  await button.evaluate((el: HTMLElement) => el.click());
  await expect(page.getByRole('button', { name: '▶ Resume' })).toBeVisible();
}

export interface CanvasStats {
  distinctColours: number;
  /** Fraction of pixels with any channel above 24 (so black is 0). */
  litFraction: number;
  /** FNV-1a of the pixel data, to tell two frames apart. */
  hash: string;
}

function statsOf(rgba: Uint8Array, stride = 4): CanvasStats {
  const seen = new Set<number>();
  let lit = 0;
  let samples = 0;
  let hash = 0x811c9dc5;
  for (let p = 0; p < rgba.length; p += stride * 4) {
    const r = rgba[p]!;
    const g = rgba[p + 1]!;
    const b = rgba[p + 2]!;
    seen.add((r << 16) | (g << 8) | b);
    if (r > 24 || g > 24 || b > 24) lit += 1;
    samples += 1;
    hash = Math.imul(hash ^ r ^ (g << 8) ^ (b << 16), 0x01000193) >>> 0;
  }
  return { distinctColours: seen.size, litFraction: samples ? lit / samples : 0, hash: hash.toString(16) };
}

/**
 * What the main canvas is showing. WebGPU is read from the renderer's own
 * presentation texture (a headless screenshot of a WebGPU canvas can be black
 * whatever was drawn); WebGL is a screenshot of the canvas.
 */
export async function canvasStats(page: Page, renderer: Renderer, slot = 'main'): Promise<CanvasStats> {
  if (renderer === 'webgpu') {
    const frame = await readGpuCanvasFrame(page, slot);
    return statsOf(frame.pixels);
  }
  // A clip of the page, not `locator.screenshot()`: that waits for the element to
  // hold still, which a canvas that is drawing every frame never does under load.
  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('no canvas on the page');
  const clip = { x: Math.max(0, box.x), y: Math.max(0, box.y), width: Math.max(1, box.width), height: Math.max(1, box.height) };
  const png = PNG.sync.read(await page.screenshot({ clip, animations: 'allow', caret: 'initial' }));
  return statsOf(png.data);
}

/** A frame that is not black and not flat. */
export async function expectDrawing(page: Page, renderer: Renderer, slot = 'main'): Promise<CanvasStats> {
  let stats = await canvasStats(page, renderer, slot);
  await expect
    .poll(async () => {
      stats = await canvasStats(page, renderer, slot);
      return stats.litFraction > 0.05 && stats.distinctColours >= 16;
    }, { message: `the ${slot} canvas shows a lit, non-flat image`, timeout: 60_000, intervals: [250, 500, 1000] })
    .toBe(true);
  return stats;
}

/** What the screenshot caption says about the GPU: the WebGPU adapter, or the WebGL renderer string. */
export async function describeGpu(page: Page, renderer: Renderer): Promise<string> {
  return page.evaluate((r) => {
    if (r === 'webgpu') {
      const a = window.webgpuProbe?.adapter;
      return a ? [a.vendor, a.architecture, a.device, a.description].filter(Boolean).join(' / ') || 'WebGPU adapter' : 'no WebGPU adapter reported';
    }
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'WebGL2';
  }, renderer);
}

/** A screenshot for the report, with the caption facts the template asks for. */
export async function shoot(page: Page, name: string, renderer: Renderer, note = ''): Promise<void> {
  const dir = join(RESULTS_DIR, 'screenshots');
  mkdirSync(dir, { recursive: true });
  const file = `${name}.png`;
  await page.screenshot({ path: join(dir, file) });
  const viewport = page.viewportSize();
  const meta = {
    file,
    name,
    url: page.url(),
    viewport: viewport ? `${viewport.width}x${viewport.height}` : 'unknown',
    renderer,
    browser: `Chromium ${page.context().browser()?.version() ?? ''}`.trim(),
    gpu: await describeGpu(page, renderer),
    note,
  };
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(meta, null, 2)}\n`);
}

/**
 * A corpus of two tiny generated images, served by this suite: for the upscaler
 * scenarios, which need an input small enough to finish on a software rasterizer.
 */
export async function useTinyCorpus(page: Page, size = 24): Promise<void> {
  await page.route('**/images.json', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([
        { url: 'https://release-fixture.example/tiny-a.png', label: 'tiny a' },
        { url: 'https://release-fixture.example/tiny-b.png', label: 'tiny b' },
      ]),
    }),
  );
  await page.route('https://release-fixture.example/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      headers: { 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' },
      body: makePng(route.request().url().endsWith('a.png') ? 11 : 22, size, size),
    }),
  );
}
