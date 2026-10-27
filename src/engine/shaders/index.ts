// Chromashift WGSL shaders — assembled from per-pass modules.
// Band thresholds are generated from the canonical BAND table in
// ../math/bandClassification.ts (see bandLiterals.ts); tracer-decay
// exponents from the DECAY table in ../math/decay.ts (see decayLiterals.ts).
export {
  vertexShaderSource,
  fullscreenVertexSource,
  WGSL_OUTPUT_ENCODE,
  WGSL_OUTPUT_ENCODE_EXTENDED,
  toHdrPresentWgsl,
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
  persistDiagnosticBlitFragmentSource,
  stampDiagnosticViewFragmentSource,
  compareFragmentSource,
} from './diagnostics';
