// Chromashift WGSL shaders — assembled from per-pass modules.
// Band thresholds are generated from the canonical BAND table in
// ../math/bandClassification.ts (see BAND_WGSL in ./common.ts).
export {
  BAND_WGSL,
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
export { persistenceFragmentSource } from './persistence';
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
