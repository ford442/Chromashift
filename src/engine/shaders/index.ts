// Chromashift WGSL shaders — assembled from per-pass modules.
// Band thresholds are generated from the canonical BAND table in
// ../math/bandClassification.ts (see bandLiterals.ts); tracer-decay
// exponents from the DECAY table in ../math/decay.ts (see decayLiterals.ts).
export {
  BAND_GLSL,
  BAND_SHADER_FLOAT,
  BAND_WGSL,
  DARK_BAND_RGB_MAX,
} from './bandLiterals';
export {
  DECAY_GLSL,
  DECAY_SHADER_FLOAT,
  DECAY_WGSL,
} from './decayLiterals';
export {
  vertexShaderSource,
  fullscreenVertexSource,
  WGSL_COLOR_HELPERS,
  WGSL_BLEND_HELPERS,
} from './common';
export {
  fragmentShaderRedOrange,
  fragmentShaderVioletBlue,
  fragmentShaderGreenYellow,
  layerFragmentSources,
} from './layers';
export {
  persistenceFragmentSource,
  persistenceMotionFragmentSource,
  persistenceCompositeFragmentSource,
  persistenceCompositeMotionFragmentSource,
} from './persistence';
export { compositorFragmentSource } from './compositor';
export {
  tracerViewFragmentSource,
  displayTextureFragmentSource,
  coincidenceHeatmapFragmentSource,
  diagnosticFragmentSource,
  persistDiagnosticBlitFragmentSource,
  stampDiagnosticViewFragmentSource,
  compareFragmentSource,
} from './diagnostics';
