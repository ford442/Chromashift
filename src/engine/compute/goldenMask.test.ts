import { describe, expect, it } from 'vitest';
import {
  BAND_THRESHOLDS,
  bt709Luminance,
  classifyPixelBands,
  classifyPixelBandsF32,
} from '../math/bandClassification';
import { classifyPixelsBulkWith } from '../wasm/dispatch/classification';
import { CLASSIFICATION_COMPUTE_SHADER, WGSL_IMAGE_ANALYSIS_HELPERS } from './chores/kernels';

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
  // Rounded after every operation: `(r*R + g*G) + b*B` is two f32 adds, and
  // rounding the three-term sum once in doubles is not the same thing.
  const lum = Math.fround(
    Math.fround(
      Math.fround(r * Math.fround(0.2126))
      + Math.fround(g * Math.fround(0.7152)),
    )
    + Math.fround(b * Math.fround(0.0722)),
  );
  const lightDark = Math.fround(128 + Math.fround(Math.abs(avgLum - 128) / 2));
  const rgb = Math.fround(lum + Math.fround(lightDark / 2));

  for (let i = 0; i < BAND_THRESHOLDS.length; i += 1) {
    if (rgb > BAND_THRESHOLDS[i]!) return i;
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
    mask[i] = classifyPixelF32(data[o]!, data[o + 1]!, data[o + 2]!, roundedAvg);
  }
  return mask;
}

describe('classification mask golden parity', () => {
  const width = 64;
  const height = 64;
  const rgba = buildGoldenRgba(width, height);
  const avgLums = [0, 32, 100, 128, 128.4, 190, 255];

  /** Run the TypeScript mask fallback (`useWasm: false`) over raw RGBA. */
  const tsFallbackMask = (data: Uint8ClampedArray, w: number, h: number, avgLum: number) =>
    classifyPixelsBulkWith({ data, width: w, height: h } as ImageData, avgLum, false);

  it('TS fallback matches the C++/WGSL f32 reference on the golden image', () => {
    for (const avgLum of avgLums) {
      const golden = computeClassificationMaskF32(rgba, width, height, avgLum);
      const mask = tsFallbackMask(rgba, width, height, avgLum);
      let mismatches = 0;
      for (let i = 0; i < golden.length; i += 1) {
        if (mask[i] !== golden[i]) mismatches += 1;
      }
      expect(mismatches, `avgLum=${avgLum}`).toBe(0);
    }
  });

  // Colours whose BT.709 luminance lands within float32 rounding of a band
  // threshold, found by sweeping all 2^24 RGB values at each avgLum: the double
  // path (`classifyPixelBands`) puts them in the neighbouring band. The mask
  // fallback used it, so with the WASM engine loaded a few pixels per 4K frame
  // differed between lanes.
  const boundaryCases: Array<{ avgLum: number; rgb: [number, number, number] }> = [
    { avgLum: 0, rgb: [246, 109, 38] },
    { avgLum: 64, rgb: [50, 186, 74] },
    { avgLum: 64, rgb: [115, 169, 51] },
    { avgLum: 128, rgb: [29, 192, 21] },
    { avgLum: 128, rgb: [49, 212, 41] },
    { avgLum: 128, rgb: [81, 136, 201] },
  ];

  it('TS fallback rounds in f32 where the double path lands in the neighbouring band', () => {
    for (const { avgLum, rgb: [r, g, b] } of boundaryCases) {
      const pixel = new Uint8ClampedArray([r, g, b, 255]);
      const expected = computeClassificationMaskF32(pixel, 1, 1, avgLum)[0];
      expect(classifyPixelBands(r, g, b, avgLum), `double path differs for ${r},${g},${b}`)
        .not.toBe(expected);
      expect(classifyPixelBandsF32(r, g, b, avgLum)).toBe(expected);
      expect(tsFallbackMask(pixel, 1, 1, avgLum)[0], `${r},${g},${b} @ ${avgLum}`).toBe(expected);
    }
  });

  it('TS fallback rounds a fractional avgLum, as the WASM and WebGPU lanes do', () => {
    // 64.4 and 200.6 round to 64 and 201; unrounded they shift the offset by
    // 0.1–0.15, enough to move ~0.5% of a random image across a threshold.
    let state = 0x1234567;
    const pixels = new Uint8ClampedArray(97 * 61 * 4);
    for (let i = 0; i < pixels.length; i += 1) {
      state = (state * 1103515245 + 12345) >>> 0;
      pixels[i] = i % 4 === 3 ? 255 : state >>> 24;
    }
    for (const avgLum of [64.4, 128.5, 200.6]) {
      const golden = computeClassificationMaskF32(pixels, 97, 61, avgLum);
      expect(Array.from(tsFallbackMask(pixels, 97, 61, avgLum)), `avgLum=${avgLum}`)
        .toEqual(Array.from(golden));
    }
  });

  it('WGSL classify_band is generated from BAND_THRESHOLDS (single source of truth)', () => {
    for (const [i, threshold] of BAND_THRESHOLDS.entries()) {
      expect(WGSL_IMAGE_ANALYSIS_HELPERS).toContain(
        `if (rgb > ${threshold.toFixed(1)}) { return ${i}u; }`,
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
      const lum = bt709Luminance(rgba[o]!, rgba[o + 1]!, rgba[o + 2]!);
      exactSum += lum;
      histogram[Math.min(255, Math.max(0, Math.floor(lum)))]! += 1;
    }

    let bucketSum = 0;
    let count = 0;
    for (const [bucket, n] of histogram.entries()) {
      bucketSum += bucket * n;
      count += n;
    }

    expect(count).toBe(pixelCount);
    const histogramAvg = bucketSum / count;
    const exactAvg = exactSum / pixelCount;
    expect(Math.abs(histogramAvg - exactAvg)).toBeLessThan(1);
  });
});
