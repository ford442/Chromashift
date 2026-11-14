/**
 * Which transport carries the render protocol (#253): chosen once per page,
 * before the first boot — a canvas handed to a worker cannot come back.
 *
 * - `?renderer=webgl` (the WebGL backend, and WebXR with it) → **main**.
 * - `?renderer=main` → WebGPU on **main**: the forced flag, for comparing the
 *   transports and for a browser whose worker path misbehaves.
 * - Otherwise **worker** when the `render-worker` capability holds
 *   (`graph/capabilities.ts`): the page half is checked here, the worker half
 *   by asking a render worker what it found. Anything short of a yes — a
 *   missing global, a worker that would not start, no adapter there — is
 *   **main**, with the reason published to `window.renderTransportReason`.
 */

import {
  renderWorkerPageSupport,
  renderWorkerScopeSupport,
  type PlatformCapability,
  type RenderWorkerPageScope,
  type RenderWorkerScopeReport,
} from '../graph/capabilities';
import type { RendererBackend } from '../types/RendererContracts';
import type { RenderTransportKind } from './protocol';

export interface RenderTransportChoice {
  kind: RenderTransportKind;
  reason: string;
}

export interface SelectRenderTransportOptions {
  backend: RendererBackend;
  /** The page's `location.search`. */
  search: string;
  pageScope: RenderWorkerPageScope;
  /** Ask a render worker what its scope offers. A rejection is a "no". */
  probeWorker: () => Promise<RenderWorkerScopeReport>;
}

/** `?renderer=main` asks for WebGPU on the page's thread. */
export function isMainTransportForced(search: string): boolean {
  try {
    return new URLSearchParams(search).get('renderer')?.toLowerCase() === 'main';
  } catch {
    return false;
  }
}

const RENDER_WORKER: PlatformCapability = 'render-worker';

export async function selectRenderTransport(options: SelectRenderTransportOptions): Promise<RenderTransportChoice> {
  if (options.backend === 'webgl') {
    return { kind: 'main', reason: 'the WebGL backend (and WebXR with it) draws on the page' };
  }
  if (isMainTransportForced(options.search)) return { kind: 'main', reason: 'forced by ?renderer=main' };

  const page = renderWorkerPageSupport(options.pageScope);
  if (page) return { kind: 'main', reason: `${RENDER_WORKER} withheld: ${page}` };

  let report: RenderWorkerScopeReport;
  try {
    report = await options.probeWorker();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { kind: 'main', reason: `${RENDER_WORKER} withheld: the worker probe failed (${detail})` };
  }
  const worker = renderWorkerScopeSupport(report);
  if (worker) return { kind: 'main', reason: `${RENDER_WORKER} withheld: ${worker}` };
  const clock = report.scheduler === 'raf' ? "the worker's requestAnimationFrame" : 'a timeout pacer';
  return { kind: 'worker', reason: `${RENDER_WORKER}: OffscreenCanvas + WebGPU in a worker, paced by ${clock}` };
}
