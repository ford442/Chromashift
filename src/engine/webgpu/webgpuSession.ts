import type { RendererCanvasOptions } from '../gpu/gpuOptions';
import {
  attachDeviceDiagnostics,
  deviceLostRuntimeError,
  getGpuFatalError,
  type GpuRuntimeError,
} from '../gpu/gpuErrors';
import {
  buildAdapterReport,
  buildWebGpuCapabilityReport,
  listAvailableOptionalFeatures,
  logAdapterReport,
  readAdapterInfo,
  requestWebGpuAdapter,
  requestWebGpuDevice,
  type GpuAdapterReport,
  type WebGpuCapabilityReport,
} from './adapter';
import {
  configureWebGpuCanvas,
  probeCanvasHdr,
  publishCanvasHdrBreadcrumbs,
  type WebGpuCanvasOptions,
} from './canvasConfig';
import type { PresentationTarget } from './presentationTarget';

export interface WebGpuBootstrapOptions extends RendererCanvasOptions {
  /** The canvas to present to. Exactly one of `canvas` and `target`. */
  canvas?: HTMLCanvasElement;
  /** An offscreen presentation target in place of a canvas (`HeadlessSurface`). */
  target?: PresentationTarget;
  /** The SDR present format; defaults to `navigator.gpu.getPreferredCanvasFormat()`. */
  format?: GPUTextureFormat;
  powerPreference?: GPUPowerPreference;
  canvasOptions?: WebGpuCanvasOptions;
  onRuntimeError?: (error: GpuRuntimeError) => void;
}

export interface WebGpuSession {
  adapter: GPUAdapter;
  device: GPUDevice;
  /** The primary canvas's context, or the offscreen target bootstrap was given. */
  context: PresentationTarget;
  format: GPUTextureFormat;
  adapterReport: GpuAdapterReport;
  capabilities: WebGpuCapabilityReport;
  /** True when `timestamp-query` was requested and granted on the device. */
  timestampQueryAvailable: boolean;
  /** Whether the UA accepts `hdr-extended` presentation (probed once at bootstrap). */
  canvasHdrAvailable: boolean;
  /** Why — mirrored to `window.canvasHdrReason`. */
  canvasHdrReason: string;
  reconfigure: () => void;
  setCanvasOptions: (options: WebGpuCanvasOptions) => void;
  detach: () => void;
}

/**
 * One canvas's WebGPU session on the page's leased device: adapter and device
 * (`adapter.ts`), canvas configuration (`canvasConfig.ts`) and device
 * diagnostics (`gpuErrors.ts`). An offscreen `target` takes the canvas's
 * place through the same configure (`presentationTarget.ts`).
 */
export async function bootstrapWebGpu(options: WebGpuBootstrapOptions): Promise<WebGpuSession> {
  const fatal = getGpuFatalError();
  if (fatal) {
    throw new Error(fatal.detail ?? fatal.message);
  }
  if (!navigator.gpu) {
    throw new Error('WebGPU is not supported in this browser.');
  }

  const adapter = await requestWebGpuAdapter(options.powerPreference ?? 'high-performance');
  if (!adapter) {
    throw new Error('No WebGPU adapter found.');
  }

  const adapterInfo = await readAdapterInfo(adapter);
  const adapterReport = buildAdapterReport(adapterInfo, adapter);
  logAdapterReport(adapterReport);
  const requestedOptionalFeatures = listAvailableOptionalFeatures(adapter);

  const device = await requestWebGpuDevice(adapter, requestedOptionalFeatures);
  const capabilities = buildWebGpuCapabilityReport(adapter, device, requestedOptionalFeatures);
  const timestampQueryAvailable = capabilities.timestampQueryAvailable;
  const context = options.target ?? options.canvas?.getContext('webgpu') ?? null;
  if (!context) {
    throw new Error('Failed to get WebGPU context from canvas.');
  }

  const format = options.format ?? navigator.gpu.getPreferredCanvasFormat();
  let canvasOptions: WebGpuCanvasOptions = { ...options.canvasOptions };
  const canvasHdr = probeCanvasHdr(context, device, format);
  publishCanvasHdrBreadcrumbs(canvasHdr.available, canvasHdr.reason);
  configureWebGpuCanvas(context, device, format, canvasOptions);

  const reconfigure = () => {
    configureWebGpuCanvas(context, device, format, canvasOptions);
  };

  const setCanvasOptions = (next: WebGpuCanvasOptions) => {
    canvasOptions = { ...canvasOptions, ...next };
  };

  const detach = attachDeviceDiagnostics(device, {
    onLost: (info) => {
      if (info.reason === 'destroyed') return;
      options.onRuntimeError?.(deviceLostRuntimeError(info));
    },
    onUncapturedError: (error) => {
      console.error('[Chromashift:GPU] Uncaptured error (rendering continues):', error);
    },
  });

  return {
    adapter,
    device,
    context,
    format,
    adapterReport,
    capabilities,
    timestampQueryAvailable,
    canvasHdrAvailable: canvasHdr.available,
    canvasHdrReason: canvasHdr.reason,
    reconfigure,
    setCanvasOptions,
    detach,
  };
}
