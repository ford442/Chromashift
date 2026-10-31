/**
 * Loader for the optional C++ WebAssembly engine.
 *
 * At runtime this module attempts to load the Emscripten-compiled module at
 * /chromashift_engine.js (which fetches /chromashift_engine.wasm). If the
 * runtime lacks SIMD128, or the module fails to load, `loadWasmEngine` resolves
 * `false` and every dispatcher in `./dispatch.ts` falls back to its TypeScript
 * implementation. Which of the two happened is never silent: it is logged and
 * published as `window.wasmEngineState` / `wasmEngineError` (a worker's own
 * instance reaches `window.wasmEngineWorkers` through its host).
 *
 * Build the C++ engine:
 *   cd cpp && make          # requires Emscripten — see docs/wasm-engine.md
 */

import type { ChromashiftWasmModule, GlueModule, WasmApiFunction } from './types';
import { WASM_API_FUNCTIONS } from './types';
import { publishDiagnostics } from '../diagnostics';

/**
 * Where this realm's engine got to. `unavailable` means the runtime cannot run
 * it at all (no SIMD128); `error` means it should have loaded and did not —
 * the glue failed to import or the module failed to instantiate.
 */
export type WasmEngineState = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';

/** One realm's engine state, as the breadcrumbs and the worker replies carry it. */
export interface WasmEngineStatus {
  state: WasmEngineState;
  /** Why it is `unavailable` or `error`; `null` otherwise. */
  error: string | null;
}

let wasmModule: ChromashiftWasmModule | null = null;
let loadState: WasmEngineState = 'idle';
let loadError: string | null = null;
const pendingResolvers: Array<(ok: boolean) => void> = [];

/** This realm's engine state. Workers send it back with every reply. */
export function getWasmEngineStatus(): WasmEngineStatus {
  return { state: loadState, error: loadError };
}

function settle(state: 'ready' | 'unavailable' | 'error', error: string | null): void {
  loadState = state;
  loadError = error;
  // A no-op in the workers (no `window`); their hosts publish for them.
  publishDiagnostics({ wasmEngineState: state, wasmEngineError: error });
}

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

function wasmHas(fn: WasmApiFunction): boolean {
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
    persistentBufPtr = 0;
    persistentBufSize = 0;
  }
  persistentBufPtr = checkedMalloc(mod, size);
  persistentBufSize = size;
  return persistentBufPtr;
}

/**
 * `_malloc(size)`, or a throw when the heap cannot grow to fit it. With
 * `ALLOW_MEMORY_GROWTH` a failed allocation returns `0` rather than aborting,
 * and every caller would then write the pixels over heap offset 0.
 */
function checkedMalloc(mod: ChromashiftWasmModule, size: number): number {
  const ptr = mod._malloc(size);
  if (ptr === 0) throw new Error(`[WasmEngine] _malloc(${size}) failed: the WASM heap cannot grow that far`);
  return ptr;
}

/** Run `work` with a transient `size`-byte allocation, freed however `work` exits. */
export function withWasmScratch<T>(mod: ChromashiftWasmModule, size: number, work: (ptr: number) => T): T {
  const ptr = checkedMalloc(mod, size);
  try {
    return work(ptr);
  } finally {
    mod._free(ptr);
  }
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
 * The engine is built with `-msimd128` and its pixel kernels contain real
 * `v128` instructions, so a browser without SIMD128 cannot instantiate the
 * module at all — `loadWasmEngine()` treats a failed probe as "unavailable"
 * and every dispatcher falls back to its TypeScript implementation.
 *
 * @returns `true` when the browser supports WASM SIMD128.
 */
export function isWasmSimdSupported(): boolean {
  try {
    return WebAssembly.validate(SIMD_PROBE_MODULE);
  } catch {
    return false;
  }
}

/** Unsigned LEB128, the encoding of every size and count in a WASM binary. */
export function leb128(value: number): number[] {
  const bytes: number[] = [];
  let rest = value >>> 0;
  do {
    const byte = rest & 0x7f;
    rest >>>= 7;
    bytes.push(rest === 0 ? byte : byte | 0x80);
  } while (rest !== 0);
  return bytes;
}

/** One module section: its id, then its contents prefixed by their byte length. */
function wasmSection(id: number, contents: readonly number[]): number[] {
  return [id, ...leb128(contents.length), ...contents];
}

/**
 * The probe module: one function `() -> v128` whose body is `v128.const 0`.
 * Every length is computed, not written by hand — the hand-counted sizes once
 * read 0x0f / 0x0d instead of 22 / 20, which made the module malformed, so
 * `validate()` returned false in every browser and the engine never loaded.
 */
const SIMD_PROBE_MODULE: Uint8Array<ArrayBuffer> = (() => {
  const V128 = 0x7b;
  const body = [
    0x00,                          // no locals
    0xfd, 0x0c, ...new Array<number>(16).fill(0), // v128.const 0
    0x0b,                          // end
  ];
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d,        // magic
    0x01, 0x00, 0x00, 0x00,        // version
    ...wasmSection(0x01, [0x01, 0x60, 0x00, 0x01, V128]),     // type: () -> v128
    ...wasmSection(0x03, [0x01, 0x00]),                       // function: type 0
    ...wasmSection(0x0a, [0x01, ...leb128(body.length), ...body]), // code: one body
  ]);
})();

/**
 * Where the engine is outside a page — Node, for the headless renderer
 * (docs/HEADLESS.md): the glue's URL and the binary's bytes. The glue is built
 * `-s ENVIRONMENT=web,worker` and has no Node file loader, so the bytes are
 * handed to it and it never fetches (as `scripts/bench-wasm.mjs` does).
 */
export interface WasmEngineSource {
  glueUrl: string;
  wasmBinary: Uint8Array;
}

/**
 * Attempt to load the compiled C++ WASM engine — from the page's
 * `public/` assets, or from `source` where there is no page.
 *
 * Safe to call multiple times — subsequent calls resolve with the cached state.
 * Returns `true` when the WASM module loaded successfully, `false` otherwise.
 */
export async function loadWasmEngine(source?: WasmEngineSource): Promise<boolean> {
  if (loadState === 'ready')       return true;
  if (loadState === 'unavailable' || loadState === 'error') return false;

  if (loadState === 'loading') {
    return new Promise<boolean>((resolve) => {
      pendingResolvers.push(resolve);
    });
  }

  if (!isWasmSimdSupported()) {
    // The binary is SIMD128-only — instantiating it here would just throw.
    console.info(
      '[WasmEngine] WebAssembly SIMD128 unsupported — using the TypeScript engine.',
    );
    settle('unavailable', 'WebAssembly SIMD128 is not supported by this runtime');
    return false;
  }

  loadState = 'loading';

  try {
    // Build the URL at runtime so Rollup does not attempt to resolve or bundle it.
    // The Emscripten glue lives in /public/ and is served as a static asset; it is
    // not part of the Vite module graph.
    // `globalThis.location`, not `window.location`: this loader runs inside
    // `analysis.worker.ts` and `motion.worker.ts` too, and a worker realm has
    // no `window` — the ReferenceError used to be swallowed by the catch below
    // and reported as "WASM assets not built", so both workers silently ran the
    // TypeScript fallback forever.
    const engineUrl = source?.glueUrl ?? new URL(
      'chromashift_engine.js',
      new URL(import.meta.env.BASE_URL || './', globalThis.location.href),
    ).href;
    const glue = await import(/* @vite-ignore */ engineUrl) as GlueModule;
    wasmModule = await glue.default(source ? { wasmBinary: source.wasmBinary } : undefined);
    settle('ready', null);
    logStaleWasmExports();

    console.info('[WasmEngine] C++ WASM engine loaded (SIMD128 kernels active).');
  } catch (error) {
    // The artifacts are committed, so this is a real failure — a fetch, an
    // import or an instantiation — not "not built yet". Say which.
    console.warn('[WasmEngine] C++ WASM engine failed to load — using the TypeScript engine:', error);
    settle('error', error instanceof Error ? error.message : String(error));
  }

  const ok = getWasmEngineStatus().state === 'ready';
  for (const resolve of pendingResolvers) resolve(ok);
  pendingResolvers.length = 0;
  return ok;
}

/** Returns `true` when the WASM module is loaded and ready. */
export function isWasmReady(): boolean {
  return loadState === 'ready' && wasmModule !== null;
}
