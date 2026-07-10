import { describe, expect, it } from 'vitest';
import {
  classifyBandIndex,
  classifyPixelBands,
  computeAdjustedRgb,
} from './bandClassification';

// Mirrors cpp/tests/test_engine.cpp with avgLum = 128 → rgb = lum + 64
const AVG = 128;

describe('classifyPixelBands', () => {
  it('classifies high-luminance bands (layer 0)', () => {
    expect(classifyPixelBands(255, 255, 255, AVG)).toBe(0); // grey highlight
    expect(classifyPixelBands(150, 150, 150, AVG)).toBe(1); // orange
    expect(classifyPixelBands(137, 137, 137, AVG)).toBe(2); // red
    expect(classifyPixelBands(128, 128, 128, AVG)).toBe(3); // border red
  });

  it('classifies mid and low bands (layers 1–2)', () => {
    expect(classifyPixelBands(120, 120, 120, AVG)).toBe(4); // violet
    expect(classifyPixelBands(105, 105, 105, AVG)).toBe(5); // blue
    expect(classifyPixelBands(88, 88, 88, AVG)).toBe(7); // green
    expect(classifyPixelBands(30, 30, 30, AVG)).toBe(10); // dark / grey
  });
});

describe('classifyBandIndex', () => {
  it('honours strict threshold boundaries', () => {
    expect(classifyBandIndex(229.1)).toBe(0);
    expect(classifyBandIndex(229)).toBe(1);
    expect(classifyBandIndex(209.1)).toBe(1);
    expect(classifyBandIndex(209)).toBe(2);
    expect(classifyBandIndex(126)).toBe(9); // border yellow (125 < rgb ≤ 128)
    expect(classifyBandIndex(125.1)).toBe(9);
    expect(classifyBandIndex(125)).toBe(10);
  });
});

describe('computeAdjustedRgb', () => {
  it('adds lightDark/2 offset from average luminance', () => {
    const rgb = computeAdjustedRgb(128, 128, 128, AVG);
    expect(rgb).toBeCloseTo(192, 5); // lum=128, lightDark=128 → rgb=192
  });
});
