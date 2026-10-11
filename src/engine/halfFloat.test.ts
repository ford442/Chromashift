import { describe, expect, it } from 'vitest';
import { float32ToFloat16Bits, packMotionFieldRgba16 } from './halfFloat';

describe('float32ToFloat16Bits', () => {
  it.each([
    [0, 0x0000],
    [-0, 0x8000],
    [1, 0x3c00],
    [-2, 0xc000],
    [0.5, 0x3800],
    [65504, 0x7bff],
    [65520, 0x7c00],
    [Infinity, 0x7c00],
    [-Infinity, 0xfc00],
    [2 ** -24, 0x0001],
    [2 ** -14, 0x0400],
    [1e-10, 0x0000],
  ])('%s → %s', (value, bits) => {
    expect(float32ToFloat16Bits(value)).toBe(bits);
  });

  it('maps NaN to a NaN pattern', () => {
    const bits = float32ToFloat16Bits(NaN);
    expect(bits & 0x7c00).toBe(0x7c00);
    expect(bits & 0x3ff).not.toBe(0);
  });

  it('rounds to nearest even', () => {
    // 1 + 2^-11 is exactly halfway between 1 and the next half; ties to even (1).
    expect(float32ToFloat16Bits(1 + 2 ** -11)).toBe(0x3c00);
    expect(float32ToFloat16Bits(1 + 3 * 2 ** -11)).toBe(0x3c02);
  });
});

describe('packMotionFieldRgba16', () => {
  const field = new Float32Array([0.5, 1]);

  it('zeroes gb and sets a=1 without flow', () => {
    const packed = packMotionFieldRgba16({ field, width: 2, height: 1 });
    expect(Array.from(packed)).toEqual([0x3800, 0, 0, 0x3c00, 0x3c00, 0, 0, 0x3c00]);
  });

  it('interleaves flow into gb', () => {
    const flow = new Float32Array([1, -2, 0.5, 0]);
    const packed = packMotionFieldRgba16({ field, flow, width: 2, height: 1 });
    expect(Array.from(packed)).toEqual([0x3800, 0x3c00, 0xc000, 0x3c00, 0x3c00, 0x3800, 0, 0x3c00]);
  });

  it('reuses a correctly sized output buffer', () => {
    const out = new Uint16Array(8);
    expect(packMotionFieldRgba16({ field, width: 2, height: 1 }, out)).toBe(out);
  });
});
