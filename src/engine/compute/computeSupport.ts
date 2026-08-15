/**
 * Compatibility re-export.
 *
 * Feature detection for optional WebGPU compute image analysis now lives in
 * the `gpu-chores` facade at `./chores/support`, so sibling apps share the
 * same detection and breadcrumb contract. This module is kept so existing
 * imports resolve unchanged.
 */
export type { GpuComputeDiagnostics, GpuComputeSupport } from './chores/support';
export {
  NO_GPU_COMPUTE_PARAM,
  canAnalyzeTexture,
  detectGpuComputeSupport,
  isGpuComputeDisabledByFlag,
  isSrgbTextureFormat,
  publishChoreBreadcrumbs,
  publishGpuComputeBreadcrumbs,
  readGpuComputeDiagnostics,
} from './chores/support';
