import { describe, expect, it } from 'vitest';
import {
  LK_MAX_FLOW,
  downsampleLuminance,
  halveLuminancePlane,
  lucasKanadeFlow,
  motionFieldSize,
  motionMagnitudeField,
  planeAt,
  samplePlaneBilinear,
  summariseMotionField,
  type LuminancePlane,
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

// ── Stage 2: optical flow ────────────────────────────────────────────────────

/**
 * The pinned fixture: a separable triangular ridge — a soft "bar" with real
 * gradient structure in *both* axes, so the 2×2 system is well conditioned and
 * the solve recovers the actual displacement rather than normal flow.
 *
 * Every constant is exactly representable in binary floating point (the slope
 * is 0.25, not 1/3), which is what lets `cpp/tests/test_engine.cpp` and
 * `public/wasm-benchmark-core.mjs` build a bit-identical fixture and compare
 * against the same numbers.
 */
const FIXTURE_SIZE = 16;

function ridge(value: number, centre: number): number {
  return Math.max(0, 1 - Math.abs(value - centre) * 0.25);
}

function ridgePlane(centreX: number, centreY: number): LuminancePlane {
  const lum = new Float32Array(FIXTURE_SIZE * FIXTURE_SIZE);
  for (let y = 0; y < FIXTURE_SIZE; y += 1) {
    for (let x = 0; x < FIXTURE_SIZE; x += 1) {
      lum[y * FIXTURE_SIZE + x] = ridge(x, centreX) * ridge(y, centreY);
    }
  }
  return { lum, width: FIXTURE_SIZE, height: FIXTURE_SIZE };
}

function flowAt(field: { flow: Float32Array; width: number }, x: number, y: number) {
  const i = (y * field.width + x) * 2;
  return { vx: field.flow[i], vy: field.flow[i + 1] };
}

describe('halveLuminancePlane', () => {
  it('box-averages each 2x2 block', () => {
    const plane: LuminancePlane = {
      lum: new Float32Array([0, 1, 0.5, 0.5, 1, 0, 0.5, 0.5]),
      width: 4,
      height: 2,
    };
    const half = halveLuminancePlane(plane);
    expect(half.width).toBe(2);
    expect(half.height).toBe(1);
    expect(half.lum[0]).toBeCloseTo(0.5, 6);
    expect(half.lum[1]).toBeCloseTo(0.5, 6);
  });

  it('clips a trailing odd row or column rather than padding it', () => {
    const plane: LuminancePlane = { lum: new Float32Array([1, 1, 1]), width: 3, height: 1 };
    const half = halveLuminancePlane(plane);
    expect(half.width).toBe(2);
    // The trailing cell averages one source value, not two.
    expect(half.lum[1]).toBeCloseTo(1, 6);
  });
});

describe('samplePlaneBilinear', () => {
  const plane: LuminancePlane = { lum: new Float32Array([0, 1, 2, 3]), width: 2, height: 2 };

  it('reduces to the clamped nearest fetch at integer coordinates', () => {
    // This exactness is why the coarse LK level, whose guess is always zero,
    // can skip the bilinear path entirely and still agree with the reference.
    for (let y = 0; y < 2; y += 1) {
      for (let x = 0; x < 2; x += 1) {
        expect(samplePlaneBilinear(plane, x, y)).toBe(planeAt(plane, x, y));
      }
    }
  });

  it('interpolates between the four neighbours', () => {
    expect(samplePlaneBilinear(plane, 0.5, 0)).toBeCloseTo(0.5, 6);
    expect(samplePlaneBilinear(plane, 0, 0.5)).toBeCloseTo(1, 6);
    expect(samplePlaneBilinear(plane, 0.5, 0.5)).toBeCloseTo(1.5, 6);
  });

  it('clamps rather than wrapping outside the plane', () => {
    expect(samplePlaneBilinear(plane, -5, -5)).toBe(0);
    expect(samplePlaneBilinear(plane, 99, 99)).toBe(3);
  });
});

describe('lucasKanadeFlow', () => {
  it('reports zero everywhere with no previous frame', () => {
    const field = lucasKanadeFlow(ridgePlane(8, 8), null);
    expect(field.flow.every((v) => v === 0)).toBe(true);
  });

  it('reports zero for two identical planes (a still source)', () => {
    const field = lucasKanadeFlow(ridgePlane(8, 8), ridgePlane(8, 8));
    expect(field.flow.every((v) => v === 0)).toBe(true);
  });

  it('drops the history when the plane geometry changes', () => {
    const previous: LuminancePlane = { lum: new Float32Array(4), width: 2, height: 2 };
    const field = lucasKanadeFlow(ridgePlane(8, 8), previous);
    expect(field.width).toBe(FIXTURE_SIZE);
    expect(field.flow.every((v) => v === 0)).toBe(true);
  });

  it('recovers the sign of a bar translating down and to the right', () => {
    // The ridge moves +2 cells in x and +1 in y between the two frames.
    const field = lucasKanadeFlow(ridgePlane(8, 7), ridgePlane(6, 6));
    for (const [x, y] of [[7, 7], [8, 7], [9, 7], [8, 6], [8, 8], [6, 6], [10, 9]]) {
      const { vx, vy } = flowAt(field, x, y);
      expect(vx).toBeGreaterThan(0);
      expect(vy).toBeGreaterThan(0);
    }
  });

  it('flips the sign when the two frames are swapped', () => {
    const forward = lucasKanadeFlow(ridgePlane(8, 7), ridgePlane(6, 6));
    const backward = lucasKanadeFlow(ridgePlane(6, 6), ridgePlane(8, 7));
    expect(flowAt(forward, 8, 7).vx).toBeGreaterThan(0);
    expect(flowAt(backward, 8, 7).vx).toBeLessThan(0);
  });

  it('matches the golden vectors the C++ and WASM lanes are pinned against', () => {
    // Changing these means changing `cpp/tests/test_engine.cpp` and
    // `FLOW_FIXTURE_GOLDEN` in `public/wasm-benchmark-core.mjs` with them —
    // three lanes, one fixture, one set of numbers.
    const golden = new Float32Array([
      1.951104, 0.978733, // (7, 7)
      1.949691, 0.954138, // (8, 7)
      2.044808, 0.928220, // (9, 7)
      1.965647, 0.850176, // (8, 6)
      1.944985, 1.144081, // (8, 8)
      1.947979, 1.010215, // (6, 6)
      1.941304, 0.998794, // (10, 9)
    ]);
    const cells = [[7, 7], [8, 7], [9, 7], [8, 6], [8, 8], [6, 6], [10, 9]];
    const field = lucasKanadeFlow(ridgePlane(8, 7), ridgePlane(6, 6));
    cells.forEach(([x, y], index) => {
      const { vx, vy } = flowAt(field, x, y);
      expect(vx).toBeCloseTo(golden[index * 2], 5);
      expect(vy).toBeCloseTo(golden[index * 2 + 1], 5);
    });
  });

  it('recovers roughly the true displacement on a well-conditioned cell', () => {
    const field = lucasKanadeFlow(ridgePlane(8, 7), ridgePlane(6, 6));
    const { vx, vy } = flowAt(field, 8, 7);
    expect(vx).toBeCloseTo(2, 0);
    expect(vy).toBeCloseTo(1, 0);
  });

  it('never exceeds the flow clamp, even on a degenerate plane', () => {
    // Pure noise: no structure to lock onto, so the ridge term decides the
    // answer. The clamp is what keeps that from painting a hue at full speed.
    const noise = (seed: number): LuminancePlane => {
      const lum = new Float32Array(FIXTURE_SIZE * FIXTURE_SIZE);
      let s = seed;
      for (let i = 0; i < lum.length; i += 1) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        lum[i] = (s % 1000) / 1000;
      }
      return { lum, width: FIXTURE_SIZE, height: FIXTURE_SIZE };
    };
    const field = lucasKanadeFlow(noise(1), noise(2));
    for (const value of field.flow) {
      expect(Math.abs(value)).toBeLessThanOrEqual(LK_MAX_FLOW);
    }
  });

  it('solves over planes the frame downsample actually produces', () => {
    // End to end from RGBA bytes: a bar moving right by one whole field cell.
    const bar = (x0: number): MotionFrame => {
      const frame = solidFrame(64, 64, 0);
      for (let y = 16; y < 48; y += 1) {
        for (let x = x0; x < x0 + 16; x += 1) {
          const i = (y * 64 + x) * 4;
          frame.data[i] = 255;
          frame.data[i + 1] = 255;
          frame.data[i + 2] = 255;
        }
      }
      return frame;
    };
    const previous = downsampleLuminance(bar(16), 4);
    const current = downsampleLuminance(bar(20), 4);
    const field = lucasKanadeFlow(current, previous);
    expect(field.width).toBe(16);
    // On the bar's leading edge the motion is to the right and purely so.
    const { vx, vy } = flowAt(field, 9, 8);
    expect(vx).toBeGreaterThan(0.5);
    expect(Math.abs(vy)).toBeLessThan(0.5);
  });
});
