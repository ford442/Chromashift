import { describe, expect, it } from 'vitest';
import {
  EXTENSION_REFERENCE_FPS,
  advanceAngles,
  buildRotationMat3,
  extensionStepsForFps,
  wrapAngleDeg,
} from './rotation';

describe('wrapAngleDeg', () => {
  it('wraps positive overflow into [0, 360)', () => {
    expect(wrapAngleDeg(370)).toBe(10);
    expect(wrapAngleDeg(360)).toBe(0);
  });

  it('wraps negative angles into [0, 360)', () => {
    expect(wrapAngleDeg(-10)).toBe(350);
    expect(wrapAngleDeg(-370)).toBe(350);
  });

  it('preserves angles already in range', () => {
    expect(wrapAngleDeg(90)).toBe(90);
    expect(wrapAngleDeg(0)).toBe(0);
  });

  it('keeps the result strictly below 360 and never -0', () => {
    expect(wrapAngleDeg(-360)).toBe(0);
    expect(wrapAngleDeg(-0)).toBe(0);
    expect(wrapAngleDeg(-1e-20)).toBeLessThan(360);
  });
});

describe('advanceAngles', () => {
  it('advances angles by extensions with wraparound at 360', () => {
    expect(advanceAngles([0, 100, 350], [10, 20, 30])).toEqual([10, 120, 20]);
    const prev: [number, number, number] = [5, 5, 5];
    expect(advanceAngles(prev, [0, 0, 0])).toEqual([5, 5, 5]);
    expect(prev).toEqual([5, 5, 5]);
  });

  it('wraps negative steps into [0, 360)', () => {
    expect(advanceAngles([0, 10, 180, 359, 45], [-30, -20, -720, -359, -405]))
      .toEqual([330, 350, 180, 0, 0]);
  });

  it('scales extension steps so wall-clock spin is FPS-independent', () => {
    // At reference 30 FPS, one frame advances by the stored step.
    expect(advanceAngles([0, 0, 0], [130, 230, 330], 30)).toEqual([130, 230, 330]);
    // At 60 FPS, each frame advances half as far — two frames match one 30 FPS frame.
    const half = advanceAngles([0, 0, 0], [130, 230, 330], 60);
    expect(half[0]).toBeCloseTo(65);
    expect(half[1]).toBeCloseTo(115);
    expect(half[2]).toBeCloseTo(165);
    const full = advanceAngles(half, [130, 230, 330], 60);
    expect(full[0]).toBeCloseTo(130);
    expect(full[1]).toBeCloseTo(230);
    expect(full[2]).toBeCloseTo(330);
  });

  it('takes the layer count from extensions: new layers start at zero', () => {
    // A count change (preset load, layer-count control) leaves the clock behind.
    expect(advanceAngles([10, 20, 30], [1, 2, 3, 4, 5])).toEqual([11, 22, 33, 4, 5]);
  });

  it('takes the layer count from extensions: surplus angles are dropped', () => {
    expect(advanceAngles([10, 20, 30, 40, 50], [1, 2, 3])).toEqual([11, 22, 33]);
  });

  it('never produces NaN when the clock is empty', () => {
    expect(advanceAngles([], [7, 8])).toEqual([7, 8]);
    expect(advanceAngles([1, 2], [])).toEqual([]);
  });
});

describe('extensionStepsForFps', () => {
  it('leaves steps unchanged at the reference FPS', () => {
    expect(extensionStepsForFps([130, 230, 330], EXTENSION_REFERENCE_FPS)).toEqual([
      130, 230, 330,
    ]);
  });

  it('halves per-frame steps at 2× reference FPS', () => {
    const steps = extensionStepsForFps([130, 230, 330], 60);
    expect(steps[0]).toBeCloseTo(65);
    expect(steps[1]).toBeCloseTo(115);
    expect(steps[2]).toBeCloseTo(165);
  });

  it('keeps total rotation over one second constant across FPS', () => {
    const ext: [number, number, number] = [130, 230, 330];
    for (const fps of [20, 30, 60] as const) {
      const perFrame = extensionStepsForFps(ext, fps);
      const perSecond = perFrame.map((d) => d * fps);
      expect(perSecond[0]).toBeCloseTo(ext[0] * EXTENSION_REFERENCE_FPS);
      expect(perSecond[1]).toBeCloseTo(ext[1] * EXTENSION_REFERENCE_FPS);
      expect(perSecond[2]).toBeCloseTo(ext[2] * EXTENSION_REFERENCE_FPS);
    }
  });
});

describe('buildRotationMat3', () => {
  it('returns identity at 0°', () => {
    const m = buildRotationMat3(0);
    expect(m[0]).toBeCloseTo(1);
    expect(m[1]).toBeCloseTo(0);
    expect(m[3]).toBeCloseTo(0);
    expect(m[4]).toBeCloseTo(1);
    expect(m[8]).toBe(1);
  });

  it('rotates 90° counter-clockwise (column-major)', () => {
    const m = buildRotationMat3(90);
    expect(m[0]).toBeCloseTo(0); // cos(90°)
    expect(m[1]).toBeCloseTo(1); // sin(90°)
    expect(m[3]).toBeCloseTo(-1); // -sin(90°)
    expect(m[4]).toBeCloseTo(0); // cos(90°)
  });
});
