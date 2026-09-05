import { describe, expect, it } from 'vitest';
import { computeCoincidence, type RgbaColor } from './coincidence';
import { COINCIDENCE_COMPUTE_SHADER } from '../compute/chores/kernels';

const OFF: RgbaColor = { r: 0, g: 0, b: 0, a: 0 };
const params = { colorThresh: 0.05, stampBoost: 1.8, tracerMode: 0 };

describe('computeCoincidence — golden small-buffer parity', () => {
  it('produces no stamp and no overlap when fewer than 2 layers are active', () => {
    const red: RgbaColor = { r: 1, g: 0, b: 0, a: 1 };
    expect(computeCoincidence([red, OFF, OFF], params)).toEqual({
      stamp: OFF, diag: OFF, hadOverlap: false,
    });
    expect(computeCoincidence([OFF, OFF, OFF], params)).toEqual({
      stamp: OFF, diag: OFF, hadOverlap: false,
    });
  });

  it('marks overlap but paints no stamp when overlapping layers share the same colour', () => {
    const red: RgbaColor = { r: 1, g: 0, b: 0, a: 1 };
    const result = computeCoincidence([red, red, OFF], params);
    expect(result.hadOverlap).toBe(true);
    expect(result.stamp).toEqual(OFF);
    expect(result.diag).toEqual(OFF);
  });

  it('paints a boosted combined-colour stamp for two distinct overlapping layers', () => {
    const red: RgbaColor = { r: 1, g: 0, b: 0, a: 1 };
    const blue: RgbaColor = { r: 0, g: 0, b: 1, a: 1 };
    const result = computeCoincidence([red, blue, OFF], params);

    expect(result.hadOverlap).toBe(true);
    expect(result.stamp.a).toBe(1);
    // combined = (0.5, 0, 0.5) * stampBoost(1.8), clamped to 1.0
    expect(result.stamp.r).toBeCloseTo(Math.min(0.5 * 1.8, 1), 6);
    expect(result.stamp.g).toBeCloseTo(0, 6);
    expect(result.stamp.b).toBeCloseTo(Math.min(0.5 * 1.8, 1), 6);
    // Dominant layer = whichever active layer has higher BT.709 luminance; red (0.2126) beats blue (0.0722).
    expect(result.diag.r).toBe(0 / 2);
    expect(result.diag.g).toBe(0.5); // only 2 of 3 layers overlap
    expect(result.diag.a).toBe(1);
  });

  it('flags all-3-layer overlap in the diagnostic green channel', () => {
    const red: RgbaColor = { r: 1, g: 0, b: 0, a: 1 };
    const green: RgbaColor = { r: 0, g: 1, b: 0, a: 1 };
    const blue: RgbaColor = { r: 0, g: 0, b: 1, a: 1 };
    const result = computeCoincidence([red, green, blue], params);
    expect(result.hadOverlap).toBe(true);
    expect(result.diag.g).toBe(1.0);
  });

  it('emits a grey highlight stamp in tracerMode 1', () => {
    const red: RgbaColor = { r: 1, g: 0, b: 0, a: 1 };
    const blue: RgbaColor = { r: 0, g: 0, b: 1, a: 1 };
    const result = computeCoincidence([red, blue, OFF], { ...params, tracerMode: 1 });
    expect(result.stamp.r).toBe(result.stamp.g);
    expect(result.stamp.g).toBe(result.stamp.b);
  });

  it('respects the colour threshold — near-transparent layers do not count', () => {
    const dim: RgbaColor = { r: 1, g: 0, b: 0, a: 0.01 };
    const blue: RgbaColor = { r: 0, g: 0, b: 1, a: 1 };
    const result = computeCoincidence([dim, blue, OFF], params);
    expect(result.hadOverlap).toBe(false);
  });
});

describe('COINCIDENCE_COMPUTE_SHADER — WGSL parity with the TS reference', () => {
  it('uses the same BT.709 luminance weights as computeCoincidence', () => {
    expect(COINCIDENCE_COMPUTE_SHADER).toContain('0.2126');
    expect(COINCIDENCE_COMPUTE_SHADER).toContain('0.7152');
    expect(COINCIDENCE_COMPUTE_SHADER).toContain('0.0722');
  });

  it('uses the same variance gate as computeCoincidence', () => {
    expect(COINCIDENCE_COMPUTE_SHADER).toContain('0.01');
  });

  it('declares the compute entry point the WebGPU chore lane dispatches', () => {
    expect(COINCIDENCE_COMPUTE_SHADER).toContain('fn coincidence_main');
    expect(COINCIDENCE_COMPUTE_SHADER).toContain('@compute');
  });
});
