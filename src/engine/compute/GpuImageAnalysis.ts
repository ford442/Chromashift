import type { WebGpuChoreBackend } from './chores';
import type { GpuComputeSupport } from './chores';
import { acquireGpuChoreSession, type GpuChoreLease } from './GpuChoreSession';

export interface GpuImageAnalysisResult {
  avgLuminance: number;
  maskTexture: GPUTexture;
  histogram: Uint32Array;
}

/**
 * WebGPU compute passes for BT.709 histogram and r8uint classification masks.
 *
 * The kernels and device plumbing now live in the `gpu-chores` facade
 * (`./chores`); this class is a thin adapter that keeps Chromashift's existing
 * call sites (`RendererOrchestrator`, `useClassificationMask`) unchanged.
 *
 * The `GPUDevice` is **adopted** from the renderer session — this never
 * requests a device of its own — and the chore backend behind it is the one
 * shared per device (see `GpuChoreSession`), not a private instance.
 *
 * Fallbacks are handled by callers (WasmEngine / bandClassification.ts), or by
 * `runJob({ prefer: 'auto' })` when going through the facade directly.
 */
export class GpuImageAnalysis {
  private readonly lease: GpuChoreLease;
  private readonly gpu: WebGpuChoreBackend;

  constructor(device: GPUDevice) {
    this.lease = acquireGpuChoreSession(device);
    this.gpu = this.lease.backend;
  }

  /** The chores lane this adapter wraps, for callers that speak `runJob`. */
  get backend(): WebGpuChoreBackend {
    return this.gpu;
  }

  get support(): GpuComputeSupport {
    return this.gpu.support;
  }

  isSupported(): boolean {
    return this.gpu.isSupported();
  }

  canAnalyze(width: number, height: number): boolean {
    return this.gpu.canAnalyze(width, height);
  }

  /** Read back mask bytes for golden / e2e validation. */
  readMaskPixels(width: number, height: number): Promise<Uint8Array | null> {
    return this.gpu.readMaskPixels(width, height);
  }

  /**
   * Build histogram (256 bins), derive average luminance, and write an r8uint mask.
   * The returned mask texture is owned by this instance and reused across calls.
   */
  async analyze(
    source: GPUTexture,
    width: number,
    height: number,
    avgLumHint?: number,
  ): Promise<GpuImageAnalysisResult | null> {
    const result = await this.gpu.analyze(source, width, height, avgLumHint);
    if (!result) return null;
    return {
      avgLuminance: result.avgLuminance,
      maskTexture: result.maskTexture,
      histogram: result.histogram,
    };
  }

  /**
   * Release this adapter's lease. The shared backend is destroyed only when the
   * last holder lets go — normally `RendererOrchestrator` at session teardown —
   * so tearing down analysis does not pull coincidence or motion down with it.
   */
  destroy(): void {
    this.lease.release();
  }
}
