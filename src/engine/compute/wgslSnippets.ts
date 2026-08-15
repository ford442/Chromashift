/**
 * Compatibility re-export.
 *
 * The image-analysis kernels now live in the `gpu-chores` facade at
 * `./chores/kernels`, so sibling apps can depend on the same WGSL. This
 * module is kept so existing imports (and `goldenMask.test.ts`) resolve
 * unchanged.
 */
export {
  WGSL_IMAGE_ANALYSIS_HELPERS,
  HISTOGRAM_COMPUTE_SHADER,
  CLASSIFICATION_COMPUTE_SHADER,
} from './chores/kernels';
