/**
 * Motion worker — the `motion-field` chore's off-main-thread home.
 *
 * Stage 1 (the frame difference) is cheap enough that it ran on the animation
 * thread without anyone noticing. Stage 2 is not: coarse-to-fine Lucas–Kanade
 * is nine window taps per cell per level, and at 4K the field is 960×540 cells,
 * which is millions of multiply-adds per sample on the thread driving
 * `requestAnimationFrame`. This worker is where that goes.
 *
 * The main thread keeps only the part it cannot hand over: one `drawImage` into
 * a canvas already at field resolution and the `getImageData` that reads it
 * back. Everything downstream — the luminance downsample, the difference, the
 * pyramid, the solve — happens here, and the small result arrays come back as
 * transfers rather than copies.
 *
 * Lane selection stays on the main thread: this worker is a `CpuChoreHost`
 * *kernel*, not a second facade, so `window.motionFieldBackend` still reports
 * which of `wasm` / `ts` served the frame and why the other declined.
 *
 * Deliberately separate from `analysis.worker.ts`. That one is a load-time
 * worker whose jobs are seconds apart and hold an 8K bitmap; this one runs on
 * the render loop's cadence, and a long classification must never be what a
 * motion sample is queued behind.
 */

/// <reference lib="webworker" />

import {
  downsampleLuminance,
  motionMagnitudeField,
  type LuminancePlane,
} from './chores/motionKernel';
import { loadWasmEngine, isWasmReady } from '../wasm/loadEngine';
import { computeMotionFlowWith } from '../wasm/dispatch/motion';

declare const self: DedicatedWorkerGlobalScope;

export interface MotionWorkerRequest {
  id: number;
  op: 'motion-field';
  /** Tightly packed RGBA8, transferred rather than copied. */
  pixels: ArrayBuffer;
  width: number;
  height: number;
  divisor: number;
  threshold: number;
  /** Drop the history held below (source switch, seek, resize). */
  reset: boolean;
  /** Also solve for the flow vector. */
  flow: boolean;
  /** Mirrors the caller's engine-mode toggle; the worker declines WASM itself. */
  useWasm: boolean;
}

export type MotionWorkerResponse =
  | {
      id: number;
      kind: 'motion-field';
      field: Float32Array;
      flow: Float32Array | null;
      width: number;
      height: number;
    }
  | { id: number; kind: 'error'; message: string };

/**
 * Previous frame's luminance plane. Owned here rather than by the lane on the
 * main thread: the plane is the one piece of state a frame difference needs,
 * and shipping it across the boundary every sample would cost more than the
 * difference itself.
 */
let previousLuminance: LuminancePlane | null = null;

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

self.addEventListener('message', async (e: MessageEvent<MotionWorkerRequest>) => {
  const req = e.data;
  try {
    if (req.op !== 'motion-field') {
      throw new Error(`motion.worker: unknown op "${(req as { op: string }).op}"`);
    }
    const wasmReady = await ensureWasmReady(req.useWasm);

    const frame = { data: new Uint8ClampedArray(req.pixels), width: req.width, height: req.height };
    const current = downsampleLuminance(frame, req.divisor);
    const previous = req.reset ? null : previousLuminance;
    const field = motionMagnitudeField(current, previous, req.threshold);
    const flow = req.flow
      ? computeMotionFlowWith(current, previous, wasmReady)
      : null;
    previousLuminance = current;

    const response: MotionWorkerResponse = {
      id: req.id,
      kind: 'motion-field',
      field,
      flow,
      width: current.width,
      height: current.height,
    };
    const transfer: Transferable[] = [field.buffer];
    if (flow) transfer.push(flow.buffer);
    self.postMessage(response, transfer);
  } catch (error) {
    const response: MotionWorkerResponse = {
      id: req.id,
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
});
