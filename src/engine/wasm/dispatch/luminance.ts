/**
 * Luminance `*With()` dispatchers. See docs/wasm-engine.md for the call-site matrix.
 */

import { canUseWasmFn, getPersistentBuf, getWasmModule } from '../loadEngine';
import { getImageBytes, getStridedRows, type PixelSource } from '../imageBytes';
import { tsComputeAverageLuminance, tsComputeAverageLuminanceStrided } from '../fallbacks/luminance';

/**
 * Compute the average ITU-R BT.709 luminance of an image element.
 *
 * When `useWasm` is `true` **and** the WASM module is loaded the computation
 * runs in the C++ engine; otherwise the TypeScript fallback is used.
 *
 * @param image    HTMLImageElement to measure.
 * @param useWasm  Attempt to use the C++ WASM engine.
 * @returns        Average luminance in [0, 255].
 */
export function computeAverageLuminanceWith(
  image: PixelSource,
  useWasm: boolean,
): number {
  if (canUseWasmFn('_computeAverageLuminance', useWasm)) {
    // Downscale to ≤256 px, copy RGBA bytes into WASM heap, call C++.
    const bytes = getImageBytes(image);
    if (!bytes) return tsComputeAverageLuminance(image);

    const mod = getWasmModule()!;
    const ptr = getPersistentBuf(bytes.length);
    mod.HEAPU8.set(bytes, ptr);
    return mod._computeAverageLuminance(ptr, bytes.length);
  }

  return tsComputeAverageLuminance(image);
}

/**
 * Compute the average ITU-R BT.709 luminance of a raw RGBA pixel buffer
 * using a spatial stride (sampling every `stride` pixels in X and Y).
 *
 * This is the fast path for large upscaled images (4K–8K) where sampling
 * every pixel would block the main thread.  When the WASM engine is loaded
 * the computation runs in C++ with SIMD acceleration; otherwise the
 * TypeScript strided loop is used as a fallback.
 *
 * @param pixels   Tightly-packed RGBA byte buffer (e.g. `result.pixels`).
 * @param width    Image width in pixels.
 * @param height   Image height in pixels.
 * @param stride   Pixel step in X and Y (≥ 1).  A stride of 1 processes every pixel.
 * @param useWasm  Attempt to use the C++ WASM engine.
 * @returns        Average luminance in [0, 255].
 */
export function computeAverageLuminanceStridedWith(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  stride: number,
  useWasm: boolean,
): number {
  const safeStride = Math.max(1, stride);
  const byteLen = width * height * 4;
  if (pixels.length < byteLen) {
    throw new RangeError(
      `computeAverageLuminanceStridedWith: ${pixels.length} bytes is short of ${width}×${height} RGBA (${byteLen})`,
    );
  }

  if (canUseWasmFn('_computeAverageLuminanceStrided', useWasm)) {
    const mod = getWasmModule()!;
    if (safeStride > 1) {
      // Copy only the samples: at 8K, stride 30 reads ~0.1% of a ~132 MB frame.
      // The C++ sums are exact, so the packed run averages to the same value.
      const columns = Math.ceil(width / safeStride);
      const rows = Math.ceil(height / safeStride);
      const samples = gatherStrided(pixels, width, height, safeStride, safeStride);
      const ptr = getPersistentBuf(samples.length);
      mod.HEAPU8.set(samples, ptr);
      return mod._computeAverageLuminanceStrided(ptr, columns, rows, 1);
    }
    const ptr = getPersistentBuf(byteLen);
    // Exactly the image: a longer buffer would overrun the allocation.
    mod.HEAPU8.set(pixels.length === byteLen ? pixels : pixels.subarray(0, byteLen), ptr);
    return mod._computeAverageLuminanceStrided(ptr, width, height, 1);
  }

  return tsComputeAverageLuminanceStrided(pixels, width, height, safeStride);
}

/**
 * Compute average BT.709 luminance for an image, choosing the best CPU path.
 *
 * - Images larger than 256 px on the longest edge use a strided full-resolution
 *   sample (`stride = floor(max(w,h) / 256)`): only the sampled rows are read
 *   out of the image (`getStridedRows`), and only the sampled pixels of those
 *   reach `computeAverageLuminanceStridedWith` — the same pixels, and so the
 *   same average, as striding over the whole frame.
 * - Smaller images use the ≤256 px downscale path via `computeAverageLuminanceWith`.
 *
 * Prefer GPU histogram from `GpuImageAnalysis` when available; this helper is for
 * CPU/WASM fallback paths (WebGL, missing compute, or mask generation errors).
 */
export function computeImageAverageLuminanceWith(
  image: PixelSource,
  useWasm: boolean,
): number {
  const naturalWidth = 'naturalWidth' in image ? image.naturalWidth : image.width;
  const naturalHeight = 'naturalWidth' in image ? image.naturalHeight : image.height;
  const width = Math.max(1, naturalWidth || image.width || 1);
  const height = Math.max(1, naturalHeight || image.height || 1);
  const maxDim = Math.max(width, height);

  if (maxDim > 256) {
    const stride = Math.max(1, Math.floor(maxDim / 256));
    const sampled = getStridedRows(image, stride);
    if (sampled) {
      const columns = Math.ceil(sampled.width / stride);
      return computeAverageLuminanceStridedWith(
        gatherStrided(sampled.data, sampled.width, sampled.rows, stride, 1),
        columns,
        sampled.rows,
        1,
        useWasm,
      );
    }
  }

  return computeAverageLuminanceWith(image, useWasm);
}

/**
 * Every `xStride`-th pixel of every `yStride`-th row, packed row-major:
 * `ceil(width / xStride) × ceil(height / yStride)` RGBA pixels.
 */
function gatherStrided(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  xStride: number,
  yStride: number,
): Uint8Array {
  const out = new Uint8Array(Math.ceil(width / xStride) * Math.ceil(height / yStride) * 4);
  let o = 0;
  for (let y = 0; y < height; y += yStride) {
    for (let x = 0; x < width; x += xStride) {
      const i = (y * width + x) * 4;
      out[o++] = data[i];
      out[o++] = data[i + 1];
      out[o++] = data[i + 2];
      out[o++] = data[i + 3];
    }
  }
  return out;
}
