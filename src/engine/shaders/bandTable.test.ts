import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BAND,
  BAND_THRESHOLDS,
  classifyBandIndex,
  classifyPixelBands,
  type BandName,
} from '../math/bandClassification';
import { CLASSIFICATION_COMPUTE_SHADER } from '../compute/wgslSnippets';
import {
  BAND_WGSL,
  fragmentShaderGreenYellow,
  fragmentShaderRedOrange,
  fragmentShaderVioletBlue,
} from './index';

const BAND_NAMES = Object.keys(BAND) as BandName[];

describe('canonical band table', () => {
  it('orders thresholds strictly descending (band index = position)', () => {
    for (let i = 1; i < BAND_THRESHOLDS.length; i += 1) {
      expect(BAND_THRESHOLDS[i]).toBeLessThan(BAND_THRESHOLDS[i - 1]);
    }
  });

  it('classifies a grid of adjusted-luminance samples into the expected bands', () => {
    // Just above each threshold → that band; exactly at it → next band down.
    BAND_NAMES.forEach((name, i) => {
      expect(classifyBandIndex(BAND[name] + 0.5)).toBe(i);
      expect(classifyBandIndex(BAND[name])).toBe(i + 1);
    });
    expect(classifyBandIndex(0)).toBe(BAND_THRESHOLDS.length);
    expect(classifyBandIndex(255)).toBe(0);
  });

  it('classifies a grid of RGB samples consistently with the table', () => {
    for (let r = 0; r <= 255; r += 15) {
      for (let g = 0; g <= 255; g += 15) {
        for (let b = 0; b <= 255; b += 15) {
          const band = classifyPixelBands(r, g, b, 128);
          const adjusted = r * 0.2126 + g * 0.7152 + b * 0.0722 + 64;
          expect(band).toBe(classifyBandIndex(adjusted));
        }
      }
    }
  });
});

describe('WGSL shaders consume the canonical table', () => {
  const layerShaders: Array<[string, string, BandName[]]> = [
    ['red/orange', fragmentShaderRedOrange, ['greyHighlight', 'orange', 'red', 'borderRed']],
    ['violet/blue', fragmentShaderVioletBlue, ['violet', 'blue', 'borderBlue']],
    ['green/yellow', fragmentShaderGreenYellow, ['green', 'yellow', 'borderYellow']],
  ];

  it.each(layerShaders)('%s layer shader contains its band thresholds', (_name, source, bands) => {
    for (const band of bands) {
      expect(source).toContain(BAND_WGSL[band]);
    }
  });

  it('compute classification shader contains every threshold', () => {
    for (const name of BAND_NAMES) {
      expect(CLASSIFICATION_COMPUTE_SHADER).toContain(`rgb > ${BAND_WGSL[name]}`);
    }
  });
});

describe('C++ engine divergence guard', () => {
  it('band_table.h matches the canonical thresholds from shared/band.json', () => {
    const header = readFileSync(
      join(__dirname, '../../../cpp/band_table.h'),
      'utf8',
    );
    const found = [...header.matchAll(/(\d+)\.0f/g)].map((m) => Number(m[1]));
    expect(found).toEqual([...BAND_THRESHOLDS]);
  });
});
