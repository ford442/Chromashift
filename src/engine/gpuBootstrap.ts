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

export interface WebGpuCapabilityReport {
  adapterOptionalFeatures: GPUFeatureName[];
  requestedOptionalFeatures: GPUFeatureName[];
  grantedOptionalFeatures: GPUFeatureName[];
  missingRequestedFeatures: GPUFeatureName[];
  timestampQueryAvailable: boolean;
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
  capabilities: WebGpuCapabilityReport;
  /** True when `timestamp-query` was requested and granted on the device. */
  timestampQueryAvailable: boolean;
  reconfigure: () => void;
  setCanvasOptions: (options: WebGpuCanvasOptions) => void;
  detach: () => void;
}

type SupportedLimits = GPUAdapter['limits'];

/** Floor for canvas-derived `requiredLimits` so a collapsed 150px layout cannot reshape a device. */
export const MIN_DEVICE_TEXTURE_DIMENSION = 256;

/** Hard cap on `requestDevice` strategies per acquire. Never reset from rAF / resize / React. */
export const MAX_DEVICE_REQUEST_STRATEGIES = 3;

export type GpuDeviceRequestStrategy =
  | 'default-limits'
  | 'canvas-limits'
  | 'no-optional-features';

export interface DeriveRequiredLimitsOptions {
  targetMaxTexture?: number;
  /** When true, request up to 8K texture headroom; when false, only canvas size (safer for requestDevice). */
  requestHeadroom?: boolean;
}

/**
 * Page-lifetime GPU lease. `requestAdapter` runs once; `requestDevice` runs at
 * most three strategies, then either the live device is reused or `gpuFatal`
 * blocks every later call until reload. React effect re-runs, ResizeObserver,
 * and canvas-size glitches must not start another acquire (#157 / #158).
 */
interface GpuDeviceGate {
  adapter: GPUAdapter | null;
  adapterPromise: Promise<GPUAdapter | null> | null;
  device: GPUDevice | null;
  devicePromise: Promise<GPUDevice> | null;
  requestAttempt: number;
  fatal: GpuRuntimeError | null;
  adapterReadyLogged: boolean;
  requestDeviceInfoLogged: boolean;
}

function emptyGpuDeviceGate(): GpuDeviceGate {
  return {
    adapter: null,
    adapterPromise: null,
    device: null,
    devicePromise: null,
    requestAttempt: 0,
    fatal: null,
    adapterReadyLogged: false,
    requestDeviceInfoLogged: false,
  };
}

let gpuDeviceGate: GpuDeviceGate = emptyGpuDeviceGate();

export function getGpuFatalError(): GpuRuntimeError | null {
  return gpuDeviceGate.fatal;
}

function markGpuFatal(error: GpuRuntimeError): void {
  gpuDeviceGate.fatal ??= error;
}

/** Drop a lost/abandoned device so Retry GPU can acquire a new one. Does not clear `gpuFatal`. */
export function releasePageGpuDevice(): void {
  gpuDeviceGate.device = null;
  gpuDeviceGate.devicePromise = null;
  gpuDeviceGate.requestAttempt = 0;
  gpuDeviceGate.requestDeviceInfoLogged = false;
}

/** Test-only: restore the page gate so Vitest cases do not share a live device. */
export function resetGpuDeviceGateForTests(): void {
  gpuDeviceGate = emptyGpuDeviceGate();
}

export function deriveRequiredLimits(
  adapterLimits: SupportedLimits,
  canvasPixelWidth: number,
  canvasPixelHeight: number,
  targetMaxTextureOrOptions: number | DeriveRequiredLimitsOptions = { requestHeadroom: false },
): GPUDeviceDescriptor['requiredLimits'] {
  const options = typeof targetMaxTextureOrOptions === 'number'
    ? { targetMaxTexture: targetMaxTextureOrOptions, requestHeadroom: true }
    : { requestHeadroom: false, ...targetMaxTextureOrOptions };
  const targetMaxTexture = options.targetMaxTexture ?? CHROMASHIFT_TARGET_MAX_TEXTURE;
  const requestHeadroom = options.requestHeadroom ?? false;

  const longestEdge = Math.max(MIN_DEVICE_TEXTURE_DIMENSION, canvasPixelWidth, canvasPixelHeight);
  const desiredMax = requestHeadroom
    ? Math.max(longestEdge, Math.min(targetMaxTexture, adapterLimits.maxTextureDimension2D))
    : longestEdge;
  const maxTextureDimension2D = Math.min(adapterLimits.maxTextureDimension2D, desiredMax);

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

export async function requestWebGpuAdapter(
  powerPreference: GPUPowerPreference = 'high-performance',
): Promise<GPUAdapter | null> {
  if (gpuDeviceGate.adapter) return gpuDeviceGate.adapter;
  if (gpuDeviceGate.adapterPromise) return gpuDeviceGate.adapterPromise;

  gpuDeviceGate.adapterPromise = (async () => {
    const attempts: GPUPowerPreference[] = powerPreference === 'high-performance'
      ? ['high-performance', 'low-power']
      : [powerPreference, 'high-performance'];

    for (const preference of attempts) {
      const adapter = await navigator.gpu!.requestAdapter({ powerPreference: preference });
      if (adapter) {
        gpuDeviceGate.adapter = adapter;
        return adapter;
      }
    }

    const fallback = await navigator.gpu!.requestAdapter();
    if (fallback) gpuDeviceGate.adapter = fallback;
    return fallback;
  })();

  return gpuDeviceGate.adapterPromise;
}

/** D3D12 queue create OOM and similar — further requestDevice attempts make it worse. */
export function isFatalGpuDeviceRequestError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /E_OUTOFMEMORY|0x8007000E|create command queue|out of memory/i.test(message);
}

interface DeviceRequestStrategy {
  name: GpuDeviceRequestStrategy;
  requiredLimits: GPUDeviceDescriptor['requiredLimits'];
  features: GPUFeatureName[];
}

function buildDeviceRequestStrategies(
  adapter: GPUAdapter,
  canvasPixelWidth: number,
  canvasPixelHeight: number,
  targetMaxTexture: number | undefined,
  requestedFeatures: GPUFeatureName[],
): DeviceRequestStrategy[] {
  const canvasLimits = deriveRequiredLimits(
    adapter.limits,
    canvasPixelWidth,
    canvasPixelHeight,
    { targetMaxTexture, requestHeadroom: false },
  );
  const strategies: DeviceRequestStrategy[] = [
    { name: 'default-limits', requiredLimits: undefined, features: requestedFeatures },
    { name: 'canvas-limits', requiredLimits: canvasLimits, features: requestedFeatures },
  ];
  if (requestedFeatures.length > 0) {
    strategies.push({
      name: 'no-optional-features',
      requiredLimits: canvasLimits,
      features: [],
    });
  }
  return strategies.slice(0, MAX_DEVICE_REQUEST_STRATEGIES);
}

function logDeviceRequest(
  attempt: number,
  strategy: GpuDeviceRequestStrategy,
  requiredLimits: GPUDeviceDescriptor['requiredLimits'],
  features: readonly GPUFeatureName[],
): void {
  const payload = {
    attempt,
    strategy,
    requiredLimits,
    requiredFeatures: [...features],
  };
  if (!gpuDeviceGate.requestDeviceInfoLogged) {
    gpuDeviceGate.requestDeviceInfoLogged = true;
    console.info('[Chromashift:GPU] requestDevice', payload);
    return;
  }
  console.debug('[Chromashift:GPU] requestDevice', payload);
}

async function acquireWebGpuDevice(
  adapter: GPUAdapter,
  canvasPixelWidth: number,
  canvasPixelHeight: number,
  targetMaxTexture: number | undefined,
  requiredFeatures: readonly GPUFeatureName[],
): Promise<GPUDevice> {
  const requestedFeatures = [...requiredFeatures];
  const strategies = buildDeviceRequestStrategies(
    adapter,
    canvasPixelWidth,
    canvasPixelHeight,
    targetMaxTexture,
    requestedFeatures,
  );

  let lastError: unknown;
  for (const strategy of strategies) {
    gpuDeviceGate.requestAttempt += 1;
    const attempt = gpuDeviceGate.requestAttempt;
    logDeviceRequest(attempt, strategy.name, strategy.requiredLimits, strategy.features);

    const descriptor: GPUDeviceDescriptor = {
      ...(strategy.requiredLimits ? { requiredLimits: strategy.requiredLimits } : {}),
      ...(strategy.features.length > 0 ? { requiredFeatures: strategy.features } : {}),
    };

    try {
      return await adapter.requestDevice(descriptor);
    } catch (error) {
      lastError = error;
      console.error('[Chromashift:GPU] requestDevice failed', {
        attempt,
        strategy: strategy.name,
        requiredLimits: strategy.requiredLimits,
        requiredFeatures: [...strategy.features],
      }, error);
      if (isFatalGpuDeviceRequestError(error)) {
        markGpuFatal(toBootstrapRuntimeError(error));
        throw error;
      }
    }
  }

  const fatal = toBootstrapRuntimeError(lastError ?? new Error('WebGPU device request failed.'));
  markGpuFatal(fatal);
  throw lastError ?? new Error(fatal.message);
}

export async function requestWebGpuDevice(
  adapter: GPUAdapter,
  canvasPixelWidth: number,
  canvasPixelHeight: number,
  targetMaxTexture?: number,
  requiredFeatures: readonly GPUFeatureName[] = [],
): Promise<GPUDevice> {
  if (gpuDeviceGate.fatal) {
    throw new Error(gpuDeviceGate.fatal.detail ?? gpuDeviceGate.fatal.message);
  }
  if (gpuDeviceGate.device) {
    return gpuDeviceGate.device;
  }
  if (gpuDeviceGate.devicePromise) {
    return gpuDeviceGate.devicePromise;
  }

  const pending = acquireWebGpuDevice(
    adapter,
    canvasPixelWidth,
    canvasPixelHeight,
    targetMaxTexture,
    requiredFeatures,
  );
  gpuDeviceGate.devicePromise = pending;
  try {
    const device = await pending;
    gpuDeviceGate.device = device;
    return device;
  } finally {
    if (gpuDeviceGate.devicePromise === pending) {
      gpuDeviceGate.devicePromise = null;
    }
  }
}

export function listAvailableOptionalFeatures(adapter: GPUAdapter): GPUFeatureName[] {
  return CHROMASHIFT_OPTIONAL_FEATURES.filter((feature) => adapter.features.has(feature));
}

export function buildWebGpuCapabilityReport(
  adapter: GPUAdapter,
  device: GPUDevice,
  requestedOptionalFeatures: readonly GPUFeatureName[],
): WebGpuCapabilityReport {
  const adapterOptionalFeatures = listAvailableOptionalFeatures(adapter);
  const grantedOptionalFeatures = requestedOptionalFeatures.filter((feature) => device.features.has(feature));
  const missingRequestedFeatures = requestedOptionalFeatures.filter((feature) => !device.features.has(feature));
  return {
    adapterOptionalFeatures,
    requestedOptionalFeatures: [...requestedOptionalFeatures],
    grantedOptionalFeatures,
    missingRequestedFeatures,
    timestampQueryAvailable: grantedOptionalFeatures.includes('timestamp-query'),
  };
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
  if (gpuDeviceGate.adapterReadyLogged) return;
  gpuDeviceGate.adapterReadyLogged = true;
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
  };

  if (options?.toneMappingMode) {
    config.toneMapping = { mode: options.toneMappingMode };
  }

  return config;
}

export function configureWebGpuCanvas(
  context: GPUCanvasContext,
  device: GPUDevice,
  format: GPUTextureFormat,
  options?: WebGpuCanvasOptions,
): void {
  try {
    context.configure(buildWebGpuCanvasConfiguration(device, format, {
      ...options,
      toneMappingMode: options?.toneMappingMode ?? 'standard',
    }));
  } catch (error) {
    console.warn('[Chromashift:GPU] Canvas configure with tone mapping failed, retrying without', error);
    context.configure(buildWebGpuCanvasConfiguration(device, format, options));
  }
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

export function uncapturedRuntimeError(error: GPUError): GpuRuntimeError {
  return {
    kind: 'uncaptured',
    message: 'Uncaptured WebGPU error',
    detail: error.message,
    recoverable: false,
  };
}

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

  const canvasPixelWidth = Math.max(1, options.canvas.width);
  const canvasPixelHeight = Math.max(1, options.canvas.height);
  const requiredLimits = deriveRequiredLimits(
    adapter.limits,
    canvasPixelWidth,
    canvasPixelHeight,
    { targetMaxTexture: options.targetMaxTexture, requestHeadroom: false },
  );

  const adapterInfo = await readAdapterInfo(adapter);
  const adapterReport = buildAdapterReport(adapterInfo, adapter);
  logAdapterReport(adapterReport, requiredLimits);
  const requestedOptionalFeatures = listAvailableOptionalFeatures(adapter);

  const device = await requestWebGpuDevice(
    adapter,
    canvasPixelWidth,
    canvasPixelHeight,
    options.targetMaxTexture,
    requestedOptionalFeatures,
  );
  const capabilities = buildWebGpuCapabilityReport(adapter, device, requestedOptionalFeatures);
  const timestampQueryAvailable = capabilities.timestampQueryAvailable;
  const context = options.canvas.getContext('webgpu');
  if (!context) {
    throw new Error('Failed to get WebGPU context from canvas.');
  }

  const format = navigator.gpu.getPreferredCanvasFormat();
  let canvasOptions: WebGpuCanvasOptions = { ...options.canvasOptions };
  configureWebGpuCanvas(context, device, format, canvasOptions);

  const reconfigure = () => {
    configureWebGpuCanvas(context, device, format, canvasOptions);
  };

  const setCanvasOptions = (next: WebGpuCanvasOptions) => {
    canvasOptions = { ...canvasOptions, ...next };
  };

  const detach = attachDeviceDiagnostics(device, {
    onLost: (info) => {
      releasePageGpuDevice();
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
    reconfigure,
    setCanvasOptions,
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
