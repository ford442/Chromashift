/**
 * WasmEngine — optional C++ WebAssembly engine bridge.
 *
 * Thin barrel over `src/engine/wasm/` — kept so existing `from './WasmEngine'` /
 * `from '../engine/WasmEngine'` imports across the app stay stable. See
 * docs/wasm-engine.md for architecture, the call-site matrix, and the
 * Emscripten build/flag notes.
 *
 * At runtime this module attempts to load the Emscripten-compiled module at
 * /chromashift_engine.js (which fetches /chromashift_engine.wasm).  If those
 * assets are absent (i.e. the C++ engine has not been built yet) every public
 * function transparently falls back to the TypeScript implementation so the
 * application always works.
 *
 * Build the C++ engine:
 *   cd cpp && make          # requires Emscripten — see docs/wasm-engine.md
 */

export type { EngineKind } from './wasm/types';

export { isWasmSimdSupported, loadWasmEngine, isWasmReady } from './wasm/loadEngine';

export {
  computeAverageLuminanceWith,
  computeAverageLuminanceStridedWith,
  computeImageAverageLuminanceWith,
  classifyPixelWith,
  classifyPixelsBulkWith,
  classifyImageMaskWith,
  computeLuminanceHistogramWith,
  computeColorBandCountsWith,
  durationToDecayWith,
  advanceAnglesBy,
  buildRotationMat3With,
  simulateTracerDecayWith,
} from './wasm/dispatch';
