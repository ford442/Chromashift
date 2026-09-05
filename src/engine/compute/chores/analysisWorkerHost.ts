/**
 * Worker-backed `CpuChoreHost`.
 *
 * Lazily spawns `analysis.worker.ts` on the first call and keeps it alive for
 * the app's lifetime — the same lazy-singleton pattern `Upscaler.ts` uses for
 * its workers — so a healthy WebGPU session (the common case) never pays the
 * cost of spinning this up at all. `useClassificationMask.ts` is the
 * production caller; Vitest and the WASM/TS parity tests use the in-process
 * host (`createChromashiftCpuHost`) directly instead.
 *
 * Falls back to that same in-process host — same thread, same math,
 * `mode: 'inline'` — if the worker itself cannot be used (construction
 * throws, `createImageBitmap` throws, or the worker reports an error), so a
 * CPU-lane job is never silently dropped just because the worker path failed.
 * The fallback is permanent for the life of this host instance: once the
 * worker has failed once, every subsequent call goes straight to inline
 * rather than re-attempting a worker that already proved broken.
 */

import { createChromashiftCpuHost } from './chromashiftHost';
import type { CpuChoreHost, CpuImageAnalysisResult } from './types';
import type { AnalysisRequest, AnalysisResponse } from '../analysis.worker';

export type AnalysisWorkerFactory = () => Worker;

const defaultWorkerFactory: AnalysisWorkerFactory = () =>
  new Worker(new URL('../analysis.worker.ts', import.meta.url), { type: 'module' });

interface PendingRequest {
  resolve: (response: AnalysisResponse) => void;
  reject: (error: unknown) => void;
}

/**
 * @param wasmEnabled   Mirrors the engine-mode toggle (same contract as
 *                      `createChromashiftCpuHost`).
 * @param workerFactory Overridable for tests — inject a fake `Worker` so the
 *                      request/response correlation can be exercised without
 *                      a real browser Worker + OffscreenCanvas.
 */
export function createWorkerChromashiftCpuHost(
  wasmEnabled: () => boolean,
  workerFactory: AnalysisWorkerFactory = defaultWorkerFactory,
): CpuChoreHost {
  const inlineHost = createChromashiftCpuHost(wasmEnabled);

  let worker: Worker | null = null;
  let workerFailed = false;
  let nextId = 1;
  const pending = new Map<number, PendingRequest>();

  function failAllPending(error: unknown): void {
    for (const [id, entry] of pending) {
      pending.delete(id);
      entry.reject(error);
    }
  }

  function getWorker(): Worker {
    if (worker) return worker;
    worker = workerFactory();
    worker.addEventListener('message', (e: MessageEvent<AnalysisResponse>) => {
      const entry = pending.get(e.data.id);
      if (!entry) return;
      pending.delete(e.data.id);
      entry.resolve(e.data);
    });
    // A worker-level error (e.g. a script error outside the message handler's
    // own try/catch) would otherwise hang every in-flight request forever.
    worker.addEventListener('error', (e: ErrorEvent) => {
      failAllPending(e.error instanceof Error ? e.error : new Error(e.message || 'analysis worker error'));
    });
    return worker;
  }

  async function runInWorker(
    image: HTMLImageElement,
    avgLumHint: number | undefined,
    useWasm: boolean,
  ): Promise<CpuImageAnalysisResult | null> {
    const bitmap = await createImageBitmap(image);
    const id = nextId++;
    const request: AnalysisRequest = { id, op: 'image-analysis', bitmap, avgLumHint, useWasm };

    const response = await new Promise<AnalysisResponse>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        getWorker().postMessage(request, [bitmap]);
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });

    if (response.kind === 'error') throw new Error(response.message);
    if (response.kind !== 'image-analysis') {
      throw new Error(`analysis worker: unexpected response kind "${response.kind}"`);
    }
    return {
      avgLuminance: response.avgLuminance,
      mask: response.mask,
      width: response.width,
      height: response.height,
      mode: 'worker',
    };
  }

  async function runLuminanceInWorker(
    image: HTMLImageElement,
    useWasm: boolean,
  ): Promise<{ avgLuminance: number; mode: 'worker' }> {
    const bitmap = await createImageBitmap(image);
    const id = nextId++;
    const request: AnalysisRequest = { id, op: 'average-luminance', bitmap, useWasm };

    const response = await new Promise<AnalysisResponse>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        getWorker().postMessage(request, [bitmap]);
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });

    if (response.kind === 'error') throw new Error(response.message);
    if (response.kind !== 'average-luminance') {
      throw new Error(`analysis worker: unexpected response kind "${response.kind}"`);
    }
    return { avgLuminance: response.avgLuminance, mode: 'worker' };
  }

  return {
    isWasmReady: inlineHost.isWasmReady,
    async analyzeImage(image, avgLumHint, useWasm) {
      if (!workerFailed) {
        try {
          return await runInWorker(image, avgLumHint, useWasm);
        } catch (error) {
          workerFailed = true;
          console.warn(
            '[gpu-chores] analysis worker unavailable, falling back to the in-process CPU lane:',
            error,
          );
        }
      }
      return inlineHost.analyzeImage(image, avgLumHint, useWasm);
    },
    async computeAverageLuminance(image, useWasm) {
      if (!workerFailed) {
        try {
          return await runLuminanceInWorker(image, useWasm);
        } catch (error) {
          workerFailed = true;
          console.warn(
            '[gpu-chores] analysis worker unavailable, falling back to the in-process CPU lane:',
            error,
          );
        }
      }
      return inlineHost.computeAverageLuminance(image, useWasm);
    },
  };
}
