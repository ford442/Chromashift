import { CANONICAL_LAYER_SPECS } from '../../graph/layerSpecs';
import {
  emitBandColorHelpersGlsl,
  emitGradientBranchGlsl,
  emitNunifAlphaGlsl,
} from '../../graph/templates/glsl';

/**
 * Shared GLSL band-colour helpers (crop, fixed CR0P, gradients).
 *
 * The `int layer` switches below are emitted from the same band table the WGSL
 * shaders use (graph/layerSpecs.ts), so the two backends cannot drift and the
 * layer count is data on this side too.
 */
export const GLSL_BAND_COLOR_HELPERS = emitBandColorHelpersGlsl(CANONICAL_LAYER_SPECS);

/** Chromashift gradient mode colour selection (shared by layer + debug shaders). */
export const GLSL_GRADIENT_LAYER_BRANCH = emitGradientBranchGlsl(CANONICAL_LAYER_SPECS);

/** CROP NUNIF2 per-layer alpha selector, emitted from the same specs. */
export const GLSL_NUNIF2_ALPHA = emitNunifAlphaGlsl(CANONICAL_LAYER_SPECS);

/** Layer-isolation debug wrapper around shared band colour paths. */
export const GLSL_COMPUTE_LAYER_COLOR_FN = `
vec4 computeLayerColor(float lum) {
  vec4 result = vec4(0.0);
  if (u_colorMode == 1.0) {
${GLSL_GRADIENT_LAYER_BRANCH}
  } else if (u_colorMode >= 1.5) {
    float adjusted = lum + (128.0 + abs(u_avgLuminance - 128.0) * 0.5) * 0.5;
    bool isNunif2 = u_colorMode > 2.5;
    float bandLum = isNunif2 ? adjusted : lum;
    float nonAlpha = ${GLSL_NUNIF2_ALPHA};
    float darkAlpha = isNunif2 ? 0.1 : 0.0;
    result = cropColor(u_layerIndex, bandLum, u_softCropEnabled, nonAlpha, darkAlpha);
  } else {
    result = fixedLayerColor(u_layerIndex, lum);
  }
  return result;
}
`;
