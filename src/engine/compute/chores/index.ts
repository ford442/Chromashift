/**
 * `gpu-chores` — public entry point.
 *
 * This is the surface sibling apps depend on. If the shared package is later
 * extracted from this directory, consumers should only ever have imported
 * from here.
 *
 * Usage:
 * ```ts
 * const chores = createImageAnalysisRuntime({ device, cpuHost });
 * const result = await chores.runJob({
 *   op: 'image-analysis', source, image, width, height, prefer: 'auto',
 * });
 * if (result.ok && result.value.kind === 'gpu-texture') { … }
 * ```
 */

export type {
  ChoreAttempt,
  ChoreBackend,
  ChoreBackendImpl,
  ChoreFailure,
  ChoreJob,
  ChoreOp,
  ChorePreference,
  ChoreResult,
  ChoreSuccess,
  ChoresRuntime,
  CpuImageAnalysisOutput,
  GpuImageAnalysisOutput,
  ImageAnalysisJob,
  ImageAnalysisOutput,
} from './types';
export { CHORE_BACKEND_ORDER } from './types';

export type { CpuChoreHost } from './cpuBackend';
export { CpuChoreBackend } from './cpuBackend';

export { WebGpuChoreBackend, averageFromHistogram } from './webgpuBackend';

export { ChoreRuntimeImpl, createChoresRuntime } from './runtime';

export type { GpuComputeDiagnostics, GpuComputeSupport } from './support';
export {
  NO_GPU_COMPUTE_PARAM,
  canAnalyzeTexture,
  detectGpuComputeSupport,
  isGpuComputeDisabledByFlag,
  isSrgbTextureFormat,
  publishChoreBreadcrumbs,
  publishGpuComputeBreadcrumbs,
  readGpuComputeDiagnostics,
} from './support';

export {
  CLASSIFICATION_COMPUTE_SHADER,
  HISTOGRAM_COMPUTE_SHADER,
  WGSL_IMAGE_ANALYSIS_HELPERS,
} from './kernels';

import { CpuChoreBackend, type CpuChoreHost } from './cpuBackend';
import { createChoresRuntime } from './runtime';
import { WebGpuChoreBackend } from './webgpuBackend';
import type { ChoreBackendImpl, ChoresRuntime } from './types';

export interface ImageAnalysisRuntimeOptions {
  /**
   * Renderer-owned device. Pass `null` on a WebGL backend (or when compute is
   * killed) and no `webgpu` lane is registered at all — that is what keeps a
   * GL context and a compute device from ever being live for one analysis.
   *
   * The runtime adopts this device; it never requests its own.
   */
  device?: GPUDevice | null;
  /**
   * An already-constructed WebGPU lane to register instead of building one
   * from `device`. Hosts that already own a lane (Chromashift's
   * `RendererOrchestrator` does) pass it here so pipelines, staging buffers,
   * and the reused mask texture stay shared rather than duplicated.
   *
   * Takes precedence over `device`.
   */
  gpuBackend?: ChoreBackendImpl | null;
  /** CPU implementations backing the `wasm` and `ts` lanes. */
  cpuHost?: CpuChoreHost | null;
}

/** Assemble a runtime with the lanes the host can actually supply. */
export function createImageAnalysisRuntime(
  options: ImageAnalysisRuntimeOptions,
): ChoresRuntime {
  const backends: ChoreBackendImpl[] = [];
  if (options.gpuBackend) backends.push(options.gpuBackend);
  else if (options.device) backends.push(new WebGpuChoreBackend(options.device));
  if (options.cpuHost) {
    backends.push(new CpuChoreBackend('wasm', options.cpuHost));
    backends.push(new CpuChoreBackend('ts', options.cpuHost));
  }
  return createChoresRuntime(backends);
}
