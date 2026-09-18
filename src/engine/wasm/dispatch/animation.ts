/**
 * Frame-timing / tracer `*With()` dispatchers. See docs/wasm-engine.md for
 * the call-site matrix — all of these are load-time, export-only, or
 * test/benchmark-only. None run on the per-frame render path; persistence
 * calls `durationToDecay()` from `math/decay.ts` directly.
 */

import { buildRotationMat3 } from '../../math/rotation';
import { canUseWasmFn, getWasmModule } from '../loadEngine';
import { durationToDecay, tsAdvanceAngles, tsSimulateTracerDecay } from '../fallbacks/decay';

/**
 * Compute the tracer persistence decay multiplier via the WASM/TS dispatcher.
 *
 * Solves `decay ^ (fps × durationMs / 1000) = 0.1` so that the tracer
 * reaches 10% of its original brightness after `durationMs` milliseconds.
 * Matches `durationToDecay()` in `math/decay.ts`. Kept for WASM/TS parity
 * testing and the benchmark page — the render hot path calls
 * `durationToDecay()` directly and never routes through WASM.
 *
 * @param durationMs  Desired tracer lifetime in milliseconds.
 * @param fps         Current frame rate.
 * @param useWasm     Attempt to use the C++ WASM engine.
 * @returns           Per-frame multiplier in [0, 1).
 */
export function durationToDecayWith(
  durationMs: number,
  fps: number,
  useWasm: boolean,
): number {
  if (canUseWasmFn('_durationToDecay', useWasm)) {
    return getWasmModule()!._durationToDecay(durationMs, fps);
  }

  return durationToDecay(durationMs, fps);
}

/**
 * Advance a session's layer rotation angles by per-frame step sizes,
 * keeping all results in [0, 360).
 *
 * `angles.length` is the layer count — the C ABI takes a pointer and a count
 * rather than a fixed argument list, so 1 layer and 10 go through one symbol.
 *
 * Callers that own FPS-independent rates should scale with
 * `extensionStepsForFps()` before passing steps here (live loop + video export).
 *
 * The WASM branch is gated on `_advanceLayerAngles3` as well as
 * `_advanceLayerAngles`: a `.wasm` built before the ABI change exports the
 * latter with the old six-float signature, and calling that with heap pointers
 * would read them as angles. The deprecated three-wide wrapper exists only in
 * modules built against the current header, so its absence means "fall back to
 * TypeScript" rather than "produce garbage". Drop this gate when the wrapper goes.
 *
 * @param angles   Current angles in degrees, one per layer.
 * @param steps    Per-frame step sizes in degrees, one per layer.
 * @param useWasm  Attempt to use the C++ WASM engine.
 * @returns        New angles in degrees, each in [0, 360).
 */
export function advanceAnglesBy(
  angles: readonly number[],
  steps: readonly number[],
  useWasm: boolean,
): number[] {
  const count = angles.length;
  if (count > 0
    && canUseWasmFn('_advanceLayerAngles', useWasm)
    && canUseWasmFn('_advanceLayerAngles3', useWasm)) {
    const mod = getWasmModule()!;
    // One allocation for angles, steps and the result, in that order.
    const bytes = count * 4;
    const basePtr = mod._malloc(bytes * 3);
    const base = basePtr >> 2;
    mod.HEAPF32.set(angles, base);
    mod.HEAPF32.set(steps, base + count);

    mod._advanceLayerAngles(basePtr, basePtr + bytes, basePtr + bytes * 2, count);

    const result = Array.from(
      mod.HEAPF32.subarray(base + count * 2, base + count * 3),
    );
    mod._free(basePtr);
    return result;
  }

  return tsAdvanceAngles(angles, steps);
}

/**
 * Build a column-major 3×3 rotation matrix for a layer angle in degrees.
 * Matches `buildRotationMat3()` in src/engine/math/rotation.ts.
 */
export function buildRotationMat3With(
  angleDeg: number,
  useWasm: boolean,
): Float32Array {
  if (canUseWasmFn('_buildRotationMat3', useWasm)) {
    const mod = getWasmModule()!;
    const outPtr = mod._malloc(9 * 4);
    mod._buildRotationMat3(angleDeg, outPtr);
    const result = new Float32Array(9);
    result.set(mod.HEAPF32.subarray(outPtr >> 2, (outPtr >> 2) + 9));
    mod._free(outPtr);
    return result;
  }

  return buildRotationMat3(angleDeg);
}

/**
 * Apply per-frame decay to a flat Float32 RGBA buffer in-place.
 *
 * Each channel (R, G, B, A) is multiplied by `decayFactor`.  This replicates
 * the decay step of the WGSL persistence shader and is useful for CPU-side
 * tracer simulation and unit tests.  For real-time rendering the GPU pipeline
 * in `WebGPURenderer` handles this more efficiently.
 *
 * @param buffer      Float32 RGBA buffer — values in [0, 1], modified in-place.
 * @param decayFactor Per-frame multiplier, typically from `durationToDecayWith`.
 * @param useWasm     Attempt to use the C++ WASM engine.
 */
export function simulateTracerDecayWith(
  buffer: Float32Array,
  decayFactor: number,
  useWasm: boolean,
): void {
  const pixelCount = Math.floor(buffer.length / 4);

  if (canUseWasmFn('_simulateTracerDecay', useWasm)) {
    const mod = getWasmModule()!;
    const byteCount = pixelCount * 4 * 4; // pixelCount × 4 channels × 4 bytes/float
    const ptr = mod._malloc(byteCount);
    // Copy buffer into WASM heap (HEAPF32 is indexed by float, not byte)
    mod.HEAPF32.set(buffer.subarray(0, pixelCount * 4), ptr >> 2);
    mod._simulateTracerDecay(ptr, pixelCount, decayFactor);
    // Copy result back
    buffer.set(mod.HEAPF32.subarray(ptr >> 2, (ptr >> 2) + pixelCount * 4));
    mod._free(ptr);
    return;
  }

  tsSimulateTracerDecay(buffer, decayFactor);
}
