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

// ── Stage 2: optical flow ────────────────────────────────────────────────────
//
// Everything below produces the *direction* half of the field. The magnitude
// kernel above is untouched and remains what `motionMode: boost | gate` reads,
// so turning flow on can never move a `boost`/`gate` pixel.
//
// The algorithm is coarse-to-fine **Lucas–Kanade** over the same low-resolution
// luminance planes the frame difference already builds. It was chosen over
// block matching because it is a fixed, branch-free arithmetic sequence: the
// WGSL pass and the C++ SIMD128 kernel can issue the *same* operations in the
// *same* order, which is what makes the three-lane agreement in
// `motionKernel.test.ts` a real check rather than a tolerance fudge.

/**
 * Half-width of the LK window, in cells. `1` is a 3×3 window — nine taps is
 * enough structure to solve a 2×2 system at quarter resolution, and it keeps
 * the per-cell tap count low enough for the fine level to stay one dispatch.
 */
export const LK_WINDOW_RADIUS = 1;

/**
 * Pyramid levels, coarsest included. `2` means one half-resolution pass whose
 * result seeds a full field-resolution refinement — enough to track roughly
 * `2 × LK_MAX_STEP` cells per frame, which at the default divisor is ~16 source
 * pixels, or a hand crossing a 1080p webcam frame in about a second.
 */
export const LK_PYRAMID_LEVELS = 2;

/**
 * Tikhonov ridge added to the structure tensor's diagonal, relative to the
 * window's gradient energy.
 *
 * Without it a straight edge gives a singular system (the aperture problem) and
 * the solve has to be branched around. With it the system is always positive
 * definite — `det >= ridge * (Ixx + Iyy) + ridge²` — and an edge falls back to
 * *normal flow*, the component along the gradient, which is the component a hue
 * can honestly show anyway.
 */
export const LK_REGULARIZATION = 0.05;

/** Absolute floor on the ridge, so a perfectly flat window still divides. */
export const LK_EPSILON = 1e-6;

/** Clamp on one level's solved increment, in cells per frame. */
export const LK_MAX_STEP = 2;

/** Clamp on the accumulated flow, in cells per frame. */
export const LK_MAX_FLOW = 4;

/**
 * Flow shorter than this reads as "no direction known".
 *
 * The persistence shaders hold today's magnitude tint below it, so a preset
 * saved against the Stage 1 zero vector renders exactly as it did: `direction`
 * only starts steering once the solve actually has a direction to report.
 */
export const MOTION_FLOW_MIN_SPEED = 0.05;

/** Per-cell flow vectors, `2 × width × height`, interleaved `vx, vy`. */
export interface MotionFlowField {
  /** Cells per frame, `+x` right and `+y` down — the field's own axes. */
  flow: Float32Array;
  width: number;
  height: number;
}

function clampf(value: number, low: number, high: number): number {
  return value < low ? low : (value > high ? high : value);
}

/**
 * Box-average a luminance plane down by two, clipping a trailing odd row or
 * column exactly the way {@link downsampleLuminance} clips a partial block.
 */
export function halveLuminancePlane(plane: LuminancePlane): LuminancePlane {
  const width = Math.max(1, Math.ceil(plane.width / 2));
  const height = Math.max(1, Math.ceil(plane.height / 2));
  const lum = new Float32Array(width * height);
  for (let cy = 0; cy < height; cy += 1) {
    for (let cx = 0; cx < width; cx += 1) {
      let sum = 0;
      let count = 0;
      const y1 = Math.min(plane.height, cy * 2 + 2);
      const x1 = Math.min(plane.width, cx * 2 + 2);
      for (let y = cy * 2; y < y1; y += 1) {
        for (let x = cx * 2; x < x1; x += 1) {
          sum += plane.lum[y * plane.width + x];
          count += 1;
        }
      }
      lum[cy * width + cx] = count === 0 ? 0 : sum / count;
    }
  }
  return { lum, width, height };
}

/** Clamped nearest fetch — the plane is treated as extending by its border. */
export function planeAt(plane: LuminancePlane, x: number, y: number): number {
  const cx = x < 0 ? 0 : (x > plane.width - 1 ? plane.width - 1 : x);
  const cy = y < 0 ? 0 : (y > plane.height - 1 ? plane.height - 1 : y);
  return plane.lum[cy * plane.width + cx];
}

/**
 * Clamped bilinear fetch, written as two lerps along x followed by one along y.
 *
 * The operation order matters: the WGSL and C++ mirrors repeat it verbatim so
 * the three lanes round identically, which is what the parity fixture asserts.
 * At integer coordinates it reduces exactly to {@link planeAt} — no epsilon —
 * which is why the coarse level, whose guess is always zero, can skip it.
 */
export function samplePlaneBilinear(plane: LuminancePlane, x: number, y: number): number {
  const fx = clampf(x, 0, plane.width - 1);
  const fy = clampf(y, 0, plane.height - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, plane.width - 1);
  const y1 = Math.min(y0 + 1, plane.height - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const row0 = plane.lum[y0 * plane.width + x0]
    + (plane.lum[y0 * plane.width + x1] - plane.lum[y0 * plane.width + x0]) * tx;
  const row1 = plane.lum[y1 * plane.width + x0]
    + (plane.lum[y1 * plane.width + x1] - plane.lum[y1 * plane.width + x0]) * tx;
  return row0 + (row1 - row0) * ty;
}

/**
 * One regularised Lucas–Kanade solve at `(cx, cy)`, given a displacement guess.
 *
 * Returns the *increment* on that guess, each component clamped to
 * {@link LK_MAX_STEP}. Spatial gradients are central differences on the current
 * plane; the temporal term differences the current plane against the previous
 * one sampled at `(x, y) - guess`, so a correct guess drives `It` to zero and
 * the increment with it.
 */
export function lucasKanadeStep(
  current: LuminancePlane,
  previous: LuminancePlane,
  cx: number,
  cy: number,
  guessX: number,
  guessY: number,
): { dx: number; dy: number } {
  let ixx = 0;
  let ixy = 0;
  let iyy = 0;
  let ixt = 0;
  let iyt = 0;

  for (let dy = -LK_WINDOW_RADIUS; dy <= LK_WINDOW_RADIUS; dy += 1) {
    for (let dx = -LK_WINDOW_RADIUS; dx <= LK_WINDOW_RADIUS; dx += 1) {
      const x = cx + dx;
      const y = cy + dy;
      const ix = 0.5 * (planeAt(current, x + 1, y) - planeAt(current, x - 1, y));
      const iy = 0.5 * (planeAt(current, x, y + 1) - planeAt(current, x, y - 1));
      const it = planeAt(current, x, y) - samplePlaneBilinear(previous, x - guessX, y - guessY);
      ixx += ix * ix;
      ixy += ix * iy;
      iyy += iy * iy;
      ixt += ix * it;
      iyt += iy * it;
    }
  }

  // Positive definite by construction, so there is no singular branch to take
  // and every lane runs the same instruction stream.
  const ridge = LK_REGULARIZATION * (ixx + iyy) + LK_EPSILON;
  const a = ixx + ridge;
  const d = iyy + ridge;
  const det = a * d - ixy * ixy;
  return {
    dx: clampf((-d * ixt + ixy * iyt) / det, -LK_MAX_STEP, LK_MAX_STEP),
    dy: clampf((ixy * ixt - a * iyt) / det, -LK_MAX_STEP, LK_MAX_STEP),
  };
}

/**
 * Coarse-to-fine Lucas–Kanade flow for one frame pair.
 *
 * `previous` of `null`, or a geometry change, yields an all-zero field for the
 * same reason {@link motionMagnitudeField} does: a source with no history has
 * no motion, and a resized one has no comparable history.
 */
export function lucasKanadeFlow(
  current: LuminancePlane,
  previous: LuminancePlane | null,
  levels: number = LK_PYRAMID_LEVELS,
): MotionFlowField {
  const empty: MotionFlowField = {
    flow: new Float32Array(current.lum.length * 2),
    width: current.width,
    height: current.height,
  };
  if (
    !previous
    || previous.width !== current.width
    || previous.height !== current.height
  ) {
    return empty;
  }

  const currentPyramid: LuminancePlane[] = [current];
  const previousPyramid: LuminancePlane[] = [previous];
  for (let level = 1; level < Math.max(1, levels); level += 1) {
    currentPyramid.push(halveLuminancePlane(currentPyramid[level - 1]));
    previousPyramid.push(halveLuminancePlane(previousPyramid[level - 1]));
  }

  let coarse: MotionFlowField | null = null;
  for (let level = currentPyramid.length - 1; level >= 0; level -= 1) {
    const cur = currentPyramid[level];
    const prev = previousPyramid[level];
    const flow = new Float32Array(cur.width * cur.height * 2);
    for (let cy = 0; cy < cur.height; cy += 1) {
      for (let cx = 0; cx < cur.width; cx += 1) {
        let guessX = 0;
        let guessY = 0;
        if (coarse) {
          // Nearest-neighbour upsample, doubled: a level-1 cell spans two
          // level-0 cells, so its displacement is worth twice as much here.
          const sx = Math.min(cx >> 1, coarse.width - 1);
          const sy = Math.min(cy >> 1, coarse.height - 1);
          guessX = 2 * coarse.flow[(sy * coarse.width + sx) * 2];
          guessY = 2 * coarse.flow[(sy * coarse.width + sx) * 2 + 1];
        }
        const step = lucasKanadeStep(cur, prev, cx, cy, guessX, guessY);
        const index = (cy * cur.width + cx) * 2;
        flow[index] = clampf(guessX + step.dx, -LK_MAX_FLOW, LK_MAX_FLOW);
        flow[index + 1] = clampf(guessY + step.dy, -LK_MAX_FLOW, LK_MAX_FLOW);
      }
    }
    coarse = { flow, width: cur.width, height: cur.height };
  }

  return coarse ?? empty;
}

/** Summary of a completed flow field — the only part that reaches automation. */
export interface MotionFlowStats {
  /** Mean `vx` over cells that are actually moving, in cells per frame. */
  meanVx: number;
  /** Mean `vy` over the same cells. */
  meanVy: number;
  /** Mean speed over the same cells. */
  meanSpeed: number;
  /** How many cells cleared {@link MOTION_FLOW_MIN_SPEED}. */
  movingCells: number;
}

export const EMPTY_MOTION_FLOW_STATS: MotionFlowStats = {
  meanVx: 0,
  meanVy: 0,
  meanSpeed: 0,
  movingCells: 0,
};

/**
 * Mean velocity over the cells that cleared the minimum speed.
 *
 * Averaged over moving cells rather than every cell because a live frame is
 * mostly background: including the still majority would drag any real direction
 * towards zero and make "is there a direction at all?" unanswerable, which is
 * precisely the question this exists to answer for E2E.
 */
export function summariseMotionFlow(flow: Float32Array | null): MotionFlowStats {
  if (!flow || flow.length === 0) return EMPTY_MOTION_FLOW_STATS;
  let sumX = 0;
  let sumY = 0;
  let sumSpeed = 0;
  let moving = 0;
  for (let i = 0; i < flow.length; i += 2) {
    const vx = flow[i];
    const vy = flow[i + 1];
    const speed = Math.sqrt(vx * vx + vy * vy);
    if (speed <= MOTION_FLOW_MIN_SPEED) continue;
    sumX += vx;
    sumY += vy;
    sumSpeed += speed;
    moving += 1;
  }
  if (moving === 0) return EMPTY_MOTION_FLOW_STATS;
  return {
    meanVx: sumX / moving,
    meanVy: sumY / moving,
    meanSpeed: sumSpeed / moving,
    movingCells: moving,
  };
}
