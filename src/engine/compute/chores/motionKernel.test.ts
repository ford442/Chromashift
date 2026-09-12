import { describe, expect, it } from 'vitest';
import {
  downsampleLuminance,
  motionFieldSize,
  motionMagnitudeField,
  summariseMotionField,
  type MotionFrame,
} from './motionKernel';

/** Solid-grey RGBA frame at `level` (0-255). */
function solidFrame(width: number, height: number, level: number): MotionFrame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = level;
    data[i * 4 + 1] = level;
    data[i * 4 + 2] = level;
    data[i * 4 + 3] = 255;
  }
  return { data, width, height };
}

/** Grey frame with one `level`-valued block at cell (cx, cy) of a `divisor` grid. */
function frameWithBlock(
  width: number,
  height: number,
  base: number,
  divisor: number,
  cx: number,
  cy: number,
  level: number,
): MotionFrame {
  const frame = solidFrame(width, height, base);
  for (let y = cy * divisor; y < Math.min(height, cy * divisor + divisor); y += 1) {
    for (let x = cx * divisor; x < Math.min(width, cx * divisor + divisor); x += 1) {
      const i = (y * width + x) * 4;
      frame.data[i] = level;
      frame.data[i + 1] = level;
      frame.data[i + 2] = level;
    }
  }
  return frame;
}

describe('motionFieldSize', () => {
  it('rounds up so a partial trailing block still gets a cell', () => {
    expect(motionFieldSize(1920, 1080, 4)).toEqual({ width: 480, height: 270 });
    expect(motionFieldSize(10, 6, 4)).toEqual({ width: 3, height: 2 });
  });

  it('never returns a zero-sized field', () => {
    expect(motionFieldSize(0, 0, 4)).toEqual({ width: 1, height: 1 });
    expect(motionFieldSize(3, 3, 0)).toEqual({ width: 3, height: 3 });
  });
});

describe('downsampleLuminance', () => {
  it('box-averages BT.709 luminance over each block', () => {
    const plane = downsampleLuminance(solidFrame(8, 8, 255), 4);
    expect(plane.width).toBe(2);
    expect(plane.height).toBe(2);
    for (const value of plane.lum) expect(value).toBeCloseTo(1, 5);
  });

  it('averages a half-lit block rather than point sampling it', () => {
    // Left half of the single 4x4 block is white, right half black.
    const frame = solidFrame(4, 4, 0);
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 2; x += 1) {
        const i = (y * 4 + x) * 4;
        frame.data[i] = 255;
        frame.data[i + 1] = 255;
        frame.data[i + 2] = 255;
      }
    }
    const plane = downsampleLuminance(frame, 4);
    expect(plane.lum[0]).toBeCloseTo(0.5, 3);
  });

  it('clips the trailing partial block to the frame', () => {
    const plane = downsampleLuminance(solidFrame(6, 6, 128), 4);
    expect(plane.width).toBe(2);
    // The trailing 2x2 remainder is still fully covered by the source.
    for (const value of plane.lum) expect(value).toBeCloseTo(128 / 255, 5);
  });
});

describe('motionMagnitudeField', () => {
  const divisor = 4;

  it('reports zero everywhere with no previous frame', () => {
    const current = downsampleLuminance(solidFrame(8, 8, 128), divisor);
    const field = motionMagnitudeField(current, null, 0.04);
    expect([...field]).toEqual([0, 0, 0, 0]);
  });

  it('reports zero for two identical frames (a still source)', () => {
    const a = downsampleLuminance(solidFrame(8, 8, 128), divisor);
    const b = downsampleLuminance(solidFrame(8, 8, 128), divisor);
    expect(summariseMotionField(motionMagnitudeField(b, a, 0.04)).meanMagnitude).toBe(0);
  });

  it('lights up only the cell that changed', () => {
    const previous = downsampleLuminance(solidFrame(8, 8, 0), divisor);
    const current = downsampleLuminance(frameWithBlock(8, 8, 0, divisor, 1, 0, 255), divisor);
    const field = motionMagnitudeField(current, previous, 0.04);
    expect(field[0]).toBe(0);
    expect(field[1]).toBeGreaterThan(0.9);
    expect(field[2]).toBe(0);
    expect(field[3]).toBe(0);
  });

  it('subtracts the noise floor and rescales the remainder', () => {
    const previous = downsampleLuminance(solidFrame(4, 4, 0), divisor);
    const current = downsampleLuminance(solidFrame(4, 4, 51), divisor); // delta = 0.2
    // Just under the floor: nothing at all.
    expect(motionMagnitudeField(current, previous, 0.25)[0]).toBe(0);
    // Just over it: a small value, not a jump to the raw delta.
    const gated = motionMagnitudeField(current, previous, 0.1)[0];
    expect(gated).toBeGreaterThan(0);
    expect(gated).toBeCloseTo((0.2 - 0.1) / 0.9, 5);
  });

  it('drops the history when the field geometry changes', () => {
    const previous = downsampleLuminance(solidFrame(8, 8, 0), divisor);
    const current = downsampleLuminance(solidFrame(16, 16, 255), divisor);
    const field = motionMagnitudeField(current, previous, 0.04);
    expect(field.length).toBe(16);
    expect(summariseMotionField(field).meanMagnitude).toBe(0);
  });
});

describe('summariseMotionField', () => {
  it('reports the mean magnitude and the moving-cell fraction', () => {
    const stats = summariseMotionField(new Float32Array([0, 0, 0.5, 1]));
    expect(stats.meanMagnitude).toBeCloseTo(0.375, 5);
    expect(stats.movingFraction).toBeCloseTo(0.5, 5);
    expect(stats.cells).toBe(4);
  });

  it('is all zeroes for an empty field', () => {
    expect(summariseMotionField(new Float32Array(0))).toEqual({
      meanMagnitude: 0,
      movingFraction: 0,
      cells: 0,
    });
  });
});
