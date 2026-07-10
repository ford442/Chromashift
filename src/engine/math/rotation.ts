import type { LayerState } from '../types/RendererState';

export function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Normalize any degree value into [0, 360). */
export function wrapAngleDeg(angle: number): number {
  const wrapped = angle % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
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
