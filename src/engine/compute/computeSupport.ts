/**
 * Feature detection for optional WebGPU compute image analysis.
 */

export interface GpuComputeSupport {
  /** Compute shaders can run on this device. */
  available: boolean;
  /** Human-readable reason when unavailable. */
  reason: string | null;
  /** Max 2D texture edge the device reports. */
  maxTextureDimension2D: number;
}

export function detectGpuComputeSupport(device: GPUDevice | null): GpuComputeSupport {
  if (!device) {
    return { available: false, reason: 'No GPU device', maxTextureDimension2D: 0 };
  }

  const maxTextureDimension2D = device.limits.maxTextureDimension2D;
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

/** Publish breadcrumbs for automation / diagnostics. */
export function publishGpuComputeBreadcrumbs(support: GpuComputeSupport): void {
  if (typeof window === 'undefined') return;
  const w = window as Window & {
    gpuComputeAvailable?: boolean;
    gpuComputeReason?: string | null;
  };
  w.gpuComputeAvailable = support.available;
  w.gpuComputeReason = support.reason;
}
