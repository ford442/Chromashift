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

import { loadWasmEngine, isWasmReady } from '../wasm/loadEngine';
import { computeImageAverageLuminanceWith } from '../wasm/dispatch/luminance';
import { classifyImageMaskWith } from '../wasm/dispatch/classification';

declare const self: DedicatedWorkerGlobalScope;

export type AnalysisRequest =
  | {
      id: number;
      op: 'image-analysis';
      bitmap: ImageBitmap;
      /** Skips the in-worker average-luminance computation when already known. */
      avgLumHint?: number;
      /** Mirrors the caller's engine-mode toggle; the worker declines WASM itself if load fails. */
      useWasm: boolean;
    }
  | {
      id: number;
      op: 'average-luminance';
      bitmap: ImageBitmap;
      useWasm: boolean;
    };

export type AnalysisResponse =
  | {
      id: number;
      kind: 'image-analysis';
      avgLuminance: number;
      mask: Uint8Array;
      width: number;
      height: number;
    }
  | { id: number; kind: 'average-luminance'; avgLuminance: number }
  | { id: number; kind: 'error'; message: string };

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

self.addEventListener('message', async (e: MessageEvent<AnalysisRequest>) => {
  const req = e.data;
  const { bitmap } = req;
  try {
    const wasmReady = await ensureWasmReady(req.useWasm);

    if (req.op === 'average-luminance') {
      const avgLuminance = computeImageAverageLuminanceWith(bitmap, wasmReady);
      const response: AnalysisResponse = { id: req.id, kind: 'average-luminance', avgLuminance };
      self.postMessage(response);
      return;
    }

    if (req.op !== 'image-analysis') {
      throw new Error(`analysis.worker: unknown op "${(req as { op: string }).op}"`);
    }

    const avgLuminance = req.avgLumHint ?? computeImageAverageLuminanceWith(bitmap, wasmReady);
    const result = classifyImageMaskWith(bitmap, avgLuminance, wasmReady);
    if (!result) {
      throw new Error('analysis.worker: classifyImageMaskWith returned null');
    }
    const response: AnalysisResponse = {
      id: req.id,
      kind: 'image-analysis',
      avgLuminance,
      mask: result.mask,
      width: result.width,
      height: result.height,
    };
    self.postMessage(response, [result.mask.buffer]);
  } catch (error) {
    const response: AnalysisResponse = {
      id: req.id,
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  } finally {
    bitmap.close();
  }
});
