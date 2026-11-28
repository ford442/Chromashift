/**
 * Where the onnxruntime-web runtime (`ort-wasm-simd-threaded.{mjs,wasm}`) is
 * loaded from at run time.
 *
 * The runtime is not bundled (`check:dist` keeps a 13 MB .wasm out of `dist/`),
 * but it has to be *exactly* the build the bundled `onnxruntime-web` JS was
 * released with: the glue exports the C entry points the JS calls by name, and a
 * different release answers `r._OrtGetInputOutputMetadata is not a function`.
 * That is what the old default, a hand-mirrored copy on `test.1ink.us/nunif/ort`
 * from 2024, did to every waifu2x upscale (#269).
 *
 * So the default is derived from the installed package's version at build time
 * (`__ORT_WEB_VERSION__`, vite.config.ts) and points at the npm CDN, which
 * serves each release immutably with CORS and `Cross-Origin-Resource-Policy:
 * cross-origin` (the page runs under COEP `require-corp`). `VITE_NUNIF_ORT_WASM_BASE`
 * still overrides it, for a self-hosted mirror that is kept in step.
 */

declare const __ORT_WEB_VERSION__: string | undefined;

/** The `onnxruntime-web` version this build bundles; `undefined` outside a Vite build. */
export function bundledOrtVersion(): string | undefined {
  return typeof __ORT_WEB_VERSION__ === 'undefined' ? undefined : __ORT_WEB_VERSION__;
}

export function resolveOrtWasmBase(override: string | undefined, version: string | undefined): string {
  const trimmed = override?.trim();
  if (trimmed) return trimmed.replace(/\/+$/, '');
  if (!version) {
    throw new Error(
      'onnxruntime-web version unknown: set VITE_NUNIF_ORT_WASM_BASE to the directory hosting its runtime files.',
    );
  }
  return `https://cdn.jsdelivr.net/npm/onnxruntime-web@${version}/dist`;
}
