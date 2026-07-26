import { describe, expect, it } from 'vitest';
import {
  EXTENSION_REFERENCE_FPS,
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
