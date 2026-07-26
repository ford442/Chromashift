import type { LayerState } from '../types/RendererState';
import type { LayerTriple } from '../../state/types';

/**
 * Reference FPS at which `layers.extensions` historically meant degrees per frame.
 * Spin is now FPS-independent: wall-clock °/s = extension × EXTENSION_REFERENCE_FPS,
 * so changing FPS only changes temporal sampling, not angular speed.
 */
export const EXTENSION_REFERENCE_FPS = 30;

export function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Normalize any degree value into [0, 360). */
export function wrapAngleDeg(angle: number): number {
  const wrapped = angle % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/**
 * Convert stored extension steps into per-frame degree deltas at `fps`.
 * At {@link EXTENSION_REFERENCE_FPS}, the returned deltas equal the stored steps.
 */
export function extensionStepsForFps(
  extensions: readonly [number, number, number],
  fps: number,
): LayerTriple<number> {
  const scale = EXTENSION_REFERENCE_FPS / Math.max(1e-6, fps);
  return [
    extensions[0] * scale,
    extensions[1] * scale,
    extensions[2] * scale,
  ];
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
