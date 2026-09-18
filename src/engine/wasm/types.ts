/**
 * Shared types for the C++ WASM engine bridge.
 *
 * See docs/wasm-engine.md for the full architecture and call-site matrix.
 */

export type EngineKind = 'ts' | 'wasm';

/**
 * Subset of the Emscripten-generated module we use.
 *
 * The engine exports exactly one ABI: the flat C symbols listed in
 * `EXPORTED_FUNCS` in cpp/Makefile, which Emscripten surfaces on the module as
 * `_name`.  Pointer arguments are offsets into the WASM heap — write inputs
 * through `HEAPU8` and read results back through the matching heap view.
 */
export interface ChromashiftWasmModule {
  /** Call the C++ computeAverageLuminance with a WASM heap pointer. */
  _computeAverageLuminance(ptr: number, length: number): number;
  /** Compute average luminance with spatial stride for large upscaled images. */
  _computeAverageLuminanceStrided(ptr: number, width: number, height: number, stride: number): number;
  /** Call the C++ classifyPixel. */
  _classifyPixel(r: number, g: number, b: number, avgLum: number): number;
  /** Fill a 256-entry band LUT at outPtr for the given avgLum. */
  _buildBandLut(avgLum: number, outPtr: number): void;
  /** Classify one pixel using a pre-built LUT. */
  _classifyPixelLut(r: number, g: number, b: number, avgLum: number, lutPtr: number): number;
  /** Classify every pixel in a RGBA buffer.  outPtr points to pixelCount int32 values. */
  _classifyPixelsBulk(inPtr: number, byteLen: number, avgLum: number, outPtr: number): void;
  /** LUT-accelerated bulk classification. */
  _classifyPixelsBulkLut(inPtr: number, byteLen: number, avgLum: number, outPtr: number): void;
  /** Build a compact uint8 classification mask (0–10 per pixel). */
  _computeClassificationMask(inPtr: number, width: number, height: number, avgLum: number, outPtr: number): void;
  /** LUT-accelerated classification mask. */
  _computeClassificationMaskLut(inPtr: number, width: number, height: number, avgLum: number, outPtr: number): void;
  /** Fill a 256-entry uint32 histogram at outPtr. */
  _computeLuminanceHistogram(inPtr: number, byteLen: number, outPtr: number): void;
  /** Fill an 11-entry uint32 colour-band count array at outPtr. */
  _computeColorBandCounts(inPtr: number, byteLen: number, avgLum: number, outPtr: number): void;
  /** Per-frame tracer decay multiplier. */
  _durationToDecay(durationMs: number, fps: number): number;
  /**
   * Advance `count` layer angles. `anglesPtr` and `stepsPtr` each point at
   * `count` float32 values; the result is written to `outPtr`, which may alias
   * `anglesPtr`.
   */
  _advanceLayerAngles(anglesPtr: number, stepsPtr: number,
                      outPtr: number, count: number): void;
  /**
   * Three-wide form of `_advanceLayerAngles`.
   *
   * @deprecated Present only in modules built against the count-taking ABI, which
   * is what `advanceAnglesBy()` uses it to detect — see `dispatch/animation.ts`.
   */
  _advanceLayerAngles3(a0: number, a1: number, a2: number,
                       s0: number, s1: number, s2: number,
                       outPtr: number): void;
  /** Apply decay in-place to a float RGBA buffer on the WASM heap. */
  _simulateTracerDecay(bufPtr: number, pixelCount: number, decayFactor: number): void;
  /**
   * Coarse-to-fine Lucas–Kanade flow over two `width * height` float luminance
   * planes; writes `width * height * 2` interleaved `vx, vy` floats to outPtr.
   */
  _computeMotionFlow(curPtr: number, prevPtr: number,
                     width: number, height: number, outPtr: number): void;
  /** Write a column-major 3×3 rotation matrix (9 floats) to outPtr. */
  _buildRotationMat3(angleDeg: number, outPtr: number): void;
  /** Allocate bytes on the WASM heap; returns a pointer. */
  _malloc(size: number): number;
  /** Free a heap allocation. */
  _free(ptr: number): void;
  /** Direct byte view of the WASM linear memory. */
  HEAPU8: Uint8Array;
  /** Uint32 view of the WASM linear memory. */
  HEAPU32: Uint32Array;
  /** Int32 view of the WASM linear memory. */
  HEAP32: Int32Array;
  /** Float32 view of the WASM linear memory. */
  HEAPF32: Float32Array;
}

/** Emscripten glue module shape produced by `EXPORT_ES6=1` + `MODULARIZE=1`. */
export type GlueModule = {
  default: (opts?: Record<string, unknown>) => Promise<ChromashiftWasmModule>;
};

/** C exports the TS bridge may call; checked individually for stale builds. */
export const WASM_API_FUNCTIONS = [
  '_computeAverageLuminance',
  '_computeAverageLuminanceStrided',
  '_classifyPixel',
  '_buildBandLut',
  '_classifyPixelLut',
  '_classifyPixelsBulk',
  '_classifyPixelsBulkLut',
  '_computeClassificationMask',
  '_computeClassificationMaskLut',
  '_computeLuminanceHistogram',
  '_computeColorBandCounts',
  '_buildRotationMat3',
  '_durationToDecay',
  '_advanceLayerAngles',
  '_advanceLayerAngles3',
  '_simulateTracerDecay',
  '_computeMotionFlow',
] as const satisfies ReadonlyArray<keyof ChromashiftWasmModule>;

export type WasmApiFunction = (typeof WASM_API_FUNCTIONS)[number];
