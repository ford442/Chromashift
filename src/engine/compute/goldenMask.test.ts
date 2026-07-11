import { describe, expect, it } from 'vitest';
import {
  BAND_THRESHOLDS,
  bt709Luminance,
  classifyPixelBands,
} from '../math/bandClassification';
import { CLASSIFICATION_COMPUTE_SHADER, WGSL_IMAGE_ANALYSIS_HELPERS } from './wgslSnippets';

/** Build a small synthetic RGBA image covering all luminance bands. */
function buildGoldenRgba(width: number, height: number): Uint8ClampedArray<ArrayBuffer> {
  const data = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const v = Math.round((x / Math.max(1, width - 1)) * 255);
      const band = (x + y) % 3;
      data[i] = band === 0 ? v : 32;
      data[i + 1] = band === 1 ? v : 64;
      data[i + 2] = band === 2 ? v : 96;
      data[i + 3] = 255;
    }
  }
  return data;
}

/**
 * Verbatim port of chromashift_engine.cpp classifyPixel using f32 arithmetic
 * (Math.fround), which is also exactly what the WGSL classify_band() compute
 * shader executes per pixel. This is the golden reference the GPU mask must
 * match byte-for-byte.
 */
function classifyPixelF32(r: number, g: number, b: number, avgLum: number): number {
  const lum = Math.fround(
    Math.fround(r * Math.fround(0.2126))
    + Math.fround(g * Math.fround(0.7152))
    + Math.fround(b * Math.fround(0.0722)),
  );
  const lightDark = Math.fround(128 + Math.fround(Math.abs(avgLum - 128) / 2));
  const rgb = Math.fround(lum + Math.fround(lightDark / 2));

  for (let i = 0; i < BAND_THRESHOLDS.length; i += 1) {
    if (rgb > BAND_THRESHOLDS[i]) return i;
  }
  return BAND_THRESHOLDS.length;
}

/** Port of C++ computeClassificationMask (rounds avgLum, RGBA input). */
function computeClassificationMaskF32(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  avgLum: number,
): Uint8Array {
  const mask = new Uint8Array(width * height);
  const roundedAvg = Math.round(avgLum);
  for (let i = 0; i < width * height; i += 1) {
    const o = i * 4;
    mask[i] = classifyPixelF32(data[o], data[o + 1], data[o + 2], roundedAvg);
  }
  return mask;
}

describe('classification mask golden parity', () => {
  const width = 64;
  const height = 64;
  const rgba = buildGoldenRgba(width, height);
  const avgLums = [0, 32, 100, 128, 128.4, 190, 255];

  it('TS fallback (double) matches C++/WGSL f32 reference on the golden image', () => {
    for (const avgLum of avgLums) {
      const golden = computeClassificationMaskF32(rgba, width, height, avgLum);
      const roundedAvg = Math.round(avgLum);
      let mismatches = 0;
      for (let i = 0; i < golden.length; i += 1) {
        const o = i * 4;
        const band = classifyPixelBands(rgba[o], rgba[o + 1], rgba[o + 2], roundedAvg);
        if (band !== golden[i]) mismatches += 1;
      }
      // ±0 banding allowed at edges: the double and f32 paths must agree exactly.
      expect(mismatches, `avgLum=${avgLum}`).toBe(0);
    }
  });

  it('WGSL classify_band is generated from BAND_THRESHOLDS (single source of truth)', () => {
    for (let i = 0; i < BAND_THRESHOLDS.length; i += 1) {
      expect(WGSL_IMAGE_ANALYSIS_HELPERS).toContain(
        `if (rgb > ${BAND_THRESHOLDS[i].toFixed(1)}) { return ${i}u; }`,
      );
    }
    expect(WGSL_IMAGE_ANALYSIS_HELPERS).toContain(`return ${BAND_THRESHOLDS.length}u;`);
    expect(CLASSIFICATION_COMPUTE_SHADER).toContain('rounded_avg = round(mask_params.avg_lum)');
  });

  it('histogram-derived average stays within one bucket of the exact BT.709 average', () => {
    // Mirror the GPU histogram: bucket = u32(clamp(lum, 0, 255)) per pixel.
    const histogram = new Uint32Array(256);
    let exactSum = 0;
    const pixelCount = width * height;
    for (let i = 0; i < pixelCount; i += 1) {
      const o = i * 4;
      const lum = bt709Luminance(rgba[o], rgba[o + 1], rgba[o + 2]);
      exactSum += lum;
      histogram[Math.min(255, Math.max(0, Math.floor(lum)))] += 1;
    }

    let bucketSum = 0;
    let count = 0;
    for (let bucket = 0; bucket < 256; bucket += 1) {
      bucketSum += bucket * histogram[bucket];
      count += histogram[bucket];
    }

    expect(count).toBe(pixelCount);
    const histogramAvg = bucketSum / count;
    const exactAvg = exactSum / pixelCount;
    expect(Math.abs(histogramAvg - exactAvg)).toBeLessThan(1);
  });
});
