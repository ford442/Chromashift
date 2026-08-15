import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canAnalyzeTexture,
  detectGpuComputeSupport,
  isSrgbTextureFormat,
  publishGpuComputeBreadcrumbs,
  readGpuComputeDiagnostics,
} from './support';

function mockDevice(limits: Partial<GPUSupportedLimits> = {}): GPUDevice {
  return {
    limits: { maxTextureDimension2D: 8192, ...limits },
    features: new Set(['timestamp-query']),
  } as unknown as GPUDevice;
}

function withSearch(search: string): void {
  vi.stubGlobal('window', {
    location: { search },
  } as unknown as Window);
}

describe('gpu-chores support detection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports unavailable without a device', () => {
    const support = detectGpuComputeSupport(null);
    expect(support.available).toBe(false);
    expect(support.reason).toBe('No GPU device');
  });

  it('accepts a conformant device', () => {
    withSearch('');
    const support = detectGpuComputeSupport(mockDevice());
    expect(support.available).toBe(true);
    expect(support.reason).toBeNull();
    expect(support.maxTextureDimension2D).toBe(8192);
  });

  it('?no_gpu_compute closes the lane and names itself as the reason', () => {
    withSearch('?no_gpu_compute');
    const support = detectGpuComputeSupport(mockDevice());
    expect(support.available).toBe(false);
    expect(support.reason).toContain('no_gpu_compute');
    // The kill switch must not masquerade as a capability problem.
    expect(support.maxTextureDimension2D).toBe(8192);
  });

  it('gates analysis on maxTextureDimension2D', () => {
    withSearch('');
    const support = detectGpuComputeSupport(mockDevice({ maxTextureDimension2D: 4096 }));
    expect(canAnalyzeTexture(support, 4096, 4096)).toBe(true);
    expect(canAnalyzeTexture(support, 8192, 4096)).toBe(false);
    expect(canAnalyzeTexture({ ...support, available: false }, 16, 16)).toBe(false);
  });

  it('detects sRGB source formats', () => {
    expect(isSrgbTextureFormat('rgba8unorm-srgb')).toBe(true);
    expect(isSrgbTextureFormat('bgra8unorm-srgb')).toBe(true);
    expect(isSrgbTextureFormat('rgba8unorm')).toBe(false);
  });

  it('reads adapter/limits diagnostics without throwing on a partial device', () => {
    // Diagnostics must never break bootstrap, even on a device stub with no
    // limits at all (jsdom mocks, headless CI).
    const bare = { destroy: () => {} } as unknown as GPUDevice;
    const diagnostics = readGpuComputeDiagnostics(bare);
    expect(diagnostics).not.toBeNull();
    expect(diagnostics!.vendor).toBe('unknown');
    expect(diagnostics!.limits.maxTextureDimension2D).toBe(0);
    expect(diagnostics!.features).toEqual([]);
  });

  it('publishes breadcrumbs for automation', () => {
    const w: Record<string, unknown> = { location: { search: '' } };
    vi.stubGlobal('window', w as unknown as Window);

    const support = detectGpuComputeSupport(mockDevice());
    publishGpuComputeBreadcrumbs(support, readGpuComputeDiagnostics(mockDevice()));

    expect(w.gpuComputeAvailable).toBe(true);
    expect(w.gpuComputeReason).toBeNull();
    expect(w.gpuComputeDiagnostics).toBeTruthy();
  });
});
