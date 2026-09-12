/**
 * `gpu-chores` — portable frame-difference motion kernel.
 *
 * This is the reference implementation the `ts` lane runs and the WGSL
 * `MOTION_FIELD_COMPUTE_SHADER` mirrors: downsample BT.709 luminance by a
 * fixed divisor, take the absolute difference against the previous frame's
 * luminance at the same cell, and subtract a noise floor.
 *
 * Pure maths over plain arrays — nothing here imports a device, a DOM type, or
 * anything Chromashift-specific, so it is equally the headless-CI oracle and
 * the WebGL diagnostic backend's production path.
 */

/** Decoded RGBA frame, tightly packed, 4 bytes per pixel. */
export interface MotionFrame {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

/** Low-resolution luminance plane, one entry per motion-field cell, in [0,1]. */
export interface LuminancePlane {
  lum: Float32Array;
  width: number;
  height: number;
}

/**
 * Summary statistics — the *only* thing that ever crosses back to the CPU on
 * the WebGPU lane, where the field itself stays a `GPUTexture`.
 */
export interface MotionFieldStats {
  /** Mean magnitude over every cell, in [0,1]. */
  meanMagnitude: number;
  /** Fraction of cells above the noise floor, in [0,1]. */
  movingFraction: number;
  /** Number of cells the statistics were taken over. */
  cells: number;
}

export const EMPTY_MOTION_FIELD_STATS: MotionFieldStats = {
  meanMagnitude: 0,
  movingFraction: 0,
  cells: 0,
};

/** Field dimensions for a source of `width`×`height` at `divisor`. */
export function motionFieldSize(
  width: number,
  height: number,
  divisor: number,
): { width: number; height: number } {
  const d = Math.max(1, Math.floor(divisor));
  return {
    width: Math.max(1, Math.ceil(Math.max(1, Math.floor(width)) / d)),
    height: Math.max(1, Math.ceil(Math.max(1, Math.floor(height)) / d)),
  };
}

/**
 * Box-average BT.709 luminance over each `divisor`×`divisor` block.
 *
 * The averaging (rather than point sampling) is what makes the difference
 * robust to sensor grain: a single noisy pixel moves a 4×4 average by a
 * sixteenth of its own excursion.
 */
export function downsampleLuminance(frame: MotionFrame, divisor: number): LuminancePlane {
  const d = Math.max(1, Math.floor(divisor));
  const { width, height } = motionFieldSize(frame.width, frame.height, d);
  const lum = new Float32Array(width * height);

  for (let cy = 0; cy < height; cy += 1) {
    for (let cx = 0; cx < width; cx += 1) {
      let sum = 0;
      let count = 0;
      const y1 = Math.min(frame.height, cy * d + d);
      const x1 = Math.min(frame.width, cx * d + d);
      for (let y = cy * d; y < y1; y += 1) {
        let index = (y * frame.width + cx * d) * 4;
        for (let x = cx * d; x < x1; x += 1) {
          sum += (
            frame.data[index] * 0.2126
            + frame.data[index + 1] * 0.7152
            + frame.data[index + 2] * 0.0722
          ) / 255;
          count += 1;
          index += 4;
        }
      }
      lum[cy * width + cx] = count === 0 ? 0 : sum / count;
    }
  }

  return { lum, width, height };
}

/**
 * Magnitude of the frame difference, with `threshold` subtracted and the
 * remainder rescaled so a cell just above the floor starts at 0 rather than
 * jumping to the floor's value.
 *
 * `previous` of `null` (first frame, resize, source switch) yields an
 * all-zero field: a source with no history has no motion, which is also what
 * makes a still image indistinguishable from `motionMode: 'off'`.
 */
export function motionMagnitudeField(
  current: LuminancePlane,
  previous: LuminancePlane | null,
  threshold: number,
): Float32Array {
  const field = new Float32Array(current.lum.length);
  if (
    !previous
    || previous.width !== current.width
    || previous.height !== current.height
  ) {
    return field;
  }

  const floor = Math.min(Math.max(threshold, 0), 0.999);
  const scale = 1 / Math.max(1 - floor, 1e-4);
  for (let i = 0; i < field.length; i += 1) {
    const delta = Math.abs(current.lum[i] - previous.lum[i]);
    field[i] = delta > floor ? Math.min((delta - floor) * scale, 1) : 0;
  }
  return field;
}

/** Mean magnitude + moving-cell fraction over a completed field. */
export function summariseMotionField(field: Float32Array): MotionFieldStats {
  if (field.length === 0) return EMPTY_MOTION_FIELD_STATS;
  let sum = 0;
  let moving = 0;
  for (let i = 0; i < field.length; i += 1) {
    sum += field[i];
    if (field[i] > 0) moving += 1;
  }
  return {
    meanMagnitude: sum / field.length,
    movingFraction: moving / field.length,
    cells: field.length,
  };
}
