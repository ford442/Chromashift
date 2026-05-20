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
  /** Allocate bytes on the WASM heap; returns a pointer. */
  _malloc(size: number): number;
  /** Free a heap allocation. */
  _free(ptr: number): void;
  /** Direct view of the WASM linear memory. */
  HEAPU8: Uint8Array;
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

// ─── TypeScript fallback implementations ─────────────────────────────────────

function tsComputeAverageLuminance(image: HTMLImageElement): number {
  const canvas = document.createElement('canvas');
  const MAX_SIZE = 256;
  const scale = Math.min(1, MAX_SIZE / Math.max(image.naturalWidth, image.naturalHeight));
  canvas.width  = Math.max(1, Math.floor(image.naturalWidth  * scale));
  canvas.height = Math.max(1, Math.floor(image.naturalHeight * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return 128;
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    sum += data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722;
  }
  return sum / (data.length / 4);
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
    const canvas = document.createElement('canvas');
    const MAX_SIZE = 256;
    const scale = Math.min(1, MAX_SIZE / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width  = Math.max(1, Math.floor(image.naturalWidth  * scale));
    canvas.height = Math.max(1, Math.floor(image.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return tsComputeAverageLuminance(image);

    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const bytes = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

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
