/**
 * Pure TypeScript luminance fallbacks — used when the WASM engine is
 * unavailable or `useWasm` is false. Mirror `computeAverageLuminance` /
 * `computeAverageLuminanceStrided` in `cpp/chromashift_engine.cpp`.
 */

import { getImageBytes } from '../imageBytes';

export function tsComputeAverageLuminance(image: HTMLImageElement): number {
  const bytes = getImageBytes(image);
  if (!bytes) return 128;
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4) {
    sum += bytes[i] * 0.2126 + bytes[i + 1] * 0.7152 + bytes[i + 2] * 0.0722;
  }
  return sum / (bytes.length / 4);
}

export function tsComputeAverageLuminanceStrided(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  stride: number,
): number {
  const safeStride = Math.max(1, stride);
  let sum = 0;
  let n = 0;
  for (let y = 0; y < height; y += safeStride) {
    for (let x = 0; x < width; x += safeStride) {
      const o = (y * width + x) * 4;
      sum += pixels[o] * 0.2126 + pixels[o + 1] * 0.7152 + pixels[o + 2] * 0.0722;
      n++;
    }
  }
  return n === 0 ? 128 : sum / n;
}
