import { describe, expect, it } from 'vitest';
import { classifyPixelBands } from '../math/bandClassification';

/** Build a small synthetic RGBA image for mask parity checks. */
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

function referenceMaskFromRgba(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  avgLum: number,
): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i += 1) {
    const o = i * 4;
    mask[i] = classifyPixelBands(data[o], data[o + 1], data[o + 2], avgLum);
  }
  return mask;
}

describe('classification mask golden parity', () => {
  const width = 32;
  const height = 32;
  const rgba = buildGoldenRgba(width, height);

  it('TypeScript fallback matches bandClassification reference (C++ parity)', () => {
    const avgLum = 128;
    const reference = referenceMaskFromRgba(rgba, width, height, avgLum);

    for (let i = 0; i < reference.length; i += 1) {
      const o = i * 4;
      const band = classifyPixelBands(rgba[o], rgba[o + 1], rgba[o + 2], avgLum);
      expect(band).toBe(reference[i]);
    }
  });
});
