/**
 * Motion-flow `*With()` dispatcher. See docs/wasm-engine.md for the call-site matrix.
 *
 * This is the first *per-frame* WASM kernel in the engine: every other export
 * here runs at load time or once per parameter change. Optical flow earns it —
 * the WebGL diagnostic backend and `?no_gpu_compute` have no compute lane, so
 * without it `motionMode: 'direction'` would be a WebGPU-only feature.
 */

import { canUseWasmFn, getPersistentBuf, getWasmModule } from '../loadEngine';
import { lucasKanadeFlow, type LuminancePlane } from '../../compute/chores/motionKernel';

/**
 * The most cells the C++ kernel takes: its output is two floats a cell, so
 * `UINT32_MAX / 8` keeps every byte offset in 32 bits (`kMaxFlowCells` in
 * cpp/motion_flow.cpp). Above it the export returns without writing.
 */
const MAX_FLOW_CELLS = Math.floor(0xffffffff / 8);

/** A plane must hold exactly `width × height` floats: the kernel reads that many and no fewer. */
function assertPlaneLength(plane: LuminancePlane, label: string): void {
  const cells = plane.width * plane.height;
  if (plane.lum.length !== cells) {
    throw new RangeError(
      `computeMotionFlowWith: ${label} plane holds ${plane.lum.length} floats, `
      + `${plane.width}×${plane.height} needs ${cells}`,
    );
  }
}

/**
 * Coarse-to-fine Lucas–Kanade flow for one frame pair.
 *
 * When `useWasm` is `true` **and** the WASM module is loaded the solve runs in
 * the C++ engine (SIMD128 where the access pattern allows); otherwise the
 * portable kernel in `motionKernel.ts` runs — the same function the `ts` lane
 * and the headless parity tests use, so the two paths are the same maths.
 *
 * `previous` of `null`, or a geometry change, yields an all-zero field: a
 * source with no comparable history has no motion, exactly as the magnitude
 * kernel treats it.
 *
 * @returns Interleaved `vx, vy` per cell, in cells per frame.
 */
export function computeMotionFlowWith(
  current: LuminancePlane,
  previous: LuminancePlane | null,
  useWasm: boolean,
): Float32Array {
  assertPlaneLength(current, 'current');
  const cells = current.width * current.height;
  if (
    !previous
    || previous.width !== current.width
    || previous.height !== current.height
  ) {
    return new Float32Array(cells * 2);
  }

  assertPlaneLength(previous, 'previous');
  if (cells > MAX_FLOW_CELLS) {
    throw new RangeError(`computeMotionFlowWith: ${cells} cells exceeds the ${MAX_FLOW_CELLS}-cell limit`);
  }

  if (canUseWasmFn('_computeMotionFlow', useWasm)) {
    const mod = getWasmModule()!;
    // One persistent allocation holds all three arrays back to back: two input
    // planes and the interleaved output. Floats, so every offset is 4-aligned.
    const planeBytes = cells * 4;
    const base = getPersistentBuf(planeBytes * 4);
    const curPtr = base;
    const prevPtr = base + planeBytes;
    const outPtr = base + planeBytes * 2;
    mod.HEAPF32.set(current.lum, curPtr >> 2);
    mod.HEAPF32.set(previous.lum, prevPtr >> 2);
    mod._computeMotionFlow(curPtr, prevPtr, current.width, current.height, outPtr);
    // Copied out rather than returned as a heap view: the next call reuses this
    // very allocation, and the caller keeps the array across frames.
    return mod.HEAPF32.slice(outPtr >> 2, (outPtr >> 2) + cells * 2);
  }

  return lucasKanadeFlow(current, previous).flow;
}
