/**
 * Worker-backed motion kernel for the `gpu-chores` CPU lanes.
 *
 * Wraps `motion.worker.ts` behind `CpuMotionFieldHost`, so lane selection,
 * decline reasons, and the `window.motionFieldBackend` breadcrumb all stay on
 * the main thread exactly as they were — only the arithmetic moves. That is the
 * same split `analysisWorkerHost.ts` uses for `image-analysis`.
 *
 * Falls back to the in-process kernel — same thread, same maths,
 * `mode: 'inline'` — when the worker cannot be used (construction throws, or
 * the worker reports an error). The fallback is permanent for the life of this
 * host: a worker that has already proved broken is not retried every frame.
 *
 * One sample is in flight at a time by construction — `LiveMotionSampler` drops
 * a tick that arrives during a sample — so there is no queue to bound here.
 */

import {
  downsampleLuminance,
  lucasKanadeFlow,
  motionMagnitudeField,
  type LuminancePlane,
} from './motionKernel';
import type { CpuMotionFieldHost, CpuMotionFieldResult, MotionFramePixels } from './types';
import type { MotionProtocol } from '../motion.worker';
import { createWorkerRpc } from '../../workers/rpc';
import { publishWorkerWasmEngine } from '../../diagnostics';

export type MotionWorkerFactory = () => Worker;

const defaultWorkerFactory: MotionWorkerFactory = () =>
  new Worker(new URL('../motion.worker.ts', import.meta.url), { type: 'module' });

/**
 * @param wasmEnabled   Mirrors the engine-mode toggle; the worker loads its own
 *                      module instance and declines WASM itself if that fails.
 * @param workerFactory Overridable for tests — inject a fake `Worker` so the
 *                      request/response correlation can be exercised without a
 *                      real browser Worker.
 */
export function createMotionWorkerHost(
  wasmEnabled: () => boolean,
  workerFactory: MotionWorkerFactory = defaultWorkerFactory,
): CpuMotionFieldHost & { destroy(): void } {
  // A worker-level error fails the sample in flight rather than hanging it.
  const rpc = createWorkerRpc<MotionProtocol>(workerFactory, { label: 'motion' });
  let workerFailed = false;
  /** In-process history, used only once the worker has been given up on. */
  let previousLuminance: LuminancePlane | null = null;

  async function runInWorker(
    frame: MotionFramePixels,
    divisor: number,
    threshold: number,
    reset: boolean,
    flow: boolean,
    useWasm: boolean,
  ): Promise<CpuMotionFieldResult | null> {
    // A fresh copy so the transfer cannot neuter a buffer the caller still owns
    // (the sampler's `ImageData` is reused frame to frame).
    const pixels = frame.data.slice().buffer;
    const { wasmEngine, ...response } = await rpc.call('motion-field', {
      pixels,
      width: frame.width,
      height: frame.height,
      divisor,
      threshold,
      reset,
      flow,
      useWasm,
    }, { transfer: [pixels] });
    publishWorkerWasmEngine('motion', wasmEngine);
    return { ...response, mode: 'worker' };
  }

  function runInline(
    frame: MotionFramePixels,
    divisor: number,
    threshold: number,
    reset: boolean,
    flow: boolean,
  ): CpuMotionFieldResult {
    const current = downsampleLuminance(frame, divisor);
    const previous = reset ? null : previousLuminance;
    const field = motionMagnitudeField(current, previous, threshold);
    const vectors = flow ? lucasKanadeFlow(current, previous).flow : null;
    previousLuminance = current;
    return {
      field,
      flow: vectors,
      width: current.width,
      height: current.height,
      mode: 'inline',
    };
  }

  return {
    async motionField(frame, divisor, threshold, reset, flow, useWasm) {
      if (!workerFailed) {
        try {
          return await runInWorker(
            frame, divisor, threshold, reset, flow, useWasm && wasmEnabled(),
          );
        } catch (error) {
          workerFailed = true;
          // The worker held the frame history; the inline path starts fresh.
          previousLuminance = null;
          console.warn(
            '[gpu-chores] motion worker unavailable, falling back to the in-process kernel:',
            error,
          );
        }
      }
      return runInline(frame, divisor, threshold, reset, flow);
    },
    destroy(): void {
      rpc.terminate('motion worker host destroyed');
      previousLuminance = null;
    },
  };
}
