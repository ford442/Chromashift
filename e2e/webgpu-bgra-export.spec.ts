import { expect, test, type Page } from '@playwright/test';
import { encodeFramePng } from './helpers/framePng';
import { setE2eViewport, stubMinimalCorpus } from './helpers/mockCorpus';
import { waitForWebGPU } from './helpers/renderer';

/**
 * Offscreen readbacks are RGBA whatever the canvas format.
 *
 * Exports and the stationary previews render into the canvas's *preferred*
 * format, which desktop Chrome reports as `bgra8unorm` on Windows and macOS,
 * and read the bytes back for consumers that all treat them as RGBA (PNG and
 * video export, the preview thumbnails). Without the swizzle in
 * `GpuReadback`, a red frame came out blue there — and nowhere CI ran, since
 * Linux prefers `rgba8unorm`.
 *
 * The runner's preferred format is forced each way and the Separated preview
 * (a still, deterministic render read back through `readTexturePixels`) must
 * come out the same — and colourful enough that a swapped R/B would show.
 */

type Rgba = number[];

/**
 * A hue × brightness sweep standing in for the corpus image: the stock 8×8
 * fixture is one flat colour, which lands in a single dark band and previews
 * as solid black — and black reads the same with R and B swapped.
 */
const SWEEP_PNG = (() => {
  const size = 96;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const hue = (x / size) * 6;
      const value = 0.25 + 0.75 * (1 - y / size);
      const f = hue - Math.floor(hue);
      const sector = [
        [1, f, 0], [1 - f, 1, 0], [0, 1, f], [0, 1 - f, 1], [f, 0, 1], [1, 0, 1 - f],
      ][Math.floor(hue) % 6];
      const i = (y * size + x) * 4;
      pixels[i] = Math.round(sector[0] * value * 255);
      pixels[i + 1] = Math.round(sector[1] * value * 255);
      pixels[i + 2] = Math.round(sector[2] * value * 255);
      pixels[i + 3] = 255;
    }
  }
  return encodeFramePng({ width: size, height: size, pixels });
})();

async function separatedPreview(page: Page, format: GPUTextureFormat): Promise<Rgba> {
  await page.addInitScript((forced) => {
    if (typeof GPU === 'undefined') return;
    GPU.prototype.getPreferredCanvasFormat = () => forced;
  }, format);
  await setE2eViewport(page);
  await stubMinimalCorpus(page);
  await page.route('**/e2e-fixture.png', (route) => route.fulfill({ contentType: 'image/png', body: SWEEP_PNG }));
  await page.goto('/?renderer=webgpu');
  const hasAdapter = await page.evaluate(async () => Boolean(await navigator.gpu?.requestAdapter()));
  test.skip(!hasAdapter, 'No WebGPU adapter on this runner');
  await waitForWebGPU(page);
  expect(await page.evaluate(() => navigator.gpu.getPreferredCanvasFormat())).toBe(format);

  // A cheap fingerprint per poll; the pixels themselves cross over once.
  const fingerprint = () => page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="preview-separated"]');
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return null;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let colour = 0;
    let hash = 0;
    for (let i = 0; i < data.length; i += 1) {
      if (i % 4 !== 3) colour += data[i];
      hash = (Math.imul(hash, 31) + data[i]) | 0;
    }
    return colour === 0 ? null : hash;
  });

  // The preview re-renders as the mask and luminance arrive; take it once it
  // has drawn and stopped changing.
  let previous: number | null = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const current = await fingerprint();
    if (current !== null && current === previous) {
      return page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="preview-separated"]')!;
        return [...canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data];
      });
    }
    previous = current;
    await page.waitForTimeout(500);
  }
  throw new Error(`the Separated preview never settled on ${format} (last fingerprint ${String(previous)})`);
}

test.describe('WebGPU readback on a bgra8unorm canvas', () => {
  test.describe.configure({ timeout: 120_000 });

  test('the Separated preview reads back the same on bgra8unorm and rgba8unorm', async ({ browser }) => {
    // One page at a time: two WebGPU pages open together starve each other
    // on a software adapter.
    const previewOn = async (format: GPUTextureFormat): Promise<Rgba> => {
      const page = await browser.newPage();
      try {
        return await separatedPreview(page, format);
      } finally {
        await page.close();
      }
    };
    const bgra = await previewOn('bgra8unorm');
    const rgba = await previewOn('rgba8unorm');

    // A grey frame would pass a swapped readback too: enough pixels must
    // differ sharply between R and B for a swap to show.
    let unbalanced = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      if (Math.abs(rgba[i] - rgba[i + 2]) >= 32) unbalanced += 1;
    }
    console.log(`[bgra-export] ${unbalanced} of ${rgba.length / 4} preview pixels have |R - B| >= 32`);
    expect(unbalanced).toBeGreaterThanOrEqual(64);

    let worst = 0;
    for (let i = 0; i < rgba.length; i += 1) worst = Math.max(worst, Math.abs(bgra[i] - rgba[i]));
    expect(worst).toBeLessThanOrEqual(1);
  });
});
