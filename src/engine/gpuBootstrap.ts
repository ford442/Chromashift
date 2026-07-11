import {
  CHROMASHIFT_OPTIONAL_FEATURES,
  CHROMASHIFT_TARGET_MAX_TEXTURE,
  getWebGL2ContextAttributes,
  type RendererCanvasOptions,
} from './gpuOptions';

export type GpuErrorKind = 'bootstrap' | 'device-lost' | 'uncaptured';

export interface GpuRuntimeError {
  kind: GpuErrorKind;
  message: string;
  detail?: string;
  recoverable: boolean;
}

export interface GpuAdapterReport {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
  features: string[];
  limits: {
    maxTextureDimension2D: number;
    maxBufferSize: number;
    maxColorAttachmentBytesPerSample: number;
  };
}

export interface WebGpuCanvasOptions {
  colorSpace?: PredefinedColorSpace;
  toneMappingMode?: GPUCanvasToneMappingMode;
}

export interface WebGpuBootstrapOptions extends RendererCanvasOptions {
  canvas: HTMLCanvasElement;
  powerPreference?: GPUPowerPreference;
  targetMaxTexture?: number;
  canvasOptions?: WebGpuCanvasOptions;
  onRuntimeError?: (error: GpuRuntimeError) => void;
}

export interface WebGpuSession {
  adapter: GPUAdapter;
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  adapterReport: GpuAdapterReport;
  /** True when `timestamp-query` was requested and granted on the device. */
  timestampQueryAvailable: boolean;
  reconfigure: () => void;
  detach: () => void;
}

type SupportedLimits = GPUAdapter['limits'];

export function deriveRequiredLimits(
  adapterLimits: SupportedLimits,
  canvasPixelWidth: number,
  canvasPixelHeight: number,
  targetMaxTexture = CHROMASHIFT_TARGET_MAX_TEXTURE,
): GPUDeviceDescriptor['requiredLimits'] {
  const longestEdge = Math.max(1, canvasPixelWidth, canvasPixelHeight);
  const maxTextureDimension2D = Math.min(
    adapterLimits.maxTextureDimension2D,
    Math.max(longestEdge, Math.min(targetMaxTexture, adapterLimits.maxTextureDimension2D)),
  );

  return {
    maxTextureDimension2D,
    maxTextureDimension1D: Math.min(adapterLimits.maxTextureDimension1D, maxTextureDimension2D),
    maxBufferSize: Math.min(adapterLimits.maxBufferSize, 256 * 1024 * 1024),
    maxStorageBufferBindingSize: Math.min(adapterLimits.maxStorageBufferBindingSize, 64 * 1024 * 1024),
    maxUniformBufferBindingSize: Math.min(adapterLimits.maxUniformBufferBindingSize, 64 * 1024),
    maxColorAttachments: Math.min(adapterLimits.maxColorAttachments, 8),
    maxColorAttachmentBytesPerSample: adapterLimits.maxColorAttachmentBytesPerSample,
  };
}

export function listAvailableOptionalFeatures(adapter: GPUAdapter): GPUFeatureName[] {
  return CHROMASHIFT_OPTIONAL_FEATURES.filter((feature) => adapter.features.has(feature));
}

export async function readAdapterInfo(adapter: GPUAdapter): Promise<GPUAdapterInfo> {
  if ('info' in adapter) {
    const info = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info;
    if (info) return info;
  }
  if (typeof adapter.requestAdapterInfo === 'function') {
    return adapter.requestAdapterInfo();
  }
  return {
    vendor: 'unknown',
    architecture: 'unknown',
    device: 'unknown',
    description: 'unknown',
    isFallbackAdapter: false,
  } as GPUAdapterInfo;
}

export function buildAdapterReport(
  adapterInfo: GPUAdapterInfo,
  adapter: GPUAdapter,
): GpuAdapterReport {
  return {
    vendor: adapterInfo.vendor,
    architecture: adapterInfo.architecture,
    device: adapterInfo.device,
    description: adapterInfo.description,
    features: [...adapter.features],
    limits: {
      maxTextureDimension2D: adapter.limits.maxTextureDimension2D,
      maxBufferSize: adapter.limits.maxBufferSize,
      maxColorAttachmentBytesPerSample: adapter.limits.maxColorAttachmentBytesPerSample,
    },
  };
}

export function logAdapterReport(report: GpuAdapterReport, requiredLimits: GPUDeviceDescriptor['requiredLimits']): void {
  console.info('[Chromashift:GPU] Adapter ready', {
    ...report,
    requiredLimits,
    optionalFeatures: CHROMASHIFT_OPTIONAL_FEATURES.filter((f) => report.features.includes(f)),
  });
}

export function buildWebGpuCanvasConfiguration(
  device: GPUDevice,
  format: GPUTextureFormat,
  options?: WebGpuCanvasOptions,
): GPUCanvasConfiguration {
  const config: GPUCanvasConfiguration = {
    device,
    format,
    alphaMode: 'opaque',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    colorSpace: options?.colorSpace ?? 'srgb',
    toneMapping: { mode: options?.toneMappingMode ?? 'standard' },
  };

  return config;
}

export function configureWebGpuCanvas(
  context: GPUCanvasContext,
  device: GPUDevice,
  format: GPUTextureFormat,
  options?: WebGpuCanvasOptions,
): void {
  context.configure(buildWebGpuCanvasConfiguration(device, format, options));
}

export function attachDeviceDiagnostics(
  device: GPUDevice,
  handlers: {
    onLost?: (info: GPUDeviceLostInfo) => void;
    onUncapturedError?: (error: GPUError) => void;
  },
): () => void {
  void device.lost.then((info) => {
    handlers.onLost?.(info);
  });

  const previous = device.onuncapturederror;
  device.onuncapturederror = (event: GPUUncapturedErrorEvent) => {
    handlers.onUncapturedError?.(event.error);
    previous?.call(device, event);
  };

  return () => {
    device.onuncapturederror = previous ?? null;
  };
}

export async function withErrorScope<T>(
  device: GPUDevice,
  filter: GPUErrorFilter,
  label: string,
  work: () => T | Promise<T>,
): Promise<T> {
  device.pushErrorScope(filter);
  try {
    const result = await work();
    const scopedError = await device.popErrorScope();
    if (scopedError) {
      throw createScopedGpuError(label, scopedError);
    }
    return result;
  } catch (error) {
    await device.popErrorScope().catch(() => null);
    throw error;
  }
}

export function createScopedGpuError(label: string, gpuError: GPUError): Error {
  const err = new Error(`[WebGPU:${label}] ${gpuError.message}`);
  (err as Error & { gpuError: GPUError }).gpuError = gpuError;
  return err;
}

export function toBootstrapRuntimeError(error: unknown): GpuRuntimeError {
  const message = error instanceof Error ? error.message : String(error);
  return {
    kind: 'bootstrap',
    message,
    recoverable: true,
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

export function uncapturedRuntimeError(error: GPUError): GpuRuntimeError {
  return {
    kind: 'uncaptured',
    message: 'Uncaptured WebGPU error',
    detail: error.message,
    recoverable: false,
  };
}

export async function bootstrapWebGpu(options: WebGpuBootstrapOptions): Promise<WebGpuSession> {
  if (!navigator.gpu) {
    throw new Error('WebGPU is not supported in this browser.');
  }

  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: options.powerPreference ?? 'high-performance',
  });
  if (!adapter) {
    throw new Error('No WebGPU adapter found.');
  }

  const canvasPixelWidth = Math.max(1, options.canvas.width);
  const canvasPixelHeight = Math.max(1, options.canvas.height);
  const requiredLimits = deriveRequiredLimits(
    adapter.limits,
    canvasPixelWidth,
    canvasPixelHeight,
    options.targetMaxTexture,
  );

  const adapterInfo = await readAdapterInfo(adapter);
  const adapterReport = buildAdapterReport(adapterInfo, adapter);
  const requiredFeatures = listAvailableOptionalFeatures(adapter);
  logAdapterReport(adapterReport, requiredLimits);

  const device = await adapter.requestDevice({
    requiredLimits,
    requiredFeatures,
  });
  const timestampQueryAvailable = device.features.has('timestamp-query');
  const context = options.canvas.getContext('webgpu');
  if (!context) {
    device.destroy();
    throw new Error('Failed to get WebGPU context from canvas.');
  }

  const format = navigator.gpu.getPreferredCanvasFormat();
  const canvasOptions = options.canvasOptions;
  configureWebGpuCanvas(context, device, format, canvasOptions);

  const reconfigure = () => {
    configureWebGpuCanvas(context, device, format, canvasOptions);
  };

  const detach = attachDeviceDiagnostics(device, {
    onLost: (info) => {
      if (info.reason === 'destroyed') return;
      options.onRuntimeError?.(deviceLostRuntimeError(info));
    },
    onUncapturedError: (error) => {
      console.error('[Chromashift:GPU] Uncaptured error', error);
      options.onRuntimeError?.(uncapturedRuntimeError(error));
    },
  });

  return {
    adapter,
    device,
    context,
    format,
    adapterReport,
    timestampQueryAvailable,
    reconfigure,
    detach,
  };
}

export function createWebGL2Context(
  canvas: HTMLCanvasElement,
  options: RendererCanvasOptions,
): WebGL2RenderingContext {
  const gl = canvas.getContext('webgl2', getWebGL2ContextAttributes(options));
  if (!gl) {
    throw new Error('WebGL2 is not supported in this browser.');
  }
  return gl;
}
