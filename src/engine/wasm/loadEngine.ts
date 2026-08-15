/**
 * Loader for the optional C++ WebAssembly engine.
 *
 * At runtime this module attempts to load the Emscripten-compiled module at
 * /chromashift_engine.js (which fetches /chromashift_engine.wasm). If those
 * assets are absent (i.e. the C++ engine has not been built yet) `loadWasmEngine`
 * resolves `false` and every dispatcher in `./dispatch.ts` transparently falls
 * back to its TypeScript implementation.
 *
 * Build the C++ engine:
 *   cd cpp && make          # requires Emscripten — see docs/wasm-engine.md
 */

import type { ChromashiftWasmModule, GlueModule, WasmApiFunction } from './types';
import { WASM_API_FUNCTIONS } from './types';

type LoadState = 'idle' | 'loading' | 'ready' | 'unavailable';

let wasmModule: ChromashiftWasmModule | null = null;
let loadState: LoadState = 'idle';
const pendingResolvers: Array<(ok: boolean) => void> = [];

/**
 * A single reusable WASM heap allocation for input pixel buffers.
 *
 * Rather than calling `_malloc` / `_free` on every function call, we keep a
 * persistent allocation and only grow it when a larger size is needed.  This
 * eliminates allocator overhead for batch operations on identically-sized
 * images and reduces GC pressure from repeated typed-array wrapping.
 *
 * The buffer is only freed when a new (larger) size is requested; it is never
 * shrunk.  Because JavaScript is single-threaded there is no risk of
 * concurrent access.
 */
let persistentBufPtr: number = 0;
let persistentBufSize: number = 0;

/** Returns the loaded module, or `null` when the WASM engine is not ready. */
export function getWasmModule(): ChromashiftWasmModule | null {
  return wasmModule;
}

export function wasmHas(fn: WasmApiFunction): boolean {
  return wasmModule !== null && typeof wasmModule[fn] === 'function';
}

export function canUseWasmFn(fn: WasmApiFunction, useWasm: boolean): boolean {
  return useWasm && wasmHas(fn);
}

/**
 * Return a persistent WASM heap pointer that can hold at least `size` bytes.
 * Must only be called when `getWasmModule()` is non-null.
 */
export function getPersistentBuf(size: number): number {
  const mod = wasmModule;
  if (!mod) throw new Error('[WasmEngine] getPersistentBuf called before the WASM module loaded');
  if (size <= persistentBufSize && persistentBufPtr !== 0) {
    return persistentBufPtr;
  }
  if (persistentBufPtr !== 0) {
    mod._free(persistentBufPtr);
  }
  persistentBufPtr = mod._malloc(size);
  persistentBufSize = size;
  return persistentBufPtr;
}

function logStaleWasmExports(): void {
  const missing = WASM_API_FUNCTIONS.filter((fn) => !wasmHas(fn));
  if (missing.length === 0) return;
  console.warn(
    `[WasmEngine] Stale WASM build — missing ${missing.length}/${WASM_API_FUNCTIONS.length} exports `
    + `(${missing.join(', ')}). Falling back to TypeScript for those calls. `
    + 'Rebuild with: cd cpp && make',
  );
}

/**
 * Probe the browser for WebAssembly SIMD (v128) support.
 *
 * Uses `WebAssembly.validate` on a minimal module containing a `v128.const`
 * instruction.  This is the standard technique recommended by the
 * WebAssembly/feature-detection working group.
 *
 * @returns `true` when the browser supports WASM SIMD128.
 */
export function isWasmSimdSupported(): boolean {
  try {
    // Minimal WASM binary: () -> v128, returns v128.const 0
    // Sections: type(1), function(1), code(1 function body with v128.const + end)
    return WebAssembly.validate(new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, // magic
      0x01, 0x00, 0x00, 0x00, // version
      // type section: 1 type, () -> v128
      0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,
      // function section: 1 function, type index 0
      0x03, 0x02, 0x01, 0x00,
      // code section: 1 body
      0x0a, 0x0f, 0x01,       // section id, size, count
      0x0d, 0x00,             // body size, local count
      0xfd, 0x0c,             // v128.const
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x0b,                   // end
    ]));
  } catch {
    return false;
  }
}

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
    const assetBaseUrl = new URL(import.meta.env.BASE_URL || './', window.location.href);
    const engineUrl = new URL('chromashift_engine.js', assetBaseUrl).href;
    const glue = await import(/* @vite-ignore */ engineUrl) as GlueModule;
    wasmModule = await glue.default();
    loadState = 'ready';
    logStaleWasmExports();

    // Log SIMD availability so developers can confirm the accelerated path is active.
    const simd = isWasmSimdSupported();
    console.info(
      `[WasmEngine] C++ WASM engine loaded. SIMD128: ${simd ? '✅ supported' : '⚠️ not supported (scalar fallback)'}`,
    );
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
