import { describe, expect, it } from 'vitest';
import {
  buildBandLut,
  classifyPixelBands,
  classifyPixelBandsLut,
} from './bandClassification';

describe('buildBandLut', () => {
  const avgLums = [0, 32, 100, 128, 190, 255];

  it('matches branchy classify on grey pixels for all avgLum values', () => {
    for (const avgLum of avgLums) {
      const lut = buildBandLut(avgLum);
      for (let grey = 0; grey < 256; grey += 1) {
        const branchy = classifyPixelBands(grey, grey, grey, avgLum);
        const lutBand = classifyPixelBandsLut(grey, grey, grey, avgLum, lut);
        expect(lutBand, `grey=${grey} avgLum=${avgLum}`).toBe(branchy);
      }
    }
  });

  it('matches branchy classify on the golden RGBA image', () => {
    const width = 64;
    const height = 64;
    const avgLums = [0, 32, 100, 128, 128.4, 190, 255];

    for (const avgLum of avgLums) {
      const lut = buildBandLut(Math.round(avgLum));
      let mismatches = 0;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const v = Math.round((x / Math.max(1, width - 1)) * 255);
          const band = (x + y) % 3;
          const r = band === 0 ? v : 32;
          const g = band === 1 ? v : 64;
          const b = band === 2 ? v : 96;
          const branchy = classifyPixelBands(r, g, b, Math.round(avgLum));
          const lutBand = classifyPixelBandsLut(r, g, b, Math.round(avgLum), lut);
          if (branchy !== lutBand) mismatches += 1;
        }
      }
      expect(mismatches, `avgLum=${avgLum}`).toBe(0);
    }
  });
});
