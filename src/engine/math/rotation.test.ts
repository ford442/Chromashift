import { describe, expect, it } from 'vitest';
import {
  buildRotationMat3,
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
