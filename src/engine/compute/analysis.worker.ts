/**
 * Analysis worker — the `gpu-chores` `wasm`/`ts` CPU lanes' off-main-thread
 * home.
 *
 * `getImageDataAtNaturalSize()` on an 8K source allocates ~268 MB and reads it
 * back synchronously; `classifyImageMaskWith()` then runs a many-million-
 * iteration scalar loop over it. Both used to run on the main thread — the
 * thread driving `requestAnimationFrame` — every time the WebGPU compute lane
 * wasn't available (`?renderer=webgl`, Firefox/Safari, `?no_gpu_compute`, or a
 * driver where the compute lane declined). This worker moves both off it.
 *
 * It owns its own instance of the WASM engine (`loadWasmEngine`/`loadEngine.ts`
 * hold module-scoped state, so a separate realm — this worker — gets a
 * separate, independently-loaded module instance) and calls the exact same
 * dispatch functions the main thread used to call directly, just against an
 * `ImageBitmap` + `OffscreenCanvas` instead of an `HTMLImageElement` + DOM
 * `<canvas>` — see `PixelSource` in `wasm/imageBytes.ts`. Same math, same
 * inputs, so the mask this produces is byte-identical to the pre-worker path.
 *
 * Loaded lazily by `analysisWorkerHost.ts` on the first CPU-lane job, so a
 * healthy WebGPU session never pays for spinning this up.
 */

/// <reference lib="webworker" />

import { getWasmEngineStatus, loadWasmEngine, isWasmReady, type WasmEngineStatus } from '../wasm/loadEngine';
import { computeImageAverageLuminanceWith } from '../wasm/dispatch/luminance';
import { classifyImageMaskWith } from '../wasm/dispatch/classification';
import { exposeWorkerRpc } from '../workers/rpc';

declare const self: DedicatedWorkerGlobalScope;

export interface AnalysisRequest {
  /** Transferred; the worker closes it. */
  bitmap: ImageBitmap;
  /** Mirrors the caller's engine-mode toggle; the worker declines WASM itself if load fails. */
  useWasm: boolean;
}

export type AnalysisProtocol = {
  'image-analysis': (
    req: AnalysisRequest & {
      /** Skips the in-worker average-luminance computation when already known. */
      avgLumHint?: number;
    },
  ) => {
    avgLuminance: number;
    mask: Uint8Array;
    width: number;
    height: number;
    wasmEngine: WasmEngineStatus;
  };
  'average-luminance': (req: AnalysisRequest) => { avgLuminance: number; wasmEngine: WasmEngineStatus };
};

let wasmLoadAttempted = false;

/** Loads the worker's own WASM module instance at most once. */
async function ensureWasmReady(useWasm: boolean): Promise<boolean> {
  if (!useWasm) return false;
  if (!wasmLoadAttempted) {
    wasmLoadAttempted = true;
    await loadWasmEngine();
  }
  return isWasmReady();
}

exposeWorkerRpc<AnalysisProtocol>(self, {
  async 'average-luminance'({ bitmap, useWasm }) {
    try {
      const wasmReady = await ensureWasmReady(useWasm);
      return {
        avgLuminance: computeImageAverageLuminanceWith(bitmap, wasmReady),
        wasmEngine: getWasmEngineStatus(),
      };
    } finally {
      bitmap.close();
    }
  },
  async 'image-analysis'({ bitmap, useWasm, avgLumHint }, ctx) {
    try {
      const wasmReady = await ensureWasmReady(useWasm);
      const avgLuminance = avgLumHint ?? computeImageAverageLuminanceWith(bitmap, wasmReady);
      const result = classifyImageMaskWith(bitmap, avgLuminance, wasmReady);
      if (!result) {
        throw new Error('analysis.worker: classifyImageMaskWith returned null');
      }
      ctx.transfer(result.mask.buffer);
      return {
        avgLuminance,
        mask: result.mask,
        width: result.width,
        height: result.height,
        wasmEngine: getWasmEngineStatus(),
      };
    } finally {
      bitmap.close();
    }
  },
});
