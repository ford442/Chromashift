/**
 * Loader for the optional C++ WebAssembly engine.
 *
 * At runtime this module attempts to load the Emscripten-compiled module at
 * /chromashift_engine.js (which fetches /chromashift_engine.wasm). If the
 * runtime lacks the WebAssembly feature floor (SIMD128, bulk memory, nontrapping
 * float-to-int, sign extension), or the module fails to load twice running,
 * `loadWasmEngine` resolves `false` and every dispatcher in `./dispatch.ts`
 * falls back to its TypeScript
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
 * The WebAssembly features the binary needs beyond MVP. `cpp/Makefile` compiles
 * with `-msimd128 -mbulk-memory -mnontrapping-fptoint -msign-ext` (`WASM_CXXFLAGS`),
 * so a runtime missing any one cannot instantiate the module — keep this list
 * and that flag set in step.
 */
export type WasmFeature = 'simd128' | 'bulk-memory' | 'nontrapping-fptoint' | 'sign-ext';

/**
 * One probe per feature: the smallest function body that uses one of its
 * instructions, with everything it needs on the stack. `memory` is whether the
 * module has to declare a linear memory for the instruction to validate.
 */
const FEATURE_PROBES: ReadonlyArray<{ feature: WasmFeature; body: readonly number[]; memory: boolean }> = [
  {
    feature: 'simd128',
    // v128.const 0; drop
    body: [0xfd, 0x0c, ...new Array<number>(16).fill(0), 0x1a],
    memory: false,
  },
  {
    feature: 'bulk-memory',
    // i32.const 0 (dest); i32.const 0 (value); i32.const 0 (length); memory.fill 0
    body: [0x41, 0x00, 0x41, 0x00, 0x41, 0x00, 0xfc, 0x0b, 0x00],
    memory: true,
  },
  {
    feature: 'nontrapping-fptoint',
    // f32.const 0; i32.trunc_sat_f32_s; drop
    body: [0x43, 0x00, 0x00, 0x00, 0x00, 0xfc, 0x00, 0x1a],
    memory: false,
  },
  {
    feature: 'sign-ext',
    // i32.const 0; i32.extend8_s; drop
    body: [0x41, 0x00, 0xc0, 0x1a],
    memory: false,
  },
];

/**
 * A module with one `() -> ()` function whose body is `instructions`.
 * Every length is computed, not written by hand — the hand-counted sizes of the
 * first SIMD probe once read 0x0f / 0x0d instead of 22 / 20, which made the
 * module malformed, so `validate()` returned false in every browser and the
 * engine never loaded.
 */
function probeModule(instructions: readonly number[], memory: boolean): Uint8Array<ArrayBuffer> {
  const body = [
    0x00,                          // no locals
    ...instructions,
    0x0b,                          // end
  ];
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d,        // magic
    0x01, 0x00, 0x00, 0x00,        // version
    ...wasmSection(0x01, [0x01, 0x60, 0x00, 0x00]),           // type: () -> ()
    ...wasmSection(0x03, [0x01, 0x00]),                       // function: type 0
    ...(memory ? wasmSection(0x05, [0x01, 0x00, 0x00]) : []), // memory: one, no maximum, min 0
    ...wasmSection(0x0a, [0x01, ...leb128(body.length), ...body]), // code: one body
  ]);
}

/**
 * Probe the runtime for the engine's WebAssembly feature floor and return the
 * features it lacks (empty when the binary can run here).
 *
 * Uses `WebAssembly.validate` on a minimal module per feature — the standard
 * technique recommended by the WebAssembly/feature-detection working group.
 * Probing each separately is what lets the failure say *which* feature is
 * missing instead of "unsupported".
 */
export function missingWasmFeatures(): WasmFeature[] {
  return FEATURE_PROBES
    .filter(({ body, memory }) => {
      try {
        return !WebAssembly.validate(probeModule(body, memory));
      } catch {
        return true;
      }
    })
    .map(({ feature }) => feature);
}

/**
 * `true` when the runtime has every feature the binary was compiled with
 * (SIMD128 plus bulk memory, nontrapping float-to-int and sign extension).
 *
 * Each of the other three reached every major engine before SIMD128 did (Chrome
 * 91, Firefox 89, Safari 16.4), so adding them to the floor drops no browser the
 * SIMD requirement had not already dropped. A browser below it
 * cannot instantiate the module at all, so `loadWasmEngine()` treats a failed
 * probe as "unavailable" and every dispatcher falls back to its TypeScript
 * implementation.
 */
export function isWasmFeatureFloorSupported(): boolean {
  return missingWasmFeatures().length === 0;
}

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

/** Attempts at fetching, importing and instantiating the engine before giving up. */
const LOAD_ATTEMPTS = 2;

/** Pause before the retry, so a flaky connection has a moment to recover. */
const LOAD_RETRY_DELAY_MS = 250;

/**
 * The engine's glue and binary, loaded once and retried once.
 *
 * A failed load disables WASM for the rest of the session — `settle('error')` is
 * terminal — so one dropped request on a flaky connection used to cost every CPU
 * kernel its 2.6–7× for as long as the tab lived. A second attempt costs nothing
 * when the first succeeded, and nothing the user can see when it did not.
 *
 * Which half failed decides what the retry repeats. A failed `import()` is
 * retried against a cache-busted URL, because a document's module map may hold on
 * to the failure; a glue that imported but whose `.wasm` fetch or instantiation
 * failed is kept and only its factory is called again.
 */
async function instantiateWithRetry(source: WasmEngineSource | undefined): Promise<ChromashiftWasmModule> {
  let glue: GlueModule | null = null;
  let engineUrl: string | null = null;
  for (let attempt = 1; ; attempt += 1) {
    try {
      if (glue === null) {
        // `/chromashift_engine.js` is a file in `public/`, served as a static asset
        // and not part of the Vite module graph, so the `import()` below is
        // `@vite-ignore`d. The URL is still written as `new URL(path,
        // import.meta.url)` on purpose: Vite rewrites that in a build to the
        // path from *this chunk* to the public file, whatever `base` is, and
        // leaves it an origin-absolute path in dev.
        //
        // It used to be `new URL(BASE_URL, location.href)`. `location` is the
        // *page* on the main thread but the *worker script* in a worker, so with
        // the build's `base: './'` the two workers looked for
        // `/assets/chromashift_engine.js`, got a 404, and ran the TypeScript
        // fallback in production while the dev server (whose base is `/`) hid it
        // - the `wasm-engine` spec against `vite preview` is what caught it.
        engineUrl ??= source?.glueUrl ?? new URL('/chromashift_engine.js', import.meta.url).href;
        const url = attempt === 1 ? engineUrl : `${engineUrl}${engineUrl.includes('?') ? '&' : '?'}retry=${attempt}`;
        glue = await import(/* @vite-ignore */ url) as GlueModule;
      }
      return await glue.default(source ? { wasmBinary: source.wasmBinary } : undefined);
    } catch (error) {
      if (attempt >= LOAD_ATTEMPTS) throw error;
      console.warn(`[WasmEngine] load attempt ${attempt} of ${LOAD_ATTEMPTS} failed — retrying:`, error);
      await new Promise<void>((resolve) => setTimeout(resolve, LOAD_RETRY_DELAY_MS));
    }
  }
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

  const missing = missingWasmFeatures();
  if (missing.length > 0) {
    // The binary is built for the whole floor — instantiating it here would just throw.
    const reason = `WebAssembly ${missing.join(', ')} not supported by this runtime`;
    console.info(`[WasmEngine] ${reason} — using the TypeScript engine.`);
    settle('unavailable', reason);
    return false;
  }

  loadState = 'loading';

  try {
    wasmModule = await instantiateWithRetry(source);
    settle('ready', null);
    logStaleWasmExports();

    console.info('[WasmEngine] C++ WASM engine loaded (SIMD128 kernels active).');
  } catch (error) {
    // The artifacts are committed, so this is a real failure — a fetch, an
    // import or an instantiation, twice running — not "not built yet". Say which.
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
