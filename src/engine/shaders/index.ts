// Chromashift WGSL shaders — assembled from per-pass modules.
// Band thresholds are generated from the canonical BAND table in
// ../math/bandClassification.ts (see bandLiterals.ts).
export {
  BAND_GLSL,
  BAND_SHADER_FLOAT,
  BAND_WGSL,
  DARK_BAND_RGB_MAX,
} from './bandLiterals';
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
} from './layers';
export { persistenceFragmentSource, persistenceCompositeFragmentSource } from './persistence';
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
