/**
 * Chromashift's binding of the `gpu-chores` CPU lanes to the WASM engine.
 *
 * Kept out of `chores/` proper so the facade stays app-agnostic: this is the
 * one file a sibling app would replace with its own equivalent.
 */

import {
  classifyImageMaskWith,
  computeImageAverageLuminanceWith,
  isWasmReady,
} from '../../WasmEngine';
import type { CpuChoreHost } from './cpuBackend';

/**
 * `wasmEnabled` mirrors the engine-mode toggle. The `wasm` lane declines
 * unless the user selected WASM *and* the module is loaded, which is exactly
 * the condition the pre-facade hook used before choosing between
 * `computeClassificationMask` and the TypeScript fallback.
 */
export function createChromashiftCpuHost(wasmEnabled: () => boolean): CpuChoreHost {
  return {
    isWasmReady: () => wasmEnabled() && isWasmReady(),
    computeImageAverageLuminanceWith,
    classifyImageMaskWith,
  };
}
