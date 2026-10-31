/**
 * `*With()` dispatchers — route each computation through the C++ WASM engine
 * when available and requested, otherwise fall back to the TypeScript
 * implementation. This is the public API surface re-exported by
 * `src/engine/WasmEngine.ts`.
 *
 * Grouped by concern under `./dispatch/`:
 *   - luminance.ts      average / strided / image-adaptive luminance
 *   - classification.ts per-pixel and bulk colour-band classification, masks, histograms
 *   - animation.ts      tracer decay, layer-angle stepping, rotation matrices
 *
 * See docs/wasm-engine.md for the call-site matrix (which hooks call which
 * function, and which are load-time/export-only vs test/benchmark-only).
 */

export {
  computeAverageLuminanceWith,
  computeAverageLuminanceStridedWith,
  computeImageAverageLuminanceWith,
  computePixelsAverageLuminanceWith,
} from './dispatch/luminance';

export {
  classifyImageMaskWith,
  classifyPixelsMaskWith,
} from './dispatch/classification';

export {
  durationToDecayWith,
  advanceAnglesBy,
} from './dispatch/animation';
