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
import type { AnalysisProtocol } from '../analysis.worker';
import { createWorkerRpc } from '../../workers/rpc';
import { publishWorkerWasmEngine } from '../../diagnostics';

export type AnalysisWorkerFactory = () => Worker;

const defaultWorkerFactory: AnalysisWorkerFactory = () =>
  new Worker(new URL('../analysis.worker.ts', import.meta.url), { type: 'module' });

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
  // Correlation, and failing every in-flight request on a worker-level error
  // (which would otherwise hang it forever), live in the rpc channel.
  const rpc = createWorkerRpc<AnalysisProtocol>(workerFactory, { label: 'analysis' });
  let workerFailed = false;

  async function runInWorker(
    image: HTMLImageElement,
    avgLumHint: number | undefined,
    useWasm: boolean,
  ): Promise<CpuImageAnalysisResult | null> {
    const bitmap = await createImageBitmap(image);
    const { wasmEngine, ...response } = await rpc.call(
      'image-analysis',
      { bitmap, avgLumHint, useWasm },
      { transfer: [bitmap] },
    );
    publishWorkerWasmEngine('analysis', wasmEngine);
    return { ...response, mode: 'worker' };
  }

  async function runLuminanceInWorker(
    image: HTMLImageElement,
    useWasm: boolean,
  ): Promise<{ avgLuminance: number; mode: 'worker' }> {
    const bitmap = await createImageBitmap(image);
    const response = await rpc.call('average-luminance', { bitmap, useWasm }, { transfer: [bitmap] });
    publishWorkerWasmEngine('analysis', response.wasmEngine);
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
