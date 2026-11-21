/**
 * Pixel-classification `*With()` dispatchers. See docs/wasm-engine.md for
 * the call-site matrix and the production-vs-benchmark export split.
 */

import { classifyPixelBandsF32 } from '../../math/bandClassification';
import { canUseWasmFn, getPersistentBuf, getWasmModule, withWasmScratch } from '../loadEngine';
import { getImageDataAtNaturalSize, type PixelSource } from '../imageBytes';

/**
 * The most pixels the C++ kernels index: `UINT32_MAX / 4` (`kMaxRgbaPixels` in
 * cpp/simd_util.h), where `pixel * 4` still fits in 32 bits. The exports refuse
 * more and leave the output untouched, which would read back as an all-zero
 * mask — so it is an error here, not a result.
 */
const MAX_RGBA_PIXELS = Math.floor(0xffffffff / 4);

/**
 * The RGBA byte length of a `width × height` image, after checking `data` holds
 * it. The kernels read exactly `width × height × 4` bytes from the heap copy of
 * `data`, so a short buffer is not a short read — it is a read past the copy,
 * into whatever follows it in the heap (the mask's own half of the allocation,
 * or another pooled buffer). Same contract and error as
 * `computeAverageLuminanceStridedWith`, and checked once for both lanes so the
 * TypeScript fallback never accepts an input the WASM lane would reject.
 */
function rgbaByteLength(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  caller: string,
): number {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0) {
    throw new RangeError(`${caller}: ${width}×${height} is not a valid image size`);
  }
  const pixelCount = width * height;
  if (pixelCount > MAX_RGBA_PIXELS) {
    throw new RangeError(`${caller}: ${width}×${height} exceeds the ${MAX_RGBA_PIXELS}-pixel limit`);
  }
  const byteLength = pixelCount * 4;
  if (data.length < byteLength) {
    throw new RangeError(
      `${caller}: ${data.length} bytes is short of ${width}×${height} RGBA (${byteLength})`,
    );
  }
  return byteLength;
}

/**
 * Classify every pixel in an `ImageData` object into colour band indices (0–10).
 *
 * One C++ call (`classifyPixelsBulk`) for the whole buffer avoids repeated
 * JS↔WASM boundary crossings.
 *
 * @param imageData  Source pixel data (e.g. from `CanvasRenderingContext2D.getImageData`).
 * @param avgLum     Per-image average luminance [0–255]; rounded to the nearest
 *                   integer first, as every classification-mask lane does.
 * @param useWasm    Attempt to use the C++ WASM engine.
 * @returns          `Int32Array` of length `imageData.width * imageData.height`,
 *                   one band index (0–10) per pixel.
 */
export function classifyPixelsBulkWith(
  imageData: { readonly data: Uint8Array | Uint8ClampedArray },
  avgLum: number,
  useWasm: boolean,
): Int32Array {
  const { data } = imageData;
  const pixelCount = data.length / 4;

  if (canUseWasmFn('_classifyPixelsBulk', useWasm)) {
    const mod = getWasmModule()!;
    // Input buffer comes from the shared persistent pool (like the other
    // dispatchers in this file); the output buffer is transient per call.
    const inPtr = getPersistentBuf(data.length);
    mod.HEAPU8.set(data, inPtr);
    return withWasmScratch(mod, pixelCount * 4, (outPtr) => { // int32 per pixel
      mod._classifyPixelsBulk(inPtr, data.length, Math.round(avgLum), outPtr);
      return mod.HEAP32.slice(outPtr >> 2, (outPtr >> 2) + pixelCount);
    });
  }

  // TypeScript fallback — byte-identical to the WASM branch above and to the
  // WebGPU mask kernel: the same rounded avgLum, the same float32 arithmetic.
  const roundedAvgLum = Math.round(avgLum);
  const result = new Int32Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const r = data[i * 4]!;
    const g = data[i * 4 + 1]!;
    const b = data[i * 4 + 2]!;
    result[i] = classifyPixelBandsF32(r, g, b, roundedAvgLum);
  }
  return result;
}

/**
 * Classify every pixel in an image into a compact uint8 mask texture payload.
 *
 * The returned mask stores one band index (0–10) per pixel and matches the
 * source image dimensions. This is intended for upload to an `r8uint` WebGPU
 * texture so layer shaders can sample precomputed classification results.
 */
export function classifyImageMaskWith(
  image: PixelSource,
  avgLum: number,
  useWasm: boolean,
): { mask: Uint8Array; width: number; height: number } | null {
  const imageData = getImageDataAtNaturalSize(image);
  if (!imageData) return null;
  return classifyPixelsMaskWith(imageData.data, imageData.width, imageData.height, avgLum, useWasm);
}

/**
 * {@link classifyImageMaskWith} over RGBA bytes already decoded — for a host
 * with no canvas to read an image through (the headless renderer).
 */
export function classifyPixelsMaskWith(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  avgLum: number,
  useWasm: boolean,
): { mask: Uint8Array; width: number; height: number } {
  const byteLength = rgbaByteLength(data, width, height, 'classifyPixelsMaskWith');
  const pixelCount = width * height;

  // `_computeClassificationMask` (no LUT) is the benchmark/parity twin: every
  // build that has it has this one, so it is never a fallback.
  if (canUseWasmFn('_computeClassificationMaskLut', useWasm)) {
    const mod = getWasmModule()!;
    // One persistent allocation holds the RGBA input and the mask after it, so
    // an image the size of the last one costs no allocation at all — a full
    // 8K frame is a quarter-gigabyte, and each malloc of it could grow the heap.
    // Only the `byteLength` the kernel reads is copied (and reserved), however
    // much longer `data` is.
    const inPtr = getPersistentBuf(byteLength + pixelCount);
    const outPtr = inPtr + byteLength;
    mod.HEAPU8.set(byteLength === data.length ? data : data.subarray(0, byteLength), inPtr);
    mod._computeClassificationMaskLut(inPtr, width, height, avgLum, outPtr);
    // Copied out: the next call reuses this very allocation.
    const mask = mod.HEAPU8.slice(outPtr, outPtr + pixelCount);
    return { mask, width, height };
  }

  const bands = classifyPixelsBulkWith({ data: data.subarray(0, byteLength) }, avgLum, false);
  const mask = new Uint8Array(pixelCount);
  mask.set(bands);
  return { mask, width, height };
}
