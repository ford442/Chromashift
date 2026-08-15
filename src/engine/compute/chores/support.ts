/**
 * `gpu-chores` — device/support detection for the WebGPU lane.
 *
 * Extracted verbatim from `src/engine/compute/computeSupport.ts` (which now
 * re-exports this module), plus the kill switch and the adapter breadcrumbs
 * needed to tell a Chrome failure apart from an Edge failure after the fact.
 */

export interface GpuComputeSupport {
  /** Compute shaders can run on this device. */
  available: boolean;
  /** Human-readable reason when unavailable. */
  reason: string | null;
  /** Max 2D texture edge the device reports. */
  maxTextureDimension2D: number;
}

/** Diagnostic detail published alongside the support verdict. */
export interface GpuComputeDiagnostics {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
  features: string[];
  limits: {
    maxTextureDimension2D: number;
    maxComputeWorkgroupSizeX: number;
    maxComputeWorkgroupSizeY: number;
    maxComputeInvocationsPerWorkgroup: number;
    maxStorageBufferBindingSize: number;
  };
}

/** URL kill switch: `?no_gpu_compute` forces the WebGPU lane closed. */
export const NO_GPU_COMPUTE_PARAM = 'no_gpu_compute';

export function isGpuComputeDisabledByFlag(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).has(NO_GPU_COMPUTE_PARAM);
  } catch {
    return false;
  }
}

export function detectGpuComputeSupport(device: GPUDevice | null): GpuComputeSupport {
  if (!device) {
    return { available: false, reason: 'No GPU device', maxTextureDimension2D: 0 };
  }

  const maxTextureDimension2D = device.limits.maxTextureDimension2D;

  // Checked before the limits gate so the switch reports itself rather than
  // masquerading as a capability problem.
  if (isGpuComputeDisabledByFlag()) {
    return {
      available: false,
      reason: `Disabled by ?${NO_GPU_COMPUTE_PARAM}`,
      maxTextureDimension2D,
    };
  }

  if (maxTextureDimension2D < 1) {
    return {
      available: false,
      reason: 'Invalid maxTextureDimension2D',
      maxTextureDimension2D,
    };
  }

  // All conformant WebGPU implementations expose compute; we only gate on limits.
  return { available: true, reason: null, maxTextureDimension2D };
}

export function canAnalyzeTexture(
  support: GpuComputeSupport,
  width: number,
  height: number,
): boolean {
  if (!support.available) return false;
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  return w <= support.maxTextureDimension2D && h <= support.maxTextureDimension2D;
}

export function isSrgbTextureFormat(format: GPUTextureFormat): boolean {
  return format === 'rgba8unorm-srgb' || format === 'bgra8unorm-srgb';
}

/**
 * Snapshot adapter identity + compute limits from the device.
 *
 * `GPUDevice.adapterInfo` is the spec-current accessor and is read
 * defensively: older Chrome/Edge builds expose it inconsistently, and this
 * must never be the thing that throws inside bootstrap.
 */
export function readGpuComputeDiagnostics(device: GPUDevice | null): GpuComputeDiagnostics | null {
  if (!device) return null;
  let info: Partial<GPUAdapterInfo> = {};
  try {
    info = (device as GPUDevice & { adapterInfo?: GPUAdapterInfo }).adapterInfo ?? {};
  } catch {
    info = {};
  }

  let features: string[] = [];
  try {
    features = [...device.features];
  } catch {
    features = [];
  }

  // Diagnostics must never be the thing that breaks bootstrap, so every
  // limit is read through a partial view rather than assumed present.
  const limits = (device.limits ?? {}) as Partial<GPUSupportedLimits>;
  return {
    vendor: info.vendor ?? 'unknown',
    architecture: info.architecture ?? 'unknown',
    device: info.device ?? 'unknown',
    description: info.description ?? 'unknown',
    features,
    limits: {
      maxTextureDimension2D: limits.maxTextureDimension2D ?? 0,
      maxComputeWorkgroupSizeX: limits.maxComputeWorkgroupSizeX ?? 0,
      maxComputeWorkgroupSizeY: limits.maxComputeWorkgroupSizeY ?? 0,
      maxComputeInvocationsPerWorkgroup: limits.maxComputeInvocationsPerWorkgroup ?? 0,
      maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize ?? 0,
    },
  };
}

/** Publish breadcrumbs for automation / diagnostics. */
export function publishGpuComputeBreadcrumbs(
  support: GpuComputeSupport,
  diagnostics: GpuComputeDiagnostics | null = null,
): void {
  if (typeof window === 'undefined') return;
  const w = window as Window & {
    gpuComputeAvailable?: boolean;
    gpuComputeReason?: string | null;
    gpuComputeDiagnostics?: GpuComputeDiagnostics | null;
  };
  w.gpuComputeAvailable = support.available;
  w.gpuComputeReason = support.reason;
  if (diagnostics !== null) w.gpuComputeDiagnostics = diagnostics;
}

/** Record which lane actually served the last job, and why others did not. */
export function publishChoreBreadcrumbs(backend: string | null, reason: string | null): void {
  if (typeof window === 'undefined') return;
  const w = window as Window & {
    gpuChoreBackend?: string | null;
    gpuChoreReason?: string | null;
  };
  w.gpuChoreBackend = backend;
  w.gpuChoreReason = reason;
}
