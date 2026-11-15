/**
 * GPU runtime errors for both backends: the `GpuRuntimeError` shape the
 * overlay shows, the mappings into it, error scopes, device diagnostics, and
 * the page's fatal breaker.
 */
import { WebGL2ContextLostError } from '../webgl/webgl2Context';

export type GpuErrorKind = 'bootstrap' | 'device-lost' | 'uncaptured' | 'pipeline';

export interface GpuRuntimeError {
  kind: GpuErrorKind;
  message: string;
  detail?: string;
  recoverable: boolean;
}

/**
 * The page's fatal breaker. Once a device request fails in a way that further
 * requests would make worse, every later bootstrap refuses until reload —
 * React effect re-runs and Retry GPU included (#157 / #158).
 */
let gpuFatal: GpuRuntimeError | null = null;

export function getGpuFatalError(): GpuRuntimeError | null {
  return gpuFatal;
}

export function markGpuFatal(error: GpuRuntimeError): void {
  gpuFatal ??= error;
}

/** Test-only: clear the breaker (`resetGpuDeviceGateForTests` calls this). */
export function resetGpuFatalForTests(): void {
  gpuFatal = null;
}

/** D3D12 queue create OOM and similar — further requestDevice attempts make it worse. */
export function isFatalGpuDeviceRequestError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /E_OUTOFMEMORY|0x8007000E|create command queue|out of memory/i.test(message);
}

export function attachDeviceDiagnostics(
  device: GPUDevice,
  handlers: {
    onLost?: (info: GPUDeviceLostInfo) => void;
    onUncapturedError?: (error: GPUError) => void;
  },
): () => void {
  // The device outlives every bootstrap on it (it is page-leased), and a
  // promise reaction cannot be removed — so the detach silences it instead.
  // Without that, each Retry or React re-run added a listener that a later
  // `device.lost` fired for every orchestrator that ever existed.
  let attached = true;
  const onLost = (info: GPUDeviceLostInfo) => {
    if (attached) handlers.onLost?.(info);
  };
  void device.lost.then(onLost);
  let simulated = simulatedLossListeners.get(device);
  if (!simulated) {
    simulated = new Set();
    simulatedLossListeners.set(device, simulated);
  }
  simulated.add(onLost);

  const previous = device.onuncapturederror;
  device.onuncapturederror = (event: GPUUncapturedErrorEvent) => {
    handlers.onUncapturedError?.(event.error);
    previous?.call(device, event);
  };

  return () => {
    attached = false;
    simulated.delete(onLost);
    device.onuncapturederror = previous ?? null;
  };
}

/** `attachDeviceDiagnostics`' `lost` listeners per device, for `simulateDeviceLoss`. */
const simulatedLossListeners = new WeakMap<GPUDevice, Set<(info: GPUDeviceLostInfo) => void>>();

/**
 * Lose `device` the way a driver reset looks to the app: it really is
 * destroyed, and every attached `lost` listener hears an unexplained loss
 * (`device.destroy()` alone reports `'destroyed'`, which the app treats as its
 * own doing and ignores). The debug hook behind `__renderDebug.loseDevice()`
 * (`render/debug.ts`) — it works in the render worker, where a spec cannot
 * patch `GPUAdapter.prototype` the way it can on the page.
 */
export function simulateDeviceLoss(device: GPUDevice, message = 'simulated driver reset'): void {
  const listeners = [...(simulatedLossListeners.get(device) ?? [])];
  device.destroy();
  const info = { reason: 'unknown', message } as GPUDeviceLostInfo;
  for (const listener of listeners) listener(info);
}

export async function withErrorScope<T>(
  device: GPUDevice,
  filter: GPUErrorFilter,
  label: string,
  work: () => T | Promise<T>,
): Promise<T> {
  device.pushErrorScope(filter);
  // Pop exactly once. The scoped error is thrown from inside the `try`, so
  // without the flag the `catch` popped a second time — taking an enclosing
  // caller's scope with it.
  let popped = false;
  try {
    const result = await work();
    popped = true;
    const scopedError = await device.popErrorScope();
    if (scopedError) {
      throw createScopedGpuError(label, scopedError);
    }
    return result;
  } catch (error) {
    if (!popped) await device.popErrorScope().catch(() => null);
    throw error;
  }
}

function createScopedGpuError(label: string, gpuError: GPUError): Error {
  const err = new Error(`[WebGPU:${label}] ${gpuError.message}`);
  (err as Error & { gpuError: GPUError }).gpuError = gpuError;
  return err;
}

export function toBootstrapRuntimeError(error: unknown): GpuRuntimeError {
  const message = error instanceof Error ? error.message : String(error);
  // A Retry while the context is still lost: keep the recoverable overlay up.
  if (error instanceof WebGL2ContextLostError) return webglContextLostRuntimeError();
  if (isFatalGpuDeviceRequestError(error)) {
    return {
      kind: 'bootstrap',
      message: 'WebGPU device request failed (GPU queue out of memory).',
      detail: message,
      recoverable: false,
    };
  }
  return {
    kind: 'bootstrap',
    message,
    recoverable: false,
  };
}

export function deviceLostRuntimeError(info: GPUDeviceLostInfo): GpuRuntimeError {
  const reason = info.reason === 'destroyed'
    ? 'The GPU device was destroyed.'
    : 'The GPU device was lost (browser or driver reset).';
  return {
    kind: 'device-lost',
    message: 'GPU device lost — rendering has stopped.',
    detail: `${reason} Message: ${info.message || '(none)'}`,
    recoverable: true,
  };
}

/**
 * A pipeline the device refused to build: an emitted shader that does not
 * compile, or a layout that does not match it. Not recoverable by a retry —
 * the same source is refused again — but not fatal either: the frame keeps
 * drawing without whatever needed that pipeline.
 */
export function pipelineRuntimeError(what: string, error: unknown): GpuRuntimeError {
  return {
    kind: 'pipeline',
    message: `${what} failed to build — that view is unavailable.`,
    detail: error instanceof Error ? error.message : String(error),
    recoverable: false,
  };
}

export function webglContextLostRuntimeError(): GpuRuntimeError {
  return {
    kind: 'device-lost',
    message: 'WebGL context lost — rendering has stopped.',
    detail: 'The browser reclaimed the WebGL2 context (GPU reset, or too many contexts). '
      + 'Rendering resumes if the browser restores it; reload the page if it does not.',
    recoverable: true,
  };
}
