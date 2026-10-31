/**
 * The WebGPU adapter and the page's device gate: one adapter (core, or a
 * compatibility-mode one when no core adapter is offered), at most two
 * `requestDevice` strategies, and the adapter / capability reports.
 */
import {
  CHROMASHIFT_OPTIONAL_FEATURES,
  WEBGPU_POWER_PREFERENCE_ATTEMPTS,
} from '../gpu/gpuOptions';
import {
  getGpuFatalError,
  isFatalGpuDeviceRequestError,
  markGpuFatal,
  resetGpuFatalForTests,
  toBootstrapRuntimeError,
} from '../gpu/gpuErrors';

/** WebGPU's feature levels (`requestAdapter({ featureLevel })`). */
export type GpuFeatureLevel = 'core' | 'compatibility';

export interface GpuAdapterReport {
  /** The level a device from this adapter runs at. */
  featureLevel: GpuFeatureLevel;
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
  /** The level the device was granted. */
  featureLevel: GpuFeatureLevel;
  adapterOptionalFeatures: GPUFeatureName[];
  requestedOptionalFeatures: GPUFeatureName[];
  grantedOptionalFeatures: GPUFeatureName[];
  missingRequestedFeatures: GPUFeatureName[];
  timestampQueryAvailable: boolean;
}

/**
 * Hard cap on `requestDevice` strategies per acquire. Never reset from rAF /
 * resize / React. Each strategy asks for *less* than the one before it: a
 * retry that asks for as much or more cannot succeed where its predecessor
 * failed.
 */
const MAX_DEVICE_REQUEST_STRATEGIES = 2;

export type GpuDeviceRequestStrategy =
  | 'default-limits'
  | 'no-optional-features';

/**
 * Page-lifetime GPU lease. `requestAdapter` runs once per device; `requestDevice`
 * runs at most two strategies, then either the live device is reused or the
 * fatal breaker (`gpuErrors.ts`) blocks every later call until reload. React
 * effect re-runs, ResizeObserver, and canvas-size glitches must not start
 * another acquire (#157 / #158).
 */
interface GpuDeviceGate {
  adapter: GPUAdapter | null;
  adapterPromise: Promise<GPUAdapter | null> | null;
  device: GPUDevice | null;
  devicePromise: Promise<GPUDevice> | null;
  requestAttempt: number;
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
    adapterReadyLogged: false,
    requestDeviceInfoLogged: false,
  };
}

let gpuDeviceGate: GpuDeviceGate = emptyGpuDeviceGate();

/**
 * Adapters the compatibility-mode attempt returned. A device from one runs at
 * compatibility level unless the adapter can do core
 * (`core-features-and-limits`), which its device request then asks for.
 */
const compatibilityAdapters = new WeakSet<GPUAdapter>();

/** The level each device the gate acquired was granted. */
const deviceFeatureLevels = new WeakMap<GPUDevice, GpuFeatureLevel>();

/**
 * Core's default `maxTextureDimension2D`, which the frame is sized against.
 * A compatibility-mode device defaults to 4096, so a 4K canvas's 2× export
 * or a large photo would fail validation and draw black.
 */
const CORE_MAX_TEXTURE_DIMENSION_2D = 8192;

/**
 * Drop a lost/abandoned device so Retry GPU can acquire a new one. Does not
 * reset the fatal breaker.
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
  resetGpuFatalForTests();
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
    if (fallback) {
      gpuDeviceGate.adapter = fallback;
      return fallback;
    }

    // Last, compatibility mode: what a GL ES / D3D11-class backend offers when
    // it has no core adapter. A browser without compatibility mode ignores
    // the member, so there this is the request above again.
    const compatibility = await navigator.gpu!.requestAdapter({ featureLevel: 'compatibility' });
    if (compatibility) {
      compatibilityAdapters.add(compatibility);
      gpuDeviceGate.adapter = compatibility;
    }
    return compatibility;
  })();

  return gpuDeviceGate.adapterPromise;
}

/**
 * The level a device from `adapter` runs at: core, unless the adapter came
 * from the compatibility-mode attempt and cannot do core.
 */
export function adapterFeatureLevel(adapter: GPUAdapter): GpuFeatureLevel {
  return compatibilityAdapters.has(adapter) && !adapter.features.has('core-features-and-limits')
    ? 'compatibility'
    : 'core';
}

/** The level `device` was granted; `core` for a device the gate did not acquire. */
export function deviceFeatureLevel(device: GPUDevice): GpuFeatureLevel {
  return deviceFeatureLevels.get(device) ?? 'core';
}

/**
 * The limits a device request asks for, never above the adapter's own.
 * On a core adapter that is none: the frame fits core's defaults, so asking
 * for more could only make a request fail that would otherwise succeed. On a
 * compatibility-mode adapter it is core's texture size, which the frame needs
 * (the audit in docs/gpu-bootstrap.md § Compatibility mode found every other
 * limit within compatibility's defaults), capped at what the adapter has.
 */
function deriveRequiredLimits(adapter: GPUAdapter): GPUDeviceDescriptor['requiredLimits'] {
  if (adapterFeatureLevel(adapter) === 'core') return undefined;
  return {
    maxTextureDimension2D: Math.min(adapter.limits.maxTextureDimension2D, CORE_MAX_TEXTURE_DIMENSION_2D),
  };
}

interface DeviceRequestStrategy {
  name: GpuDeviceRequestStrategy;
  requiredLimits: GPUDeviceDescriptor['requiredLimits'];
  features: GPUFeatureName[];
}

/**
 * The frame's limits with the optional features, then default limits without
 * them. The frame's limits are the defaults, except on a compatibility-mode
 * adapter ({@link deriveRequiredLimits}). A compatibility adapter that can do
 * core asks for `core-features-and-limits` in both, which makes the device core.
 */
function buildDeviceRequestStrategies(
  adapter: GPUAdapter,
  requestedFeatures: GPUFeatureName[],
): DeviceRequestStrategy[] {
  const levelFeatures: GPUFeatureName[] = compatibilityAdapters.has(adapter)
    && adapter.features.has('core-features-and-limits')
    ? ['core-features-and-limits']
    : [];
  const requiredLimits = deriveRequiredLimits(adapter);
  const strategies: DeviceRequestStrategy[] = [
    { name: 'default-limits', requiredLimits, features: [...levelFeatures, ...requestedFeatures] },
  ];
  if (requestedFeatures.length > 0 || requiredLimits) {
    strategies.push({ name: 'no-optional-features', requiredLimits: undefined, features: levelFeatures });
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
  const strategies = buildDeviceRequestStrategies(adapter, [...requiredFeatures]);

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
      const device = await adapter.requestDevice(descriptor);
      deviceFeatureLevels.set(
        device,
        compatibilityAdapters.has(adapter) && !device.features.has('core-features-and-limits') ? 'compatibility' : 'core',
      );
      return device;
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
  const fatal = getGpuFatalError();
  if (fatal) {
    throw new Error(fatal.detail ?? fatal.message);
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
    featureLevel: deviceFeatureLevel(device),
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
    featureLevel: adapterFeatureLevel(adapter),
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
