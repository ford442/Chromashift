/// <reference lib="webworker" />
/**
 * The render worker (#253): `RenderService` behind the shared worker channel,
 * drawing the page's canvases as transferred `OffscreenCanvas`es.
 *
 * Its `FrameClock` is its own, paced by the worker's `requestAnimationFrame`
 * (Chromium, Firefox) or a timeout pacer — a long task on the page does not
 * delay a frame here. Breadcrumbs published in this realm are forwarded to the
 * page's `window` (`forwardDiagnostics`), so a spec reads the same keys on
 * either transport.
 *
 * Spawned once per page by `RenderHost` and never terminated: the canvases it
 * was handed cannot be handed to anything else.
 */

import { forwardDiagnostics } from '../diagnostics';
import { FrameClock } from '../frame/FrameClock';
import { workerFrameScheduler } from '../frame/schedulers';
import type { RenderWorkerScopeReport } from '../graph/capabilities';
import { requestWebGpuAdapter } from '../webgpu/adapter';
import { exposeWorkerRpc, type RpcEmitter } from '../workers/rpc';
import { RenderService } from './RenderService';
import type { RenderEmit, RenderEvents, RenderWorkerProtocol } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

let emitter: RpcEmitter<RenderEvents> | null = null;
const emit: RenderEmit = (event, payload, transfer) => emitter?.emit(event, payload, transfer);

forwardDiagnostics((values) => emit('diagnostics', values));

const { scheduler, kind } = workerFrameScheduler(self);
const clock = new FrameClock({ scheduler });
const service = new RenderService({ clock, ownsClock: true, transport: 'worker', emit });

/** The worker half of the `render-worker` capability, tested here rather than assumed. */
async function probe(): Promise<RenderWorkerScopeReport> {
  const gpu = typeof navigator !== 'undefined' && Boolean(navigator.gpu);
  let offscreenContext = false;
  if (gpu && typeof OffscreenCanvas === 'function') {
    try {
      offscreenContext = new OffscreenCanvas(1, 1).getContext('webgpu') !== null;
    } catch {
      offscreenContext = false;
    }
  }
  let adapter = false;
  if (gpu && offscreenContext) {
    try {
      // Through the device gate, so the boot that follows reuses it.
      adapter = (await requestWebGpuAdapter()) !== null;
    } catch {
      adapter = false;
    }
  }
  return { gpu, offscreenContext, adapter, scheduler: kind };
}

emitter = exposeWorkerRpc<RenderWorkerProtocol, never, RenderEvents>(self, {
  ...service.handlers(),
  probe,
});
