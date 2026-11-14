/**
 * `window.__renderDebug` (#253): what automation used to get by patching
 * WebGPU prototypes on the page, which cannot reach a render worker.
 *
 * - `readPresentedFrame(slot)` — the next frame that slot presents, copied
 *   from its canvas texture in the task that drew it.
 * - `loseDevice()` — a driver reset: the device is destroyed and reported
 *   lost for an unknown reason, so the overlay and Retry GPU run for real.
 * - `frameTimeline()` — the render clock's recent tick times in epoch ms.
 *
 * Armed by `?renderDebug=1` or `localStorage['chromashift:renderDebug'] = '1'`
 * (a spec's init script sets the latter, so the URL stays the one under
 * test). Armed, the WebGPU canvases are also configured with `COPY_SRC`,
 * which the readback needs; unarmed, nothing here exists.
 */

import { publishDiagnostic } from '../diagnostics';
import type { RenderDebugApi } from './protocol';

const RENDER_DEBUG_PARAM = 'renderDebug';
const RENDER_DEBUG_STORAGE_KEY = 'chromashift:renderDebug';

export function renderDebugArmed(search: string): boolean {
  try {
    if (new URLSearchParams(search).get(RENDER_DEBUG_PARAM) === '1') return true;
  } catch {
    // A malformed query arms nothing.
  }
  try {
    return globalThis.localStorage?.getItem(RENDER_DEBUG_STORAGE_KEY) === '1';
  } catch {
    // Storage can be disabled in hardened browsers.
    return false;
  }
}

export function installRenderDebug(api: RenderDebugApi): void {
  publishDiagnostic('__renderDebug', api);
}
