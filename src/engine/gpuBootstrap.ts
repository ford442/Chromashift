import {
  CHROMASHIFT_OPTIONAL_FEATURES,
  WEBGPU_POWER_PREFERENCE_ATTEMPTS,
  WEBGL2_POWER_PREFERENCE_ATTEMPTS,
  HDR_CANVAS_FORMAT,
  getWebGL2ContextAttributes,
  type CanvasPresentation,
  type RendererCanvasOptions,
} from './gpuOptions';
import { publishDiagnostics } from './diagnostics';

export type GpuErrorKind = 'bootstrap' | 'device-lost' | 'uncaptured' | 'pipeline';

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
  /**
   * `hdr-extended` configures an `rgba16float` canvas with extended tone
   * mapping; `sdr` (the default) is the preferred format clipped at white.
   * Falls back to `sdr` wherever the UA cannot honour it.
   */
  presentation?: CanvasPresentation;
}

export interface WebGpuBootstrapOptions extends RendererCanvasOptions {
  canvas: HTMLCanvasElement;
  powerPreference?: GPUPowerPreference;
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
  /** Whether the UA accepts `hdr-extended` presentation (probed once at bootstrap). */
  canvasHdrAvailable: boolean;
  /** Why — mirrored to `window.canvasHdrReason`. */
  canvasHdrReason: string;
  reconfigure: () => void;
  setCanvasOptions: (options: WebGpuCanvasOptions) => void;
  detach: () => void;
}

/**
 * Hard cap on `requestDevice` strategies per acquire. Never reset from rAF /
 * resize / React. Each strategy asks for *less* than the one before it: a
 * retry that asks for as much or more cannot succeed where its predecessor
 * failed.
 */
export const MAX_DEVICE_REQUEST_STRATEGIES = 2;

export type GpuDeviceRequestStrategy =
  | 'default-limits'
  | 'no-optional-features';

/**
 * Page-lifetime GPU lease. `requestAdapter` runs once per device; `requestDevice`
 * runs at most two strategies, then either the live device is reused or
 * `gpuFatal` blocks every later call until reload. React effect re-runs, ResizeObserver,
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

/**
 * Drop a lost/abandoned device so Retry GPU can acquire a new one. Does not
 * clear `gpuFatal`.
 *
 * The adapter goes with it: an adapter that has produced a device is
 * *consumed*, and a second `requestDevice` on it is refused — so a retry on
 * the cached adapter failed every strategy and then marked the GPU fatal.
 */
export function releasePageGpuDevice(): void {
  gpuDeviceGate.adapter = null;
  gpuDeviceGate.adapterPromise = null;
  gpuDeviceGate.device = null;
  gpuDeviceGate.devicePromise = null;
  gpuDeviceGate.requestAttempt = 0;
  gpuDeviceGate.requestDeviceInfoLogged = false;
}

/** Test-only: restore the page gate so Vitest cases do not share a live device. */
export function resetGpuDeviceGateForTests(): void {
  gpuDeviceGate = emptyGpuDeviceGate();
}

export async function requestWebGpuAdapter(
  powerPreference: GPUPowerPreference = 'high-performance',
): Promise<GPUAdapter | null> {
  if (gpuDeviceGate.adapter) return gpuDeviceGate.adapter;
  if (gpuDeviceGate.adapterPromise) return gpuDeviceGate.adapterPromise;

  gpuDeviceGate.adapterPromise = (async () => {
    // Adapter attempts, documented beside the list in gpuOptions.ts. Distinct
    // from the three requestDevice strategies below (MAX_DEVICE_REQUEST_STRATEGIES).
    const attempts: GPUPowerPreference[] = WEBGPU_POWER_PREFERENCE_ATTEMPTS.includes(
      powerPreference as (typeof WEBGPU_POWER_PREFERENCE_ATTEMPTS)[number],
    )
      ? [powerPreference, ...WEBGPU_POWER_PREFERENCE_ATTEMPTS.filter((p) => p !== powerPreference)]
      : [powerPreference, ...WEBGPU_POWER_PREFERENCE_ATTEMPTS];

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

/**
 * Default limits with the optional features, then default limits without
 * them. Limits are never raised: the frame fits the defaults, so asking for
 * more could only make a request fail that would otherwise succeed.
 */
function buildDeviceRequestStrategies(requestedFeatures: GPUFeatureName[]): DeviceRequestStrategy[] {
  const strategies: DeviceRequestStrategy[] = [
    { name: 'default-limits', requiredLimits: undefined, features: requestedFeatures },
  ];
  if (requestedFeatures.length > 0) {
    strategies.push({ name: 'no-optional-features', requiredLimits: undefined, features: [] });
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
  requiredFeatures: readonly GPUFeatureName[],
): Promise<GPUDevice> {
  const strategies = buildDeviceRequestStrategies([...requiredFeatures]);

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

  const pending = acquireWebGpuDevice(adapter, requiredFeatures);
  gpuDeviceGate.devicePromise = pending;
  try {
    const device = await pending;
    gpuDeviceGate.device = device;
    // The page lease lets go of a lost device itself, once — not through each
    // bootstrap's listener, which would leave a lost device leased whenever
    // no orchestrator happened to be alive to hear it.
    void device.lost.then(() => {
      if (gpuDeviceGate.device === device) releasePageGpuDevice();
    });
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

/**
 * `requestAdapterInfo()` was removed from the spec in favour of `adapter.info`,
 * so `@webgpu/types` no longer declares it — but Chromium before `info` has
 * only this.
 */
type LegacyInfoAdapter = GPUAdapter & { requestAdapterInfo?: () => Promise<GPUAdapterInfo> };

export async function readAdapterInfo(adapter: GPUAdapter): Promise<GPUAdapterInfo> {
  // Typed as always present; absent on browsers that predate it.
  const info = adapter.info as GPUAdapterInfo | undefined;
  if (info) return info;
  const legacy = adapter as LegacyInfoAdapter;
  if (typeof legacy.requestAdapterInfo === 'function') {
    return legacy.requestAdapterInfo();
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

export function logAdapterReport(report: GpuAdapterReport): void {
  if (gpuDeviceGate.adapterReadyLogged) return;
  gpuDeviceGate.adapterReadyLogged = true;
  console.info('[Chromashift:GPU] Adapter ready', {
    ...report,
    optionalFeatures: CHROMASHIFT_OPTIONAL_FEATURES.filter((f) => report.features.includes(f)),
  });
}

export function buildWebGpuCanvasConfiguration(
  device: GPUDevice,
  format: GPUTextureFormat,
  options?: WebGpuCanvasOptions,
): GPUCanvasConfiguration {
  const hdr = options?.presentation === 'hdr-extended';
  const config: GPUCanvasConfiguration = {
    device,
    format: hdr ? HDR_CANVAS_FORMAT : format,
    alphaMode: 'opaque',
    // Render target only. Nothing copies out of the swap chain — previews,
    // exports and the collision-stats blit all read offscreen targets — and
    // an unused COPY_SRC can keep the compositor off its scanout path.
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
    colorSpace: options?.colorSpace ?? 'srgb',
  };

  if (hdr) {
    config.toneMapping = { mode: 'extended' };
  } else if (options?.toneMappingMode) {
    config.toneMapping = { mode: options.toneMappingMode };
  }

  return config;
}

/**
 * Page-lifetime capability bit for canvas tone mapping.
 *
 * `null` = not yet determined. Chromashift reconfigures the canvas on every
 * resize, DPR change, and Display-P3 toggle, so the old catch-and-retry cost a
 * thrown exception *per configure* on a browser without tone mapping. Both the
 * probe and the cache exist so the common path — every configure after the
 * first — decides from a boolean.
 */
let canvasToneMappingSupported: boolean | null = null;

/**
 * The same page-lifetime bit for `hdr-extended` (an `rgba16float` canvas with
 * `toneMapping: 'extended'`), so a refused HDR configure is not retried on
 * every resize either.
 */
let canvasHdrSupported: boolean | null = null;

/** Test-only: forget the probed capability so cases do not leak into each other. */
export function resetCanvasToneMappingSupportForTests(): void {
  canvasToneMappingSupported = null;
  canvasHdrSupported = null;
}

/** What the HDR probe concluded, or `null` before one ran. */
export function getCanvasHdrSupport(): boolean | null {
  return canvasHdrSupported;
}

/** What the probe concluded, or `null` before any canvas has been configured. */
export function getCanvasToneMappingSupport(): boolean | null {
  return canvasToneMappingSupported;
}

/**
 * Feature-detect tone mapping without provoking an exception, where the browser
 * lets us: `getConfiguration()` (Chrome 131+) echoes back the applied
 * configuration, so a `toneMapping` that the UA dropped as an unknown
 * dictionary member is visible as an absent key.
 *
 * Returns `null` when the browser gives us nothing to read, in which case the
 * caller falls back to configure-and-catch — once.
 */
function probeToneMappingFromConfiguration(
  context: GPUCanvasContext,
  mode: GPUCanvasToneMappingMode = 'standard',
  format?: GPUTextureFormat,
): boolean | null {
  const readConfiguration = (context as GPUCanvasContext & {
    getConfiguration?: () => GPUCanvasConfiguration | null;
  }).getConfiguration;
  if (typeof readConfiguration !== 'function') return null;
  try {
    const applied = readConfiguration.call(context);
    if (!applied) return null;
    return applied.toneMapping?.mode === mode && (format === undefined || applied.format === format);
  } catch {
    return null;
  }
}

/**
 * Configure for `hdr-extended`. Returns false (leaving the canvas unconfigured
 * for the caller's SDR configure) when the UA throws or silently drops the
 * format or tone mapping. The result is cached either way.
 */
function tryConfigureHdrCanvas(
  context: GPUCanvasContext,
  device: GPUDevice,
  format: GPUTextureFormat,
  options: WebGpuCanvasOptions,
): boolean {
  if (canvasHdrSupported === false) return false;
  try {
    context.configure(buildWebGpuCanvasConfiguration(device, format, options));
  } catch (error) {
    canvasHdrSupported = false;
    console.warn('[Chromashift:GPU] Canvas HDR configure failed; presenting SDR', error);
    return false;
  }
  if (canvasHdrSupported === null) {
    // `null` (no getConfiguration) counts as support, same as tone mapping.
    canvasHdrSupported = probeToneMappingFromConfiguration(context, 'extended', HDR_CANVAS_FORMAT) !== false;
    if (!canvasHdrSupported) {
      console.info('[Chromashift:GPU] Canvas HDR not supported; presenting SDR');
    }
  }
  return canvasHdrSupported;
}

/**
 * Configure a canvas. `presentation: 'hdr-extended'` is honoured when the UA
 * accepts it; otherwise — and always for `sdr` — the preferred format with
 * `'standard'` tone mapping. Never throws for an unsupported option, and never
 * leaves the canvas unconfigured (a black canvas). Returns the presentation
 * actually applied.
 */
export function configureWebGpuCanvas(
  context: GPUCanvasContext,
  device: GPUDevice,
  format: GPUTextureFormat,
  options?: WebGpuCanvasOptions,
): CanvasPresentation {
  if (options?.presentation === 'hdr-extended'
    && tryConfigureHdrCanvas(context, device, format, options)) {
    return 'hdr-extended';
  }
  configureSdrCanvas(context, device, format, { ...options, presentation: 'sdr' });
  return 'sdr';
}

function configureSdrCanvas(
  context: GPUCanvasContext,
  device: GPUDevice,
  format: GPUTextureFormat,
  options: WebGpuCanvasOptions,
): void {
  const requested: WebGpuCanvasOptions = {
    ...options,
    toneMappingMode: options?.toneMappingMode ?? 'standard',
  };

  // Known-unsupported: configure straight away, no tone mapping, no throw.
  if (canvasToneMappingSupported === false) {
    context.configure(buildWebGpuCanvasConfiguration(device, format, options));
    return;
  }

  // Known-supported, or not yet probed. The try/catch below can only fire on
  // the not-yet-probed pass, and its result is cached either way.
  try {
    context.configure(buildWebGpuCanvasConfiguration(device, format, requested));
  } catch (error) {
    canvasToneMappingSupported = false;
    console.warn(
      '[Chromashift:GPU] Canvas configure with tone mapping failed; '
      + 'disabling it for this page and retrying without',
      error,
    );
    context.configure(buildWebGpuCanvasConfiguration(device, format, options));
    return;
  }

  if (canvasToneMappingSupported !== null) return;

  const probed = probeToneMappingFromConfiguration(context);
  if (probed === false) {
    // The UA accepted the configure but silently dropped the member. Record it
    // so later configures skip the key entirely; the current frame is already
    // configured correctly (tone mapping simply is not applied).
    canvasToneMappingSupported = false;
    console.info('[Chromashift:GPU] Canvas tone mapping not supported; configuring without it');
    return;
  }
  // `true`, or `null` when the browser exposes no getConfiguration — treat an
  // un-thrown configure as support so the fast path is taken next time.
  canvasToneMappingSupported = true;
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
  void device.lost.then((info) => {
    if (attached) handlers.onLost?.(info);
  });

  const previous = device.onuncapturederror;
  device.onuncapturederror = (event: GPUUncapturedErrorEvent) => {
    handlers.onUncapturedError?.(event.error);
    previous?.call(device, event);
  };

  return () => {
    attached = false;
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

export function createScopedGpuError(label: string, gpuError: GPUError): Error {
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

export function uncapturedRuntimeError(error: GPUError): GpuRuntimeError {
  return {
    kind: 'uncaptured',
    message: 'Uncaptured WebGPU error',
    detail: error.message,
    recoverable: false,
  };
}

/**
 * One `hdr-extended` configure at bootstrap, so the Viewport toggle can be
 * offered (or greyed out) before anyone asks for it. Leaves the canvas
 * configured for whatever the caller configures next; never throws.
 */
export function probeCanvasHdr(
  context: GPUCanvasContext,
  device: GPUDevice,
  format: GPUTextureFormat,
): { available: boolean; reason: string } {
  const available = tryConfigureHdrCanvas(context, device, format, { presentation: 'hdr-extended' });
  if (!available) {
    return { available, reason: 'canvas toneMapping "extended" / rgba16float not supported by this browser' };
  }
  const hdrDisplay = typeof matchMedia === 'function'
    && matchMedia('(dynamic-range: high)').matches;
  return {
    available,
    reason: hdrDisplay
      ? 'extended tone mapping supported; display reports high dynamic range'
      : 'extended tone mapping supported; display reports standard dynamic range (highlights will still clip)',
  };
}

export function publishCanvasHdrBreadcrumbs(available: boolean, reason: string): void {
  publishDiagnostics({ canvasHdrAvailable: available, canvasHdrReason: reason });
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

  const adapterInfo = await readAdapterInfo(adapter);
  const adapterReport = buildAdapterReport(adapterInfo, adapter);
  logAdapterReport(adapterReport);
  const requestedOptionalFeatures = listAvailableOptionalFeatures(adapter);

  const device = await requestWebGpuDevice(adapter, requestedOptionalFeatures);
  const capabilities = buildWebGpuCapabilityReport(adapter, device, requestedOptionalFeatures);
  const timestampQueryAvailable = capabilities.timestampQueryAvailable;
  const context = options.canvas.getContext('webgpu');
  if (!context) {
    throw new Error('Failed to get WebGPU context from canvas.');
  }

  const format = navigator.gpu.getPreferredCanvasFormat();
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

/** Every `getContext('webgl2')` attempt returned null. Never retried by touching WebGPU. */
export class WebGL2UnavailableError extends Error {
  override readonly name = 'WebGL2UnavailableError';
}

/**
 * The canvas's context is lost and not yet restored. Asking `getContext` again
 * cannot help — it returns the same lost context — so recovery waits for
 * `webglcontextrestored` (see {@link watchWebGL2Context}).
 */
export class WebGL2ContextLostError extends Error {
  override readonly name = 'WebGL2ContextLostError';
}

/**
 * The context each canvas was granted. `getContext` is sticky, so a canvas has
 * at most one; remembering it is what lets a re-bootstrap after
 * `webglcontextrestored` (or a React effect re-run) reuse it without a second
 * `getContext` call.
 */
const webgl2Contexts = new WeakMap<HTMLCanvasElement, WebGL2RenderingContext>();

/**
 * The canvas's WebGL2 context: the one it already has, or the first of
 * `WEBGL2_POWER_PREFERENCE_ATTEMPTS` the browser grants. Never calls
 * `requestAdapter` — an explicit WebGL session stays explicit.
 */
export function createWebGL2Context(
  canvas: HTMLCanvasElement,
  options: RendererCanvasOptions,
): WebGL2RenderingContext {
  const existing = webgl2Contexts.get(canvas);
  if (existing) {
    if (existing.isContextLost()) {
      throw new WebGL2ContextLostError('The WebGL2 context is lost and has not been restored yet.');
    }
    return existing;
  }

  for (const [index, powerPreference] of WEBGL2_POWER_PREFERENCE_ATTEMPTS.entries()) {
    const gl = canvas.getContext('webgl2', getWebGL2ContextAttributes(options, powerPreference));
    if (!gl) continue;
    console.info('[Chromashift:GPU] WebGL2 context ready', {
      attempt: index + 1,
      powerPreference: powerPreference ?? '(omitted)',
    });
    webgl2Contexts.set(canvas, gl);
    return gl;
  }

  const tried = WEBGL2_POWER_PREFERENCE_ATTEMPTS.map((p) => p ?? 'no preference').join(', ');
  console.error(`[Chromashift:GPU] getContext('webgl2') returned null for ${tried}`);
  throw new WebGL2UnavailableError(`WebGL2 is not supported in this browser (getContext returned null for ${tried}).`);
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

/**
 * Listen for context loss on a WebGL2 canvas — the twin of
 * `attachDeviceDiagnostics`' `device.lost`. `webglcontextlost` is
 * `preventDefault()`ed, without which the browser never restores the context.
 * Returns the detach.
 */
export function watchWebGL2Context(
  canvas: HTMLCanvasElement,
  handlers: { onLost: () => void; onRestored: () => void },
): () => void {
  const lost = (event: Event) => {
    event.preventDefault();
    console.warn('[Chromashift:GPU] WebGL2 context lost');
    handlers.onLost();
  };
  const restored = () => {
    console.info('[Chromashift:GPU] WebGL2 context restored');
    handlers.onRestored();
  };
  canvas.addEventListener('webglcontextlost', lost);
  canvas.addEventListener('webglcontextrestored', restored);
  return () => {
    canvas.removeEventListener('webglcontextlost', lost);
    canvas.removeEventListener('webglcontextrestored', restored);
  };
}
