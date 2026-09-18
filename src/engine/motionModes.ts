/**
 * Tracer motion modes — the temporal term the persistence pass applies on top
 * of its spatial coincidence test.
 *
 * The persistence pass is otherwise purely spatial and instantaneous: it counts
 * overlapping layers at one UV and decays whatever it already had. Feeding it a
 * motion field (see `engine/compute/chores` — the `motion-field` chore) lets a
 * live source's *change between frames* steer the stamp and the local decay
 * rate, which is what reads as a comet tail rather than a global fade.
 *
 * `off` is the default and must stay behaviourally identical to the pre-motion
 * pipeline on both backends — the renderers emit the original shader variant
 * for it and never bind a motion texture (see `docs/LIVE_SOURCE.md`).
 */

export const MOTION_MODES = ['off', 'boost', 'gate', 'direction'] as const;

export type MotionMode = (typeof MOTION_MODES)[number];

export const DEFAULT_MOTION_MODE: MotionMode = 'off';

/** Shader-side encoding of {@link MotionMode}; index into {@link MOTION_MODES}. */
export function motionModeIndex(mode: MotionMode): number {
  const index = MOTION_MODES.indexOf(mode);
  return index < 0 ? 0 : index;
}

/**
 * Shader-side index of `direction` — the one mode that reads the flow vector,
 * and so the one mode that pays for the Lucas–Kanade pass. Named rather than
 * spelled `3` at each call site so the renderers and the shaders cannot drift.
 */
export const MOTION_MODE_DIRECTION = MOTION_MODES.indexOf('direction');

/** Narrow an untrusted value (preset document, URL param) to a known mode. */
export function parseMotionMode(value: unknown): MotionMode {
  return typeof value === 'string' && (MOTION_MODES as readonly string[]).includes(value)
    ? (value as MotionMode)
    : DEFAULT_MOTION_MODE;
}

/**
 * Resolution divisor for the motion field. A quarter-resolution frame
 * difference is ~1/16 of a full-res pass and is enough to steer a tracer:
 * the field is sampled bilinearly by the persistence pass, so the extra
 * detail a full-res field would carry is thrown away immediately.
 */
export const MOTION_FIELD_DIVISOR = 4;

/** Defaults for the tracer motion parameters (mirrored in `state/defaults.ts`). */
export const DEFAULT_MOTION_GAIN = 1;
export const DEFAULT_MOTION_DECAY_BIAS = 0.5;
export const DEFAULT_MOTION_THRESHOLD = 0.04;
