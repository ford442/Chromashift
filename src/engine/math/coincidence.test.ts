import { describe, expect, it } from 'vitest';
import { computeCoincidence, type RgbaColor } from './coincidence';
import { COINCIDENCE_COMPUTE_SHADER } from '../compute/chores/kernels';
import {
  emitCoincidenceComputeWgsl,
  emitCoincidenceDecayWgsl,
} from '../graph/templates/wgsl';
import { normaliseShaderSource } from '../graph/shaderText';

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

/**
 * Three-way agreement: the CPU oracle above, the fused fragment pass, and the
 * standalone compute kernel must describe the same overlap test at every layer
 * count — not just at the shipped three.
 *
 * The two shaders are unrolled straight-line code over `c0 … cN-1`, so the
 * comparison is structural: the same arm for every layer, in the same order,
 * and the same two count-dependent constants the oracle uses (the dominant-layer
 * normaliser and the "every layer overlaps" threshold). The shaders spell their
 * accumulators differently — the fragment pass shipped camelCase and the kernel
 * snake_case — so names are folded before comparing, which is exactly the
 * difference that cannot reach a pixel.
 */
describe.each([2, 3, 5])('coincidence emitters agree at %i layers', (layerCount) => {
  const fragment = emitCoincidenceDecayWgsl(layerCount);
  const compute = emitCoincidenceComputeWgsl(layerCount);

  /** Fold the two accumulator spellings together and drop layout. */
  const fold = (source: string) => normaliseShaderSource(source)
    .replace(/layer_count/g, 'layerCount')
    .replace(/max_lum/g, 'maxLum')
    .replace(/dominant_layer/g, 'dominantLayer');

  /** Every `if (cN.a > thresh) { … }` arm, in source order. */
  const arms = (source: string) => fold(source).match(/if \(c\d+\.a > thresh\) \{[^}]*\}/g) ?? [];

  it('unrolls one arm per layer for count, sum, variance and dominance', () => {
    // 4 unrolled passes over the layers: count, sum, variance, dominant.
    expect(arms(fragment)).toHaveLength(layerCount * 4);
    expect(arms(compute)).toEqual(arms(fragment));
  });

  it('references every layer and no layer beyond the count', () => {
    for (const source of [fragment, compute]) {
      for (let i = 0; i < layerCount; i += 1) {
        expect(source).toContain(`let c${i} = `);
      }
      expect(source).not.toContain(`let c${layerCount} = `);
    }
  });

  it('normalises the dominant layer the same way the oracle does', () => {
    // The oracle maps the last layer index to exactly 1.0; both shaders must
    // divide by the same constant to land there.
    // Only the last layer is bright, so it wins the dominance search.
    const layers: RgbaColor[] = Array.from({ length: layerCount }, (_, i) => (
      i === layerCount - 1
        ? { r: 1, g: 1, b: 1, a: 1 }
        : { r: 0, g: 0, b: 0.1, a: 1 }
    ));
    expect(computeCoincidence(layers, params).diag.r).toBeCloseTo(1, 6);

    const divisor = Math.max(1, layerCount - 1).toFixed(1);
    expect(fold(fragment)).toContain(`diag.r = f32(dominantLayer) / ${divisor};`);
    expect(fold(compute)).toContain(`diag.r = f32(dominantLayer) / ${divisor};`);
  });

  it('flags full overlap at the same threshold the oracle does', () => {
    const allOn: RgbaColor[] = Array.from({ length: layerCount }, (_, i) => ({
      r: i / layerCount, g: 1 - i / layerCount, b: 0.5, a: 1,
    }));
    expect(computeCoincidence(allOn, params).diag.g).toBe(1);

    // One layer below threshold is a partial overlap, however many remain.
    const oneOff = allOn.map((c, i) => (i === 0 ? { ...c, a: 0 } : c));
    expect(computeCoincidence(oneOff, params).diag.g).toBe(layerCount === 2 ? 0 : 0.5);

    const flag = `select(0.5, 1.0, layerCount >= ${layerCount}u)`;
    expect(fold(fragment)).toContain(flag);
    expect(fold(compute)).toContain(flag);
  });

  it('shares the stamp, variance gate and luminance weights', () => {
    for (const source of [fragment, compute].map(fold)) {
      expect(source).toContain('if (variance > 0.01)');
      expect(source).toContain('dot(combined, vec3<f32>(0.2126, 0.7152, 0.0722))');
      expect(source).toContain('let combined = sum / f32(layerCount);');
    }
  });
});
