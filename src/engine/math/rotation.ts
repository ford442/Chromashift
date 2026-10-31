import type { LayerState } from '../types/RendererState';

/**
 * Reference FPS at which `layers.extensions` historically meant degrees per frame.
 * Spin is now FPS-independent: wall-clock °/s = extension × EXTENSION_REFERENCE_FPS,
 * so changing FPS only changes temporal sampling, not angular speed.
 */
export const EXTENSION_REFERENCE_FPS = 30;

function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * Normalize any degree value into [0, 360).
 *
 * The second `% 360` is load-bearing: `-360 % 360` is `-0`, and a negative
 * remainder smaller than a float's resolution at 360 (`-1e-20 + 360`) rounds up
 * to 360 itself.
 */
export function wrapAngleDeg(angle: number): number {
  return ((angle % 360) + 360) % 360;
}

/**
 * Convert stored extension steps into per-frame degree deltas at `fps`.
 * At {@link EXTENSION_REFERENCE_FPS}, the returned deltas equal the stored steps.
 */
export function extensionStepsForFps(
  extensions: readonly number[],
  fps: number,
): number[] {
  const scale = EXTENSION_REFERENCE_FPS / Math.max(1e-6, fps);
  return extensions.map((extension) => extension * scale);
}

/**
 * Advance an animation angle clock by per-layer extension steps (mod 360).
 * When `fps` is supplied, steps are scaled so wall-clock °/s stays constant
 * (see {@link extensionStepsForFps}); omit `fps` only for raw delta tests.
 *
 * The one angle clock: the live loop (`useAnimationLoop`) and video export
 * (`exportVideoFrameLoop`) both call this, so they cannot disagree. It is
 * TypeScript on purpose — there are at most ten angles, and a `_malloc`, two
 * heap copies and a `_free` cost more than the loop (docs/wasm-engine.md,
 * "Where code runs").
 *
 * `extensions` is the authority on the layer count — the clock in `prev` may be
 * a frame behind a count change (a preset load, the layer-count control), and a
 * layer it does not cover starts from zero rather than `NaN`. Angles past the
 * end of `extensions` are dropped.
 */
export function advanceAngles(
  prev: readonly number[],
  extensions: readonly number[],
  fps?: number,
): number[] {
  const steps = fps === undefined ? extensions : extensionStepsForFps(extensions, fps);
  return steps.map((step, i) => wrapAngleDeg((prev[i] ?? 0) + step));
}

/**
 * 2D rotation matrix (column-major 3×3) for layer angle in degrees.
 * Shader passes use rad/flip/aspect uniforms; this is available for tests and tooling.
 */
export function buildRotationMat3(angleDeg: number): Float32Array {
  const rad = degreesToRadians(angleDeg);
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return new Float32Array([
    c, s, 0,
    -s, c, 0,
    0, 0, 1,
  ]);
}

/** Shared WebGPU / WebGL layer rotation uniform tuple. */
export function layerRotationUniforms(
  layer: LayerState,
  aspect: number,
): readonly [rad: number, flipX: number, flipY: number, aspect: number] {
  return [
    degreesToRadians(layer.angleDeg),
    layer.flipX ? 1.0 : 0.0,
    layer.flipY ? 1.0 : 0.0,
    aspect,
  ];
}
