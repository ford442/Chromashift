/**
 * Pixel-classification `*With()` dispatchers. See docs/wasm-engine.md for
 * the call-site matrix and the production-vs-benchmark export split.
 */

import { classifyBandIndex, classifyPixelBands, computeAdjustedRgb } from '../../math/bandClassification';
import { canUseWasmFn, getPersistentBuf, getWasmModule } from '../loadEngine';
import { getImageBytes, getImageDataAtNaturalSize } from '../imageBytes';

/**
 * Classify a single pixel into a Chromashift colour band index (0–10).
 *
 * Band mapping (matches WGSL shaders):
 *   0  grey highlight  (rgb > 229)
 *   1  orange          (209 < rgb ≤ 229)
 *   2  red             (193 < rgb ≤ 209)
 *   3  border red      (190 < rgb ≤ 193)
 *   4  violet          (177 < rgb ≤ 190)
 *   5  blue            (161 < rgb ≤ 177)
 *   6  border blue     (158 < rgb ≤ 161)
 *   7  green           (145 < rgb ≤ 158)
 *   8  yellow          (128 < rgb ≤ 145)
 *   9  border yellow   (125 < rgb ≤ 128)
 *  10  dark / grey     (rgb ≤ 126)
 *
 * @param r       Red   [0–255]
 * @param g       Green [0–255]
 * @param b       Blue  [0–255]
 * @param avgLum  Per-image average luminance [0–255]
 * @param useWasm Attempt to use the C++ WASM engine.
 */
export function classifyPixelWith(
  r: number,
  g: number,
  b: number,
  avgLum: number,
  useWasm: boolean,
): number {
  if (canUseWasmFn('classifyPixel', useWasm)) {
    return getWasmModule()!.classifyPixel(r, g, b, avgLum);
  }

  // TypeScript fallback — mirrors the C++ implementation.
  const rgb = computeAdjustedRgb(r, g, b, avgLum);
  return classifyBandIndex(rgb);
}

/**
 * Classify every pixel in an `ImageData` object into colour band indices (0–10).
 *
 * This is the bulk version of `classifyPixelWith` — processing the whole
 * buffer in a single C++ call avoids repeated JS↔WASM boundary crossings.
 *
 * @param imageData  Source pixel data (e.g. from `CanvasRenderingContext2D.getImageData`).
 * @param avgLum     Per-image average luminance [0–255].
 * @param useWasm    Attempt to use the C++ WASM engine.
 * @returns          `Int32Array` of length `imageData.width * imageData.height`,
 *                   one band index (0–10) per pixel.
 */
export function classifyPixelsBulkWith(
  imageData: ImageData,
  avgLum: number,
  useWasm: boolean,
): Int32Array {
  const { data } = imageData;
  const pixelCount = data.length / 4;

  if (canUseWasmFn('classifyPixelsBulk', useWasm)) {
    const mod = getWasmModule()!;
    const inPtr  = mod._malloc(data.length);
    const outPtr = mod._malloc(pixelCount * 4); // int32 per pixel
    mod.HEAPU8.set(data, inPtr);
    mod.classifyPixelsBulk(inPtr, data.length, Math.round(avgLum), outPtr);
    const result = new Int32Array(pixelCount);
    for (let i = 0; i < pixelCount; i++) {
      result[i] = mod.HEAP32[(outPtr >> 2) + i];
    }
    mod._free(inPtr);
    mod._free(outPtr);
    return result;
  }

  // TypeScript fallback
  const result = new Int32Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    result[i] = classifyPixelBands(r, g, b, avgLum);
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
  image: HTMLImageElement,
  avgLum: number,
  useWasm: boolean,
): { mask: Uint8Array; width: number; height: number } | null {
  const imageData = getImageDataAtNaturalSize(image);
  if (!imageData) return null;

  const { data, width, height } = imageData;
  const pixelCount = width * height;

  if (canUseWasmFn('computeClassificationMaskLut', useWasm)) {
    const mod = getWasmModule()!;
    const inPtr = mod._malloc(data.length);
    const outPtr = mod._malloc(pixelCount);
    mod.HEAPU8.set(data, inPtr);
    mod.computeClassificationMaskLut(inPtr, width, height, avgLum, outPtr);
    const mask = new Uint8Array(pixelCount);
    mask.set(mod.HEAPU8.subarray(outPtr, outPtr + pixelCount));
    mod._free(inPtr);
    mod._free(outPtr);
    return { mask, width, height };
  }

  if (canUseWasmFn('computeClassificationMask', useWasm)) {
    const mod = getWasmModule()!;
    const inPtr = mod._malloc(data.length);
    const outPtr = mod._malloc(pixelCount);
    mod.HEAPU8.set(data, inPtr);
    mod.computeClassificationMask(inPtr, width, height, avgLum, outPtr);
    const mask = new Uint8Array(pixelCount);
    mask.set(mod.HEAPU8.subarray(outPtr, outPtr + pixelCount));
    mod._free(inPtr);
    mod._free(outPtr);
    return { mask, width, height };
  }

  const bands = classifyPixelsBulkWith(imageData, avgLum, false);
  const mask = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    mask[i] = bands[i];
  }
  return { mask, width, height };
}

/**
 * Compute a 256-bucket ITU-R BT.709 luminance histogram for an image.
 *
 * Each bucket index corresponds to a rounded luminance value in [0, 255].
 * The image is downsampled to ≤256 px before analysis.
 *
 * @param image    Source image element.
 * @param useWasm  Attempt to use the C++ WASM engine.
 * @returns        `Uint32Array` of length 256 where `result[n]` is the count
 *                 of pixels whose BT.709 luminance rounds to `n`.
 */
export function computeLuminanceHistogramWith(
  image: HTMLImageElement,
  useWasm: boolean,
): Uint32Array {
  const bytes = getImageBytes(image);
  if (!bytes) return new Uint32Array(256);

  if (canUseWasmFn('computeLuminanceHistogram', useWasm)) {
    const mod = getWasmModule()!;
    const inPtr  = getPersistentBuf(bytes.length);
    const outPtr = mod._malloc(256 * 4); // 256 uint32 values — fixed small size
    mod.HEAPU8.set(bytes, inPtr);
    mod.computeLuminanceHistogram(inPtr, bytes.length, outPtr);
    const result = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      result[i] = mod.HEAPU32[(outPtr >> 2) + i];
    }
    mod._free(outPtr);
    return result;
  }

  // TypeScript fallback
  const hist = new Uint32Array(256);
  for (let i = 0; i < bytes.length; i += 4) {
    const lum = bytes[i] * 0.2126 + bytes[i + 1] * 0.7152 + bytes[i + 2] * 0.0722;
    hist[Math.min(Math.floor(lum), 255)]++;
  }
  return hist;
}

/**
 * Count pixels per Chromashift colour band (0–10) for an image.
 *
 * Equivalent to calling `classifyPixelsBulkWith` and tallying, but avoids
 * allocating the per-pixel band array.  The image is downsampled to ≤256 px.
 *
 * @param image    Source image element.
 * @param avgLum   Per-image average luminance [0–255].
 * @param useWasm  Attempt to use the C++ WASM engine.
 * @returns        `Uint32Array` of length 11 where `result[n]` is the pixel
 *                 count for colour band `n`.  See `classifyPixelWith` for the
 *                 band-to-index mapping.
 */
export function computeColorBandCountsWith(
  image: HTMLImageElement,
  avgLum: number,
  useWasm: boolean,
): Uint32Array {
  const bytes = getImageBytes(image);
  if (!bytes) return new Uint32Array(11);

  if (canUseWasmFn('computeColorBandCounts', useWasm)) {
    const mod = getWasmModule()!;
    const inPtr  = getPersistentBuf(bytes.length);
    const outPtr = mod._malloc(11 * 4); // 11 uint32 values — fixed small size
    mod.HEAPU8.set(bytes, inPtr);
    mod.computeColorBandCounts(inPtr, bytes.length, Math.round(avgLum), outPtr);
    const result = new Uint32Array(11);
    for (let i = 0; i < 11; i++) {
      result[i] = mod.HEAPU32[(outPtr >> 2) + i];
    }
    mod._free(outPtr);
    return result;
  }

  // TypeScript fallback
  const counts = new Uint32Array(11);
  for (let i = 0; i < bytes.length; i += 4) {
    const r = bytes[i];
    const g = bytes[i + 1];
    const b = bytes[i + 2];
    const rgb = computeAdjustedRgb(r, g, b, avgLum);
    const band = classifyBandIndex(rgb);
    counts[band]++;
  }
  return counts;
}
