/**
 * Chromashift's binding of the `gpu-chores` CPU lanes to the WASM engine.
 *
 * Kept out of `chores/` proper so the facade stays app-agnostic: this is the
 * one file a sibling app would replace with its own equivalent.
 *
 * This is the **in-process** host: `analyzeImage` runs synchronously on
 * whichever thread calls it, wrapped in a resolved `Promise` to satisfy the
 * async `CpuChoreHost` contract. It backs Vitest / C++-TS parity tests and is
 * also the fallback path `analysisWorkerHost.ts` uses if the worker itself
 * fails. Production code should prefer `createWorkerChromashiftCpuHost`
 * (`analysisWorkerHost.ts`) so the 8K-image pixel readback + classification
 * never blocks the main thread.
 */

import {
  classifyImageMaskWith,
  computeImageAverageLuminanceWith,
  isWasmReady,
} from '../../WasmEngine';
import type { CpuChoreHost, CpuImageAnalysisResult } from './types';

/**
 * `wasmEnabled` mirrors the engine-mode toggle. The `wasm` lane declines
 * unless the user selected WASM *and* the module is loaded, which is exactly
 * the condition the pre-facade hook used before choosing between
 * `computeClassificationMask` and the TypeScript fallback.
 */
export function createChromashiftCpuHost(wasmEnabled: () => boolean): CpuChoreHost {
  return {
    isWasmReady: () => wasmEnabled() && isWasmReady(),
    async analyzeImage(image, avgLumHint, useWasm): Promise<CpuImageAnalysisResult | null> {
      const avgLuminance = avgLumHint ?? computeImageAverageLuminanceWith(image, useWasm);
      const result = classifyImageMaskWith(image, avgLuminance, useWasm);
      if (!result) return null;
      return {
        avgLuminance,
        mask: result.mask,
        width: result.width,
        height: result.height,
        mode: 'inline',
      };
    },
    async computeAverageLuminance(image, useWasm) {
      return { avgLuminance: computeImageAverageLuminanceWith(image, useWasm), mode: 'inline' };
    },
  };
}
