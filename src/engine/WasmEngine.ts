/**
 * WasmEngine — optional C++ WebAssembly engine bridge.
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

// ─── Types ────────────────────────────────────────────────────────────────────

export type EngineKind = 'ts' | 'wasm';

/** Subset of the Emscripten-generated module we use. */
interface ChromashiftWasmModule {
  /** Call the C++ computeAverageLuminance with a WASM heap pointer. */
  computeAverageLuminance(ptr: number, length: number): number;
  /** Call the C++ classifyPixel. */
  classifyPixel(r: number, g: number, b: number, avgLum: number): number;
  /** Classify every pixel in a RGBA buffer.  outPtr points to pixelCount int32 values. */
  classifyPixelsBulk(inPtr: number, byteLen: number, avgLum: number, outPtr: number): void;
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

type LoadState = 'idle' | 'loading' | 'ready' | 'unavailable';

// ─── Module-level state ───────────────────────────────────────────────────────

let wasmModule: ChromashiftWasmModule | null = null;
let loadState: LoadState = 'idle';
const pendingResolvers: Array<(ok: boolean) => void> = [];

// ─── Loader ───────────────────────────────────────────────────────────────────

/**
 * Attempt to load the compiled C++ WASM engine.
 *
 * Safe to call multiple times — subsequent calls resolve with the cached state.
 * Returns `true` when the WASM module loaded successfully, `false` otherwise.
 */
export async function loadWasmEngine(): Promise<boolean> {
  if (loadState === 'ready')       return true;
  if (loadState === 'unavailable') return false;

  if (loadState === 'loading') {
    return new Promise<boolean>((resolve) => {
      pendingResolvers.push(resolve);
    });
  }

  loadState = 'loading';

  try {
    // Build the URL at runtime so Rollup does not attempt to resolve or bundle it.
    // The Emscripten glue lives in /public/ and is served as a static asset; it is
    // not part of the Vite module graph.
    type GlueModule = { default: (opts?: Record<string, unknown>) => Promise<ChromashiftWasmModule> };
    const engineUrl = `${window.location.origin}/chromashift_engine.js`;
    const glue = await import(/* @vite-ignore */ engineUrl) as GlueModule;
    wasmModule = await glue.default();
    loadState = 'ready';
  } catch {
    // WASM assets not yet built — this is expected in the default repo state.
    loadState = 'unavailable';
  }

  const ok = loadState === 'ready';
  for (const resolve of pendingResolvers) resolve(ok);
  pendingResolvers.length = 0;
  return ok;
}

/** Returns `true` when the WASM module is loaded and ready. */
export function isWasmReady(): boolean {
  return loadState === 'ready' && wasmModule !== null;
}

// ─── Shared helper: downscale image to ≤256 px and read RGBA bytes ────────────

function getImageBytes(image: HTMLImageElement): Uint8ClampedArray | null {
  const canvas = document.createElement('canvas');
  const MAX_SIZE = 256;
  const scale = Math.min(1, MAX_SIZE / Math.max(image.naturalWidth, image.naturalHeight));
  canvas.width  = Math.max(1, Math.floor(image.naturalWidth  * scale));
  canvas.height = Math.max(1, Math.floor(image.naturalHeight * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
}

// ─── TypeScript fallback implementations ─────────────────────────────────────

function tsComputeAverageLuminance(image: HTMLImageElement): number {
  const bytes = getImageBytes(image);
  if (!bytes) return 128;
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4) {
    sum += bytes[i] * 0.2126 + bytes[i + 1] * 0.7152 + bytes[i + 2] * 0.0722;
  }
  return sum / (bytes.length / 4);
}

// ─── Public dispatched API ────────────────────────────────────────────────────

/**
 * Compute the average ITU-R BT.709 luminance of an image element.
 *
 * When `useWasm` is `true` **and** the WASM module is loaded the computation
 * runs in the C++ engine; otherwise the TypeScript fallback is used.
 *
 * @param image    HTMLImageElement to measure.
 * @param useWasm  Attempt to use the C++ WASM engine.
 * @returns        Average luminance in [0, 255].
 */
export function computeAverageLuminanceWith(
  image: HTMLImageElement,
  useWasm: boolean,
): number {
  if (useWasm && wasmModule) {
    // Downscale to ≤256 px, copy RGBA bytes into WASM heap, call C++.
    const bytes = getImageBytes(image);
    if (!bytes) return tsComputeAverageLuminance(image);

    const ptr = wasmModule._malloc(bytes.length);
    wasmModule.HEAPU8.set(bytes, ptr);
    const result = wasmModule.computeAverageLuminance(ptr, bytes.length);
    wasmModule._free(ptr);
    return result;
  }

  return tsComputeAverageLuminance(image);
}

/**
 * Classify a single pixel into a Chromashift colour band index (0–10).
 *
 * Band mapping (matches WGSL shaders):
 *   0  grey highlight  (rgb > 229)
 *   1  orange          (209 < rgb ≤ 229)
 *   2  red             (193 < rgb ≤ 209)
 *   3  border red      (190 < rgb ≤ 193)
 *   4  violet          (177 < rgb ≤ 190)
 *   5  blue            (161 < rgb ≤ 177)
 *   6  border blue     (158 < rgb ≤ 161)
 *   7  green           (145 < rgb ≤ 158)
 *   8  yellow          (128 < rgb ≤ 145)
 *   9  border yellow   (125 < rgb ≤ 128)
 *  10  dark / grey     (rgb ≤ 126)
 *
 * @param r       Red   [0–255]
 * @param g       Green [0–255]
 * @param b       Blue  [0–255]
 * @param avgLum  Per-image average luminance [0–255]
 * @param useWasm Attempt to use the C++ WASM engine.
 */
export function classifyPixelWith(
  r: number,
  g: number,
  b: number,
  avgLum: number,
  useWasm: boolean,
): number {
  if (useWasm && wasmModule) {
    return wasmModule.classifyPixel(r, g, b, avgLum);
  }

  // TypeScript fallback — mirrors the C++ implementation.
  const lum       = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const lightDark = 128 + Math.abs(avgLum - 128) / 2;
  const rgb       = lum + lightDark / 2;

  if      (rgb > 229) return 0;
  else if (rgb > 209) return 1;
  else if (rgb > 193) return 2;
  else if (rgb > 190) return 3;
  else if (rgb > 177) return 4;
  else if (rgb > 161) return 5;
  else if (rgb > 158) return 6;
  else if (rgb > 145) return 7;
  else if (rgb > 128) return 8;
  else if (rgb > 125) return 9;
  else                return 10;
}

/**
 * Classify every pixel in an `ImageData` object into colour band indices (0–10).
 *
 * This is the bulk version of `classifyPixelWith` — processing the whole
 * buffer in a single C++ call avoids repeated JS↔WASM boundary crossings.
 *
 * @param imageData  Source pixel data (e.g. from `CanvasRenderingContext2D.getImageData`).
 * @param avgLum     Per-image average luminance [0–255].
 * @param useWasm    Attempt to use the C++ WASM engine.
 * @returns          `Int32Array` of length `imageData.width * imageData.height`,
 *                   one band index (0–10) per pixel.
 */
export function classifyPixelsBulkWith(
  imageData: ImageData,
  avgLum: number,
  useWasm: boolean,
): Int32Array {
  const { data } = imageData;
  const pixelCount = data.length / 4;

  if (useWasm && wasmModule) {
    const inPtr  = wasmModule._malloc(data.length);
    const outPtr = wasmModule._malloc(pixelCount * 4); // int32 per pixel
    wasmModule.HEAPU8.set(data, inPtr);
    wasmModule.classifyPixelsBulk(inPtr, data.length, Math.round(avgLum), outPtr);
    const result = new Int32Array(pixelCount);
    for (let i = 0; i < pixelCount; i++) {
      result[i] = wasmModule.HEAP32[(outPtr >> 2) + i];
    }
    wasmModule._free(inPtr);
    wasmModule._free(outPtr);
    return result;
  }

  // TypeScript fallback
  const result = new Int32Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const lum       = r * 0.2126 + g * 0.7152 + b * 0.0722;
    const lightDark = 128 + Math.abs(avgLum - 128) / 2;
    const rgb       = lum + lightDark / 2;
    if      (rgb > 229) result[i] = 0;
    else if (rgb > 209) result[i] = 1;
    else if (rgb > 193) result[i] = 2;
    else if (rgb > 190) result[i] = 3;
    else if (rgb > 177) result[i] = 4;
    else if (rgb > 161) result[i] = 5;
    else if (rgb > 158) result[i] = 6;
    else if (rgb > 145) result[i] = 7;
    else if (rgb > 128) result[i] = 8;
    else if (rgb > 125) result[i] = 9;
    else                result[i] = 10;
  }
  return result;
}

/**
 * Compute a 256-bucket ITU-R BT.709 luminance histogram for an image.
 *
 * Each bucket index corresponds to a rounded luminance value in [0, 255].
 * The image is downsampled to ≤256 px before analysis.
 *
 * @param image    Source image element.
 * @param useWasm  Attempt to use the C++ WASM engine.
 * @returns        `Uint32Array` of length 256 where `result[n]` is the count
 *                 of pixels whose BT.709 luminance rounds to `n`.
 */
export function computeLuminanceHistogramWith(
  image: HTMLImageElement,
  useWasm: boolean,
): Uint32Array {
  const bytes = getImageBytes(image);
  if (!bytes) return new Uint32Array(256);

  if (useWasm && wasmModule) {
    const inPtr  = wasmModule._malloc(bytes.length);
    const outPtr = wasmModule._malloc(256 * 4); // 256 uint32 values
    wasmModule.HEAPU8.set(bytes, inPtr);
    wasmModule.computeLuminanceHistogram(inPtr, bytes.length, outPtr);
    const result = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      result[i] = wasmModule.HEAPU32[(outPtr >> 2) + i];
    }
    wasmModule._free(inPtr);
    wasmModule._free(outPtr);
    return result;
  }

  // TypeScript fallback
  const hist = new Uint32Array(256);
  for (let i = 0; i < bytes.length; i += 4) {
    const lum = bytes[i] * 0.2126 + bytes[i + 1] * 0.7152 + bytes[i + 2] * 0.0722;
    hist[Math.min(Math.floor(lum), 255)]++;
  }
  return hist;
}

/**
 * Count pixels per Chromashift colour band (0–10) for an image.
 *
 * Equivalent to calling `classifyPixelsBulkWith` and tallying, but avoids
 * allocating the per-pixel band array.  The image is downsampled to ≤256 px.
 *
 * @param image    Source image element.
 * @param avgLum   Per-image average luminance [0–255].
 * @param useWasm  Attempt to use the C++ WASM engine.
 * @returns        `Uint32Array` of length 11 where `result[n]` is the pixel
 *                 count for colour band `n`.  See `classifyPixelWith` for the
 *                 band-to-index mapping.
 */
export function computeColorBandCountsWith(
  image: HTMLImageElement,
  avgLum: number,
  useWasm: boolean,
): Uint32Array {
  const bytes = getImageBytes(image);
  if (!bytes) return new Uint32Array(11);

  if (useWasm && wasmModule) {
    const inPtr  = wasmModule._malloc(bytes.length);
    const outPtr = wasmModule._malloc(11 * 4); // 11 uint32 values
    wasmModule.HEAPU8.set(bytes, inPtr);
    wasmModule.computeColorBandCounts(inPtr, bytes.length, Math.round(avgLum), outPtr);
    const result = new Uint32Array(11);
    for (let i = 0; i < 11; i++) {
      result[i] = wasmModule.HEAPU32[(outPtr >> 2) + i];
    }
    wasmModule._free(inPtr);
    wasmModule._free(outPtr);
    return result;
  }

  // TypeScript fallback
  const counts = new Uint32Array(11);
  for (let i = 0; i < bytes.length; i += 4) {
    const r = bytes[i];
    const g = bytes[i + 1];
    const b = bytes[i + 2];
    const lum       = r * 0.2126 + g * 0.7152 + b * 0.0722;
    const lightDark = 128 + Math.abs(avgLum - 128) / 2;
    const rgb       = lum + lightDark / 2;
    let band: number;
    if      (rgb > 229) band = 0;
    else if (rgb > 209) band = 1;
    else if (rgb > 193) band = 2;
    else if (rgb > 190) band = 3;
    else if (rgb > 177) band = 4;
    else if (rgb > 161) band = 5;
    else if (rgb > 158) band = 6;
    else if (rgb > 145) band = 7;
    else if (rgb > 128) band = 8;
    else if (rgb > 125) band = 9;
    else                band = 10;
    counts[band]++;
  }
  return counts;
}

/**
 * Compute the per-frame decay multiplier for the tracer persistence system.
 *
 * Solves `decay ^ (fps × durationMs / 1000) = 0.1` so that the tracer
 * reaches 10% of its original brightness after `durationMs` milliseconds.
 * Matches the `durationToDecay()` helper in `WebGPURenderer.ts`.
 *
 * @param durationMs  Desired tracer lifetime in milliseconds.
 * @param fps         Current frame rate.
 * @param useWasm     Attempt to use the C++ WASM engine.
 * @returns           Per-frame multiplier in [0, 1).
 */
export function durationToDecayWith(
  durationMs: number,
  fps: number,
  useWasm: boolean,
): number {
  if (useWasm && wasmModule) {
    return wasmModule.durationToDecay(durationMs, fps);
  }

  // TypeScript fallback — mirrors the C++ implementation.
  if (durationMs <= 0 || fps <= 0) return 0;
  const frames = fps * durationMs / 1000;
  if (frames < 1) return 0;
  return Math.pow(0.1, 1 / frames);
}

/**
 * Advance three layer rotation angles by their per-frame step sizes,
 * keeping all results in [0, 360).
 *
 * @param angles   Current angles in degrees for layers [0, 1, 2].
 * @param steps    Per-frame step sizes in degrees for layers [0, 1, 2].
 * @param useWasm  Attempt to use the C++ WASM engine.
 * @returns        New angles in degrees, each in [0, 360).
 */
export function advanceAnglesBy(
  angles: [number, number, number],
  steps: [number, number, number],
  useWasm: boolean,
): [number, number, number] {
  if (useWasm && wasmModule) {
    const outPtr = wasmModule._malloc(12); // 3 × float32
    wasmModule.advanceLayerAngles(
      angles[0], angles[1], angles[2],
      steps[0],  steps[1],  steps[2],
      outPtr,
    );
    const result: [number, number, number] = [
      wasmModule.HEAPF32[(outPtr >> 2)],
      wasmModule.HEAPF32[(outPtr >> 2) + 1],
      wasmModule.HEAPF32[(outPtr >> 2) + 2],
    ];
    wasmModule._free(outPtr);
    return result;
  }

  // TypeScript fallback — ((a + s) % 360 + 360) % 360 handles negative steps.
  return [
    ((angles[0] + steps[0]) % 360 + 360) % 360,
    ((angles[1] + steps[1]) % 360 + 360) % 360,
    ((angles[2] + steps[2]) % 360 + 360) % 360,
  ];
}

/**
 * Apply per-frame decay to a flat Float32 RGBA buffer in-place.
 *
 * Each channel (R, G, B, A) is multiplied by `decayFactor`.  This replicates
 * the decay step of the WGSL persistence shader and is useful for CPU-side
 * tracer simulation and unit tests.  For real-time rendering the GPU pipeline
 * in `WebGPURenderer` handles this more efficiently.
 *
 * @param buffer      Float32 RGBA buffer — values in [0, 1], modified in-place.
 * @param decayFactor Per-frame multiplier, typically from `durationToDecayWith`.
 * @param useWasm     Attempt to use the C++ WASM engine.
 */
export function simulateTracerDecayWith(
  buffer: Float32Array,
  decayFactor: number,
  useWasm: boolean,
): void {
  const pixelCount = Math.floor(buffer.length / 4);

  if (useWasm && wasmModule) {
    const byteCount = pixelCount * 4 * 4; // pixelCount × 4 channels × 4 bytes/float
    const ptr = wasmModule._malloc(byteCount);
    // Copy buffer into WASM heap (HEAPF32 is indexed by float, not byte)
    wasmModule.HEAPF32.set(buffer.subarray(0, pixelCount * 4), ptr >> 2);
    wasmModule.simulateTracerDecay(ptr, pixelCount, decayFactor);
    // Copy result back
    buffer.set(wasmModule.HEAPF32.subarray(ptr >> 2, (ptr >> 2) + pixelCount * 4));
    wasmModule._free(ptr);
    return;
  }

  // TypeScript fallback
  for (let i = 0; i < pixelCount * 4; i++) {
    buffer[i] *= decayFactor;
  }
}
