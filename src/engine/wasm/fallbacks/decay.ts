/**
 * Pure TypeScript decay / angle-stepping fallbacks — used when the WASM
 * engine is unavailable or `useWasm` is false. Mirror `advanceLayerAngles`
 * and `simulateTracerDecay` in `cpp/chromashift_engine.cpp`.
 *
 * `durationToDecay` itself already lives in `../../math/decay.ts` (single
 * source of truth for the tracer-persistence formula) — re-exported here so
 * dispatch.ts has one fallback import surface.
 */

export { durationToDecay } from '../../math/decay';

export function tsAdvanceAngles(
  angles: [number, number, number],
  steps: [number, number, number],
): [number, number, number] {
  // ((a + s) % 360 + 360) % 360 handles negative steps.
  return [
    ((angles[0] + steps[0]) % 360 + 360) % 360,
    ((angles[1] + steps[1]) % 360 + 360) % 360,
    ((angles[2] + steps[2]) % 360 + 360) % 360,
  ];
}

export function tsSimulateTracerDecay(buffer: Float32Array, decayFactor: number): void {
  const pixelCount = Math.floor(buffer.length / 4);
  for (let i = 0; i < pixelCount * 4; i++) {
    buffer[i] *= decayFactor;
  }
}
