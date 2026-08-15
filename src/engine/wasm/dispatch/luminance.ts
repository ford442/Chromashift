/**
 * Luminance `*With()` dispatchers. See docs/wasm-engine.md for the call-site matrix.
 */

import { canUseWasmFn, getPersistentBuf, getWasmModule } from '../loadEngine';
import { getImageBytes, getImageDataAtNaturalSize } from '../imageBytes';
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
  image: HTMLImageElement,
  useWasm: boolean,
): number {
  if (canUseWasmFn('computeAverageLuminance', useWasm)) {
    // Downscale to ≤256 px, copy RGBA bytes into WASM heap, call C++.
    const bytes = getImageBytes(image);
    if (!bytes) return tsComputeAverageLuminance(image);

    const mod = getWasmModule()!;
    const ptr = getPersistentBuf(bytes.length);
    mod.HEAPU8.set(bytes, ptr);
    return mod.computeAverageLuminance(ptr, bytes.length);
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

  if (canUseWasmFn('computeAverageLuminanceStrided', useWasm)) {
    const mod = getWasmModule()!;
    const byteLen = width * height * 4;
    const ptr = getPersistentBuf(byteLen);
    mod.HEAPU8.set(pixels, ptr);
    return mod.computeAverageLuminanceStrided(ptr, width, height, safeStride);
  }

  return tsComputeAverageLuminanceStrided(pixels, width, height, safeStride);
}

/**
 * Compute average BT.709 luminance for an image, choosing the best CPU path.
 *
 * - Images larger than 256 px on the longest edge use a strided full-resolution
 *   sample (`stride = floor(max(w,h) / 256)`) via `computeAverageLuminanceStridedWith`.
 * - Smaller images use the ≤256 px downscale path via `computeAverageLuminanceWith`.
 *
 * Prefer GPU histogram from `GpuImageAnalysis` when available; this helper is for
 * CPU/WASM fallback paths (WebGL, missing compute, or mask generation errors).
 */
export function computeImageAverageLuminanceWith(
  image: HTMLImageElement,
  useWasm: boolean,
): number {
  const width = Math.max(1, image.naturalWidth || image.width || 1);
  const height = Math.max(1, image.naturalHeight || image.height || 1);
  const maxDim = Math.max(width, height);

  if (maxDim > 256) {
    const imageData = getImageDataAtNaturalSize(image);
    if (imageData) {
      const stride = Math.max(1, Math.floor(maxDim / 256));
      return computeAverageLuminanceStridedWith(
        imageData.data,
        width,
        height,
        stride,
        useWasm,
      );
    }
  }

  return computeAverageLuminanceWith(image, useWasm);
}
