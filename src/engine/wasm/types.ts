/**
 * Shared types for the C++ WASM engine bridge.
 *
 * See docs/wasm-engine.md for the full architecture and call-site matrix.
 */

export type EngineKind = 'ts' | 'wasm';

/** Subset of the Emscripten-generated module we use. */
export interface ChromashiftWasmModule {
  /** Call the C++ computeAverageLuminance with a WASM heap pointer. */
  computeAverageLuminance(ptr: number, length: number): number;
  /** Compute average luminance with spatial stride for large upscaled images. */
  computeAverageLuminanceStrided(ptr: number, width: number, height: number, stride: number): number;
  /** Call the C++ classifyPixel. */
  classifyPixel(r: number, g: number, b: number, avgLum: number): number;
  /** Fill a 256-entry band LUT at outPtr for the given avgLum. */
  buildBandLut(avgLum: number, outPtr: number): void;
  /** Classify one pixel using a pre-built LUT. */
  classifyPixelLut(r: number, g: number, b: number, avgLum: number, lutPtr: number): number;
  /** Classify every pixel in a RGBA buffer.  outPtr points to pixelCount int32 values. */
  classifyPixelsBulk(inPtr: number, byteLen: number, avgLum: number, outPtr: number): void;
  /** LUT-accelerated bulk classification. */
  classifyPixelsBulkLut(inPtr: number, byteLen: number, avgLum: number, outPtr: number): void;
  /** Build a compact uint8 classification mask (0–10 per pixel). */
  computeClassificationMask(inPtr: number, width: number, height: number, avgLum: number, outPtr: number): void;
  /** LUT-accelerated classification mask. */
  computeClassificationMaskLut(inPtr: number, width: number, height: number, avgLum: number, outPtr: number): void;
  /** Fill a 256-entry uint32 histogram at outPtr. */
  computeLuminanceHistogram(inPtr: number, byteLen: number, outPtr: number): void;
  /** Fill an 11-entry uint32 colour-band count array at outPtr. */
  computeColorBandCounts(inPtr: number, byteLen: number, avgLum: number, outPtr: number): void;
  /** Per-frame tracer decay multiplier. */
  durationToDecay(durationMs: number, fps: number): number;
  /** Advance 3 layer angles; result written to outPtr (3 float32 values). */
  advanceLayerAngles(a0: number, a1: number, a2: number,
                     s0: number, s1: number, s2: number,
                     outPtr: number): void;
  /** Apply decay in-place to a float RGBA buffer on the WASM heap. */
  simulateTracerDecay(bufPtr: number, pixelCount: number, decayFactor: number): void;
  /** Write a column-major 3×3 rotation matrix (9 floats) to outPtr. */
  buildRotationMat3(angleDeg: number, outPtr: number): void;
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

/** Embind exports the TS bridge may call; checked individually for stale builds. */
export const WASM_API_FUNCTIONS = [
  'computeAverageLuminance',
  'computeAverageLuminanceStrided',
  'classifyPixel',
  'buildBandLut',
  'classifyPixelLut',
  'classifyPixelsBulk',
  'classifyPixelsBulkLut',
  'computeClassificationMask',
  'computeClassificationMaskLut',
  'computeLuminanceHistogram',
  'computeColorBandCounts',
  'buildRotationMat3',
  'durationToDecay',
  'advanceLayerAngles',
  'simulateTracerDecay',
] as const satisfies ReadonlyArray<keyof ChromashiftWasmModule>;

export type WasmApiFunction = (typeof WASM_API_FUNCTIONS)[number];
