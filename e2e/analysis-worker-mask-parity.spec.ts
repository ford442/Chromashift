import { expect, test } from '@playwright/test';
import { setE2eViewport, stubMinimalCorpus } from './helpers/mockCorpus';

/**
 * Byte-identity coverage for the gpu-chores CPU-lane worker.
 *
 * `analysis.worker.ts` runs the *same* dispatch functions the in-process host
 * runs, but it feeds them an `ImageBitmap` drawn onto an `OffscreenCanvas`
 * where the in-process host feeds them an `HTMLImageElement` drawn onto a DOM
 * `<canvas>` (see `PixelSource` in `wasm/imageBytes.ts`). That readback swap
 * is the one place the two lanes could silently diverge — a different decode,
 * premultiply, or color-space conversion on the bitmap would shift pixel
 * bytes and therefore band classifications, without either lane erroring.
 *
 * Vitest cannot cover this: its `node` environment has neither `Worker` nor
 * `OffscreenCanvas`, so `analysisWorkerHost.test.ts` necessarily runs against
 * an injected fake worker and can only assert request/response correlation.
 * This spec runs both real hosts in a real browser against one source image
 * and compares the masks byte for byte.
 *
 * Both hosts are driven with `useWasm: false` (the TypeScript lane) because a
 * plain checkout has no built C++ WASM engine; the readback path under test is
 * shared by both CPU lanes regardless.
 */

interface ParityReport {
  inlineMode: string;
  workerMode: string;
  inlineDims: [number, number];
  workerDims: [number, number];
  inlineAvgLum: number;
  workerAvgLum: number;
  inlineLength: number;
  workerLength: number;
  mismatchCount: number;
  /** `[index, inlineByte, workerByte]` for the first differing pixel, else null. */
  firstMismatch: [number, number, number] | null;
  standaloneInlineAvgLum: number;
  standaloneWorkerAvgLum: number;
  standaloneWorkerMode: string;
}

test.describe('gpu-chores CPU lane — worker/inline mask parity', () => {
  test('the worker lane produces a byte-identical mask to the in-process lane', async ({ page }) => {
    await setE2eViewport(page);
    await stubMinimalCorpus(page);

    // Any app URL works — this spec only needs the Vite dev server to serve
    // the engine modules the page then imports directly. `?renderer=webgl`
    // keeps the app itself off the WebGPU path so it competes as little as
    // possible with the two hosts under test.
    await page.goto('/?renderer=webgl&no_gpu_compute');

    const report = await page.evaluate<ParityReport>(async () => {
      // Non-power-of-two, non-square: a stride or rounding difference between
      // the two readback paths shows up here and would not on 512x512.
      const width = 333;
      const height = 211;

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D context unavailable');
      // A gradient plus saturated patches, so the source spans many bands
      // rather than classifying into one or two.
      const gradient = ctx.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, '#000000');
      gradient.addColorStop(0.25, '#2050c0');
      gradient.addColorStop(0.5, '#20b070');
      gradient.addColorStop(0.75, '#d04030');
      gradient.addColorStop(1, '#ffffff');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
      for (let i = 0; i < 12; i++) {
        ctx.fillStyle = `hsl(${i * 30}, 100%, ${20 + i * 5}%)`;
        ctx.fillRect((i * 27) % width, (i * 17) % height, 23, 19);
      }

      const image = new Image();
      image.src = canvas.toDataURL('image/png');
      await image.decode();

      // Path-based specifiers so this resolves through the Vite dev server at
      // runtime rather than being bundled into the spec.
      const inlinePath = '/src/engine/compute/chores/chromashiftHost.ts';
      const workerPath = '/src/engine/compute/chores/analysisWorkerHost.ts';
      const inlineMod = await import(inlinePath);
      const workerMod = await import(workerPath);

      const inlineHost = inlineMod.createChromashiftCpuHost(() => false);
      const workerHost = workerMod.createWorkerChromashiftCpuHost(() => false);

      const inlineResult = await inlineHost.analyzeImage(image, undefined, false);
      const workerResult = await workerHost.analyzeImage(image, undefined, false);
      if (!inlineResult) throw new Error('in-process host returned null');
      if (!workerResult) throw new Error('worker host returned null');

      const inlineMask: Uint8Array = inlineResult.mask;
      const workerMask: Uint8Array = workerResult.mask;

      let mismatchCount = 0;
      let firstMismatch: [number, number, number] | null = null;
      const shared = Math.min(inlineMask.length, workerMask.length);
      for (let i = 0; i < shared; i++) {
        if (inlineMask[i] !== workerMask[i]) {
          mismatchCount++;
          firstMismatch ??= [i, inlineMask[i], workerMask[i]];
        }
      }

      // The luminance-only op takes a separate worker round trip; cover it too.
      const standaloneInline = await inlineHost.computeAverageLuminance(image, false);
      const standaloneWorker = await workerHost.computeAverageLuminance(image, false);

      return {
        inlineMode: inlineResult.mode,
        workerMode: workerResult.mode,
        inlineDims: [inlineResult.width, inlineResult.height],
        workerDims: [workerResult.width, workerResult.height],
        inlineAvgLum: inlineResult.avgLuminance,
        workerAvgLum: workerResult.avgLuminance,
        inlineLength: inlineMask.length,
        workerLength: workerMask.length,
        mismatchCount,
        firstMismatch,
        standaloneInlineAvgLum: standaloneInline.avgLuminance,
        standaloneWorkerAvgLum: standaloneWorker.avgLuminance,
        standaloneWorkerMode: standaloneWorker.mode,
      };
    });

    // If the worker silently fell back to the in-process host, the byte
    // comparison below would compare the inline lane against itself and pass
    // vacuously. Assert the worker really served both ops first.
    expect(report.workerMode, 'worker host fell back to the in-process lane').toBe('worker');
    expect(report.standaloneWorkerMode).toBe('worker');
    expect(report.inlineMode).toBe('inline');

    expect(report.workerDims).toEqual(report.inlineDims);
    expect(report.workerLength).toBe(report.inlineLength);
    expect(report.inlineLength).toBe(333 * 211);

    expect(report.workerAvgLum).toBe(report.inlineAvgLum);
    expect(report.standaloneWorkerAvgLum).toBe(report.standaloneInlineAvgLum);
    expect(report.standaloneInlineAvgLum).toBe(report.inlineAvgLum);

    expect(
      report.mismatchCount,
      `worker mask differs from the in-process mask in ${report.mismatchCount} of ` +
        `${report.inlineLength} pixels; first at ${JSON.stringify(report.firstMismatch)}`,
    ).toBe(0);
  });
});
