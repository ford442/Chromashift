# C++ WebAssembly Engine

Chromashift ships two parallel computation engines:

| Engine | Source | Always available? |
|--------|--------|-------------------|
| **TypeScript** | `src/engine/WasmEngine.ts` (barrel) → `src/engine/wasm/` (loader, dispatch, fallbacks) | ✅ Yes |
| **C++ WASM** | `cpp/chromashift_engine.cpp` → `public/chromashift_engine.{js,wasm}` | After building (see below) |

Both engines expose the same public API through `src/engine/WasmEngine.ts`. If the WASM
binary has not been built, all calls automatically fall back to the TypeScript implementation —
the application always works.

---

## Runtime scope

The C++ WASM engine is a **load-time analysis accelerator**, not a replacement for the GPU
render loop. Toggling **C++ WASM** in the Engine panel routes specific CPU-side work through
the compiled module when it is available; the WebGPU/WGSL pipeline remains the source of truth
for real-time rendering.

| Category | Functions | Role |
|---|---|---|
| **In scope (load-time)** | `computeAverageLuminanceWith`, `computeAverageLuminanceStridedWith`, `classifyImageMaskWith`, histogram/band helpers | Average luminance and classification masks when GPU compute analysis (#82) is unavailable; strided luminance for large (4K–8K) and upscaled buffers |
| **In scope (export / offline)** | `advanceAnglesBy` | Video-export angle stepping when Engine = C++ WASM |
| **Out of scope (GPU)** | Layer rotation, persistence/compositing, tracer decay, tracer overlap detection | Handled by WGSL/GLSL shaders in `WebGPURenderer` / `WebGLRenderer`; the per-frame decay multiplier is the pure `durationToDecay()` in `math/decay.ts` (constants from `shared/decay.json`, see [Shared decay table](#shared-decay-table-shareddecayjson)), and the 3-layer overlap ("coincidence") detection is a `gpu-chores` compute pass (`op: 'coincidence'`, see `docs/gpu-bootstrap.md`) with a fragment-shader fallback — neither is ever dispatched through WASM |
| **Test / benchmark only** | `durationToDecayWith`, `simulateTracerDecayWith`, `buildRotationMat3With`, `computeLuminanceHistogramWith`, `computeColorBandCountsWith`, bulk classify helpers | `public/wasm-benchmark.html`, C++ host tests, WASM/TS parity tests — not used in the live render loop |

**Selection order for image analysis** — encoded in the **`gpu-chores`** facade
(`src/engine/compute/chores/`) as `CHORE_BACKEND_ORDER` and walked by
`runJob({ op: 'image-analysis', prefer: 'auto' })`. `useClassificationMask.ts`
calls the facade rather than branching itself:

1. WebGPU compute histogram + mask (preferred when available).
2. C++ WASM classification mask + strided/full luminance (when Engine = C++ WASM).
3. TypeScript fallbacks in `WasmEngine.ts` (always available).

WebGL2 is deliberately not a lane. The WASM and TypeScript lanes are bound to
`WasmEngine` by `chores/chromashiftHost.ts`, which is also the seam a sibling
app replaces with its own CPU implementation. Failures are never silent:
`runJob` returns `{ ok: false, reason, attempts }` naming why each lane
declined. See [docs/gpu-bootstrap.md](gpu-bootstrap.md#gpu-chores-compute-device-adoption).

**Lanes 2 and 3 run off the main thread.** Both the WASM and TypeScript
lanes' work — `<canvas>.getImageData()` on the loaded image, then classifying
every pixel — is driven through `CpuChoreHost.analyzeImage()`
(`chores/types.ts`), which `useClassificationMask.ts` backs with
`chores/analysisWorkerHost.ts` in production. That host lazily spawns
`src/engine/compute/analysis.worker.ts`, a module worker holding its **own**
loaded instance of the WASM engine (loaded via `loadWasmEngine()` same as the
main thread — `loadEngine.ts` keeps its state module-scoped, so a separate
realm gets a separate, independently-loaded module rather than sharing one),
and calls the same `computeImageAverageLuminanceWith` /
`classifyImageMaskWith` dispatchers against a transferred `ImageBitmap` +
`OffscreenCanvas` instead of an `HTMLImageElement` + DOM `<canvas>` (the
`PixelSource` union in `wasm/imageBytes.ts` covers both) — so the mask is
byte-identical to the pre-worker, main-thread path. This matters most for an
8K source (`8192×8192×4` ≈ 268 MB) on exactly the renderer configurations
that route through these lanes (`?renderer=webgl`, Firefox/Safari,
`?no_gpu_compute`, or a WebGPU compute decline): before this, that readback
and classification ran synchronously on the thread driving
`requestAnimationFrame`.

The worker loads lazily — only on the first CPU-lane job, so a healthy
WebGPU session never spawns it — and `check:dist` asserts it lands in its
own `dist/assets/analysis.worker-*.js` chunk rather than the main bundle. If
the worker can't be used (construction throws, `createImageBitmap` throws,
or it reports an error), the host falls back permanently, for its own
lifetime, to an in-process implementation (`createChromashiftCpuHost` in
`chromashiftHost.ts`) — same thread, same math — so a job is never silently
dropped. That in-process host is also what Vitest and the WASM/TS parity
tests use directly, since Vitest's `node` test environment has neither a
real `Worker` nor `OffscreenCanvas`. Because of that gap, the byte-identity
claim above is covered by a Playwright spec rather than a unit test:
`e2e/analysis-worker-mask-parity.spec.ts` runs both real hosts in a browser
against one source image and compares the two masks byte for byte (asserting
`mode === 'worker'` first, so a silent fallback to the in-process lane fails
the spec instead of passing it vacuously).

`window.gpuChoreBackend` reflects this distinction for diagnostics: it reads
`wasm-worker` / `ts-worker` when the analysis worker served the job, or
`wasm-inline` / `ts-inline` when it ran in-process — separate from
`ChoreResult.backend` (`'webgpu' | 'wasm' | 'ts'`), which stays the plain
lane-selection enum pinned-lane parity tests rely on.

---

## Call-site matrix

Every production call site of a `*With()` dispatcher (or of `loadWasmEngine` / `isWasmReady`),
grouped by phase. Functions with no row here are exercised only by `public/wasm-benchmark.html`
and the unit/C++ host tests — see "Test / benchmark only" above.

| Function | Called from | Phase |
|---|---|---|
| `loadWasmEngine` | `hooks/useAppLifecycle.ts` | App startup |
| `isWasmReady` | `hooks/appUiProps/buildControlProps.ts` | UI state (Engine badge) |
| `computeAverageLuminanceWith` | `hooks/useAppWebGPUInit.ts` | Load-time (image load) |
| `computeAverageLuminanceStridedWith` | `engine/LiveSource.ts`, `hooks/useMediaHandlers.ts`; also called internally by `computeImageAverageLuminanceWith` | Load-time / live source |
| `computeImageAverageLuminanceWith` | `hooks/useMediaHandlers.ts`, `hooks/useImagePlayback.ts` (both only on the mask-generation error path); also called by `chores/chromashiftHost.ts` and, inside the analysis worker, `analysis.worker.ts` — both reached indirectly from `hooks/useClassificationMask.ts` via `CpuChoreHost.analyzeImage`/`computeAverageLuminance` | Load-time |
| `classifyImageMaskWith` | `chores/chromashiftHost.ts` and, inside the analysis worker, `analysis.worker.ts` — both reached indirectly from `hooks/useClassificationMask.ts` via `CpuChoreHost.analyzeImage` | Load-time (mask generation) |
| `advanceAnglesBy` | `engine/videoExport/exportVideoFrameLoop.ts` | Video export |

No `*With()` dispatcher is called from a per-frame render or animation-loop path
(`useAnimationLoop.ts`, `PersistencePass.ts`, `WebGPURenderer.ts` / `WebGLRenderer.ts`
compositor and persistence passes). Tracer decay used to be the one documented exception
(`durationToDecayWith`, routed through WASM per frame for formula parity only); it now
calls `durationToDecay()` from `math/decay.ts` directly (see [#145](https://github.com/ford442/Chromashift/issues/145)).
Any new per-frame call site into `src/engine/wasm/` should be treated as a scope violation —
update this table if one is ever intentionally added.

---

## What is implemented in C++

### Luminance & colour analysis

| C++ function | TS dispatcher | Description |
|---|---|---|
| `computeAverageLuminance` | `computeAverageLuminanceWith` | ITU-R BT.709 average luminance over an RGBA pixel buffer |
| `computeAverageLuminanceStrided` | `computeAverageLuminanceStridedWith` | Strided luminance for large (4K–8K) images |
| `classifyPixel` | `classifyPixelWith` | Maps a single pixel's RGB + avgLum to a colour-band index (0–10) |
| `buildBandLut` | `buildBandLut` (TS) / WASM heap | 256-entry band LUT from avgLuminance |
| `classifyPixelsBulk` | `classifyPixelsBulkWith` | Batch version of `classifyPixel` — one WASM call for the whole image |
| `classifyPixelsBulkLut` | — | Bulk classification via the band LUT (scalar) / the SIMD ladder |
| `computeClassificationMask` | `classifyImageMaskWith` | Generates compact uint8 band mask (`width × height`) for GPU `r8uint` texture upload |
| `computeClassificationMaskLut` | `classifyImageMaskWith` (preferred WASM path) | Byte-identical mask via the LUT shortcut (scalar) / the SIMD ladder |
| `computeLuminanceHistogram` | `computeLuminanceHistogramWith` | 256-bucket ITU-R BT.709 luminance histogram |
| `computeColorBandCounts` | `computeColorBandCountsWith` | 11-bucket pixel count per Chromashift colour band |
| `buildRotationMat3` | `buildRotationMat3With` | Column-major 3×3 rotation matrix (matches `rotation.ts`) |

### Frame timing & tracer helpers

| C++ function | TS dispatcher | Description |
|---|---|---|
| `durationToDecay` | `durationToDecayWith` | Per-frame decay multiplier for tracer persistence timing |
| `advanceLayerAngles` | `advanceAnglesBy` | Step `count` layer angles with 360° wrapping |
| `advanceLayerAngles3` | — | Deprecated three-wide wrapper; see below |
| `simulateTracerDecay` | `simulateTracerDecayWith` | Apply per-frame decay to a Float32 RGBA buffer in-place (CPU-side tracer simulation) |

`advanceLayerAngles` takes `(const float* angles, const float* steps, float* out,
uint32_t count)` — a session runs 1–10 band layers, so the angle list is a heap
array rather than a fixed argument list. `out` may alias `angles`.

`advanceLayerAngles3` is the previous six-float signature, kept for one release
so a not-yet-rebuilt `public/chromashift_engine.wasm` stays usable. It doubles as
the ABI-generation marker: an older module exports `_advanceLayerAngles` with the
*old* signature and no `_advanceLayerAngles3`, so `advanceAnglesBy()` requires
both symbols before taking the WASM path and otherwise falls back to TypeScript.
Rebuild the artifact (`npm run build:wasm`), then drop the wrapper and that gate
together.

### Colour band classification logic

The classification pre-processing (shared by all per-pixel functions) replicates the WGSL
fragment-shader logic exactly:

```
diff      = (avgLuminance / 255) × 32
lightDark = 128 + |avgLuminance − 128| / 2
rgb       = lum + lightDark / 2
```

Then `rgb` is compared against the same thresholds used in the shaders:

| Band | Threshold | Layer | Output colour |
|---|---|---|---|
| Grey highlight | `rgb > 229` | 0 | Near-white |
| Orange | `209 < rgb ≤ 229` | 0 | Orange |
| Red | `193 < rgb ≤ 209` | 0 | Red |
| Border red | `190 < rgb ≤ 193` | 0 | Pure red |
| Violet | `177 < rgb ≤ 190` | 1 | Violet |
| Blue | `161 < rgb ≤ 177` | 1 | Blue |
| Border blue | `158 < rgb ≤ 161` | 1 | Pure blue |
| Green | `145 < rgb ≤ 158` | 2 | Green |
| Yellow | `128 < rgb ≤ 145` | 2 | Yellow |
| Border yellow | `125 < rgb ≤ 128` | 2 | Pure yellow |
| Dark / grey | `rgb ≤ 126` | All | Dark grey |

---

## Shared band table (`shared/band.json`)

Band thresholds are authored once in `shared/band.json` and consumed by:

| Consumer | Mechanism |
|---|---|
| TypeScript | `import` in `bandClassification.ts` |
| C++ | `npm run codegen:band` → `cpp/band_table.h` |
| WGSL | `BAND_WGSL` in `bandLiterals.ts` (from the same TS `BAND` object) |
| GLSL (WebGL) | `BAND_GLSL` in `bandLiterals.ts`, interpolated in `webgl/shaders/bandGlsl.ts` |

Edit `shared/band.json` — WGSL/GLSL/TS pick up changes on the next `npm run dev`, `npm test`, or `npm run build` (no emsdk). Run `npm run codegen:band` when the JSON changes so `cpp/band_table.h` stays in sync, then rebuild WASM.

---

## Shared decay table (`shared/decay.json`)

The tracer-persistence fade constants follow the same pattern — authored once in
`shared/decay.json`, never hand-written into a shader:

| Constant | Meaning |
|---|---|
| `residualBrightness` | Brightness fraction a tracer retains after its configured duration (0.1 = 10%) |
| `overlapDecayExponent` | Decay exponent for a pixel where 2+ layers overlap — fades faster |
| `idleDecayExponent` | Decay exponent with no current overlap — the plain decay rate |

| Consumer | Mechanism |
|---|---|
| TypeScript | `import` in `math/decay.ts` — `durationToDecay()` (per-frame multiplier) and `effectiveDecay()` (the per-pixel exponent switch, the shaders' reference implementation) |
| C++ | `npm run codegen:decay` → `cpp/decay_table.h`, consumed by `durationToDecay` in `chromashift_engine.cpp` |
| WGSL | `DECAY_WGSL` in `shaders/decayLiterals.ts`, interpolated into `shaders/persistence.ts` (both the fused and the compute-fed composite shader) |
| GLSL (WebGL) | `DECAY_GLSL` in `shaders/decayLiterals.ts`, interpolated into `webgl/shaders/persistence.ts` |

`src/engine/shaders/decayTable.test.ts` is the divergence guard (the
`bandTable.test.ts` counterpart): it pins TS ↔ shader literals ↔ `cpp/decay_table.h`
↔ `shared/decay.json` and fails if a shader module hand-writes the overlap
exponent again. `cpp/tests/test_engine.cpp` covers the C++ formula parity —
`durationToDecay` against the canonical residual, and the exponent switch
against `effectiveDecay()`. There is deliberately **no** WASM export for the
exponent switch: it runs per pixel on the GPU.

Note `npm run codegen` runs both generators (`codegen:band` + `codegen:decay`);
`build:wasm*` calls it for you.

---

## SIMD128 kernels, the band ladder, and the LUT

### Branchless band ladder

`classifyRgb()` no longer scans `BAND_THRESHOLDS` for the first match. The thresholds are
strictly descending, so the number a value clears determines the band directly:

```
band = BAND_COUNT - (number of thresholds rgb exceeds)
```

Clearing none yields `BAND_COUNT`, which is exactly `DARK_BAND_INDEX`. Two `static_assert`s
in `chromashift_engine.cpp` pin both properties, so a `shared/band.json` edit that breaks
either fails the build instead of silently returning wrong bands. The result is constant
time, branch-free, and — crucially — vectorisable as a chain of `wasm_f32x4_gt` compares.

### SIMD128 kernels

Every bulk kernel has a hand-written `wasm_simd128.h` path guarded by `__wasm_simd128__`:

| Kernel | Vector strategy |
|---|---|
| `computeAverageLuminance` / `…Strided` (stride 1) | Widen RGBA bytes into a `[R,G,B,A]` u32 lane accumulator, drained into `double` every 2²⁰ pixels; weights applied once at the end |
| `computeClassificationMask{,Lut}` | 16 pixels per iteration: 4× (luminance → ladder), narrowed to one 16-byte mask store |
| `classifyPixelsBulk{,Lut}` | 4 pixels per iteration, i32 band indices stored directly |
| `computeLuminanceHistogram` | Vectorised luminance + `trunc_sat`; the bucket increment is a scatter, so lanes are drained scalar |
| `computeColorBandCounts` | Vectorised ladder, scalar tally |
| `simulateTracerDecay` | Straight `f32x4` multiply |

Output is bit-identical to the scalar path. The luminance step issues its three multiplies
and two adds in the same order as the scalar code and f32 lanes round exactly like scalar
f32, and the ladder is the same comparison set. The average-luminance kernels changed
formulation — integer channel sums weighted once, instead of a running `double` sum — which
removes accumulated rounding error rather than adding any, and returns the same `float`.

The scalar bodies are still compiled and are what the host `g++` build runs, so
`cpp/tests/test_engine.cpp` keeps checking them against a verbatim copy of the original
linear scan.

### Band LUT

`buildBandLut(avgLum)` amortises the per-pixel threshold chain into a 256-entry table.
`computeClassificationMaskLut` uses a hybrid lookup: when adjacent luminance buckets share
the same band the LUT value is returned directly; at bucket boundaries the exact float `rgb`
path runs so masks stay byte-identical to the branchy classifier.

Because `classifyRgb()` is monotonically non-increasing, "both neighbouring buckets agree"
implies every value between them agrees too — which is why the SIMD build can run the plain
ladder for all lanes in the `…Lut` kernels and still produce identical bytes. The LUT walk
remains the scalar path (and the host-test subject); with the ladder now constant time, the
LUT's data-dependent shortcut no longer buys anything on the vector path.

### Benchmark and the CI perf gate

```bash
npm run bench:wasm             # report throughput of every bulk kernel
npm run bench:wasm -- --assert # enforce the floors (how CI runs it)
```

`scripts/bench-wasm.mjs` loads the committed artifacts in Node (passing `wasmBinary`, since
`-s ENVIRONMENT=web,worker` leaves the glue with no Node file loader) and runs every bulk
kernel over a deterministic 3840×2160 golden image. It fails when a kernel drops below its
throughput floor, so losing the SIMD path fails the `wasm` job instead of silently
un-accelerating the CPU fallback lane. The golden image, kernel list and floors live in
`public/wasm-benchmark-core.mjs`, which `/wasm-benchmark.html` imports too — open that page
after `npm run build:wasm` to run the identical benchmark in a browser.

Measured on the PR that introduced these kernels (Node 22, 3840×2160, median of 7).
"Before" is the previous build — scalar kernels with `-msimd128 -msse2` set and nothing but
LLVM auto-vectorisation to show for it:

| Kernel | Before | After (SIMD128) | Speedup | Floor |
|---|---|---|---|---|
| `computeAverageLuminance` | 614 Mpx/s | 1595 Mpx/s | 2.6× | 800 |
| `computeClassificationMask` | 87 Mpx/s | 612 Mpx/s | 7.0× | 250 |
| `computeClassificationMaskLut` | 141 Mpx/s | 606 Mpx/s | 4.3× | 250 |
| `computeLuminanceHistogram` | 211 Mpx/s | 558 Mpx/s | 2.6× | 250 |
| `computeColorBandCounts` | 84 Mpx/s | 393 Mpx/s | 4.7× | 150 |

Rebuilding the *current* source without `-msimd128` — i.e. the scalar bodies these kernels
still keep — gives 1298 / 146 / 147 / 212 / 115 Mpx/s, below every floor except
`computeAverageLuminance`, which is memory-bound enough that its floor is only a
gross-regression check. (Its scalar path is much faster than the old one because the
integer-sum rewrite applies to both.)

---

### Prerequisites

1. Install the [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html) at the **pinned version** in `cpp/emsdk.version`:

   ```bash
   git clone https://github.com/emscripten-core/emsdk.git
   cd emsdk
   ./emsdk install "$(cat /path/to/Chromashift/cpp/emsdk.version)"
   ./emsdk activate "$(cat /path/to/Chromashift/cpp/emsdk.version)"
   source ./emsdk_env.sh   # add emcc to PATH
   ```

   `cpp/emsdk.version` is the single source of truth: `.github/workflows/wasm.yml` reads it to install the same toolchain, and `make -C cpp check` warns when the active `emcc` disagrees. Closure output is only reproducible for a pinned version, which is what makes the "committed artifacts match a clean rebuild" check meaningful — building with a different emsdk will show `public/chromashift_engine.*` as spuriously stale.

2. Verify the install:

   ```bash
   emcc --version
   ```

### Build targets

| Command | Makefile target | Flags | Use |
|---|---|---|---|
| `npm run build:wasm` | `make release` | `-O3` | Production / default dev |
| `npm run build:wasm:debug` | `make debug` | `-O0 -g -s ASSERTIONS=1` | WASM debugging |
| `npm run build:wasm:force` | `make rebuild` | `-O3` after `clean` | Force recompile (stale artifacts / equal mtimes) |
| `npm run codegen` | `make codegen` | — | Regenerate every `cpp/*_table.h` from `shared/*.json` |
| `npm run codegen:band` | — | — | Regenerate `cpp/band_table.h` from `shared/band.json` |
| `npm run codegen:decay` | — | — | Regenerate `cpp/decay_table.h` from `shared/decay.json` |

```bash
npm run codegen        # shared/band.json + shared/decay.json → cpp/*_table.h
npm run build:wasm     # release: public/chromashift_engine.{js,wasm}
npm run build:wasm:debug
npm run build:wasm:force   # clean + release when make says "Nothing to be done"
# equivalent: cd cpp && make release | make debug | make rebuild
```

`make` tracks build mode (release/debug) and emcc flags in local stamp files
(`cpp/.wasm_mode`, `cpp/.wasm_flags`). Switching mode, editing `EXPORTED_FUNCS`,
or changing `shared/band.json` / `shared/decay.json` invalidates
`public/chromashift_engine.*` so the
next build is not a silent no-op. If you still see `Nothing to be done for 'all'`
with stale glue (common after a git checkout of committed WASM), run
`make -C cpp rebuild` or `npm run build:wasm:force`.

The release build also passes `-fno-exceptions`, `-flto` and `--closure 1` for smaller
output; debug builds skip the last two so stack traces and `ASSERTIONS` output stay readable.

### Build

```bash
npm run build:wasm   # produces public/chromashift_engine.js + public/chromashift_engine.wasm
```

The output lands in `public/` so Vite's dev server and production build both serve the files.

### Verify

```bash
npm run check:wasm          # checks that emcc is on PATH
make -C cpp verify-exports  # EXPORTED_FUNCTIONS matches chromashift_engine.h 1:1
npm run test:cpp            # host-side g++ unit tests (band ladder, bulk kernels, durationToDecay)
npm run test:cpp:werror     # same tests, -Werror — what CI's wasm job runs
npm run bench:wasm -- --assert  # kernel throughput floors (the CI perf gate)
```

### Warnings and sanitizers

The host test compile and the `emcc` build both carry `-Wall -Wextra`, so a warning cannot be present in the shipped `.wasm` while being invisible to the test gate.

| Command | What it does |
|---|---|
| `npm run test:cpp` | Host tests, warnings printed |
| `npm run test:cpp:werror` | Host tests with `-Werror` — **the CI gate**; a new implicit conversion or unused parameter fails the `wasm` job |
| `npm run test:cpp:asan` | Host tests under `-fsanitize=address,undefined`. Optional: the instrumented binary is several times slower, so it is **not** part of the per-PR gate. Run it when touching pointer arithmetic in the bulk/LUT kernels. Host-only — sanitizers are never applied to the shipped `.wasm`. |

### Editor setup (clangd)

```bash
npm run compile-commands    # writes cpp/compile_commands.json
```

This emits a database for the **host** (`g++`) compile — the same invocation as `make -C cpp test` — so clangd gives diagnostics and jump-to-definition on the engine's scalar bodies (`classifyRgb`, `computeAverageLuminance`, …). It is gitignored because it embeds an absolute `directory` path; regenerate it per checkout. `cpp/.clangd` points clangd at it.

The SIMD kernels are guarded by `__wasm_simd128__`, which a host target never defines, so clangd greys those blocks out. That is expected — they are built by `emcc -msimd128`, not by the host compiler, and there is no attempt to coax clangd onto a wasm32 target.

### Clean

```bash
npm run clean:wasm   # or: cd cpp && make clean
```

---

## Export strategy: one C ABI

The module exports its functions **once**, through the flat C ABI:
`EMSCRIPTEN_KEEPALIVE` in `chromashift_engine.h` plus the `EXPORTED_FUNCS` list in
`cpp/Makefile`, which Emscripten surfaces on the module as `_name`. Pointer arguments are
offsets into the WASM heap — the TS bridge writes inputs through `HEAPU8` and reads results
back through the matching heap view:

```ts
const mod = getWasmModule()!;
const inPtr = getPersistentBuf(data.length);
mod.HEAPU8.set(data, inPtr);
mod._computeClassificationMaskLut(inPtr, width, height, avgLum, outPtr);
```

There used to be a second ABI: an `EMSCRIPTEN_BINDINGS(chromashift_engine)` block of
`optional_override` lambdas whose bodies were nothing but `reinterpret_cast<T*>(uintptr_t)`
— i.e. a re-implementation of the same C ABI through embind. It was removed, along with the
`--bind`, `-fno-rtti` and `-DEMSCRIPTEN_HAS_UNBOUND_TYPE_NAMES=0` flags it needed.

`make -C cpp verify-exports` is the single source of truth for the export list: it fails if
any `EMSCRIPTEN_KEEPALIVE` symbol in the header is missing from `EXPORTED_FUNCS`. It runs in
both the `wasm` job of `ci.yml` and the `wasm-freshness` job of `wasm.yml`. Adding a function
means touching three places — the header, `EXPORTED_FUNCS`, and `WASM_API_FUNCTIONS` in
`src/engine/wasm/types.ts` (which `loadEngine.ts` checks at load time to warn about a stale
build).

---

## Emscripten flag audit

`cpp/Makefile`'s `EMFLAGS_COMMON` against what `src/engine/wasm/` actually calls at runtime.

| Flag | Verdict | Reasoning |
|---|---|---|
| `--bind` (embind) | **Removed** | Every binding was a `reinterpret_cast` passthrough over the C ABI the module already exported. The TS bridge now calls `mod._name(...)` directly — see "Export strategy" above. Dropping it also dropped `-fno-rtti` and `-DEMSCRIPTEN_HAS_UNBOUND_TYPE_NAMES=0`, which existed only to make embind compile. |
| `-Wall -Wextra` | **Added** | Warning parity with the host test compile, which CI runs at `-Werror` (`npm run test:cpp:werror`). Both builds see the same sources, so a warning that fails the test gate must not be silently absent from the shipped build. |
| `-msse2` | **Removed** | Nothing includes `<emmintrin.h>`; the SIMD kernels use `<wasm_simd128.h>` directly, which needs only `-msimd128`. |
| `-s EXPORTED_FUNCTIONS=[...]` | **Keep — now the only ABI** | Produces `_malloc` / `_free` and every engine entry point. Guarded by `verify-exports`. |
| `-msimd128` | **Keep — load-bearing** | Enables the hand-written `wasm_simd128.h` kernels (`__wasm_simd128__`). See "SIMD status" below. |
| `-flto` (release) | **Added** | Whole-program optimisation across the single TU and libc; part of the drop from 47.2 kB to 33.4 kB of `.wasm`. |
| `--closure 1` (release) | **Added** | The glue is a thin C-ABI shim, so Closure has nothing to break: 10.7 kB → 4.9 kB. Off in debug builds. Output is reproducible for a pinned emsdk version, which `wasm.yml`'s freshness check relies on. |
| `-s ENVIRONMENT=web,worker` | **Added** | The engine only ever runs in a browser window or a Web Worker (the analysis worker included); this drops the Node/shell detection branches from the glue. Node callers such as `scripts/bench-wasm.mjs` pass `wasmBinary` instead of relying on a file loader. |
| `-s FILESYSTEM=0` | **Added** | Nothing in the engine touches a file; this drops the FS glue entirely. |
| `-s INITIAL_MEMORY=67108864` (64 MiB) | **Keep — documented, not dead** | 64 MiB = 8192 × 8192 bytes, i.e. exactly one full-resolution single-channel classification mask for an 8K-square image (`classifyImageMaskWith`'s `computeClassificationMask(Lut)` output buffer). Sizing the initial heap to cover that common load-time allocation without a growth event avoids the first-touch pause `ALLOW_MEMORY_GROWTH` growth otherwise causes on the largest images Chromashift documents supporting (4K–8K). Larger simultaneous allocations (input RGBA + mask output together can exceed 64 MiB for 8K) still rely on `ALLOW_MEMORY_GROWTH=1` to grow past this floor — 64 MiB is a "no growth stall for the common case" starting point, not a hard ceiling. |
| `-s ALLOW_MEMORY_GROWTH=1` | **Keep** | Required so allocations above the 64 MiB floor (e.g. concurrent input + output buffers for `classifyPixelsBulkWith` / `classifyImageMaskWith` on 8K images) don't hard-fail. |
| `-s MODULARIZE=1` + `-s EXPORT_ES6=1` | **Keep** | Correct for Vite — `loadEngine.ts` does a dynamic `import()` of `/chromashift_engine.js` and calls the default export as a factory (`await glue.default()`); a non-modularized build would attach a global instead. |
| `-fno-exceptions` | **Keep** | Smaller output; the C API surface in `chromashift_engine.h` does not throw. |

**Net result:** artifact sizes dropped from 33.9 kB glue + 47.2 kB wasm to **4.9 kB glue +
33.4 kB wasm**.

---

## SIMD status and browser support

The WASM engine is compiled with `-msimd128` and its pixel kernels contain real `v128`
instructions (`cpp/chromashift_engine.cpp`, guarded by `__wasm_simd128__`). SIMD128 is
therefore a **hard requirement** of the binary, not an opportunistic optimisation.

| Browser | SIMD128 support |
|---|---|
| Chrome 91+ / Edge 91+ | ✅ Full SIMD128 |
| Chrome < 91 | ❌ WASM engine unavailable — TypeScript engine used |
| Firefox 89+ | ✅ Full SIMD128 |
| Safari 16.4+ | ✅ Full SIMD128 |
| Safari < 16.4 | ❌ WASM engine unavailable — TypeScript engine used |

**Feature detection:** `loadEngine.ts` exports `isWasmSimdSupported()`, which probes the
browser using `WebAssembly.validate` on a minimal module containing a `v128.const`
instruction. `loadWasmEngine()` calls it *before* fetching the module: on a browser without
SIMD128 it skips the load entirely (instantiating a `v128` binary there would just throw)
and leaves every dispatcher on its TypeScript implementation.

```
[WasmEngine] C++ WASM engine loaded (SIMD128 kernels active).
```

or, on older browsers:

```
[WasmEngine] WebAssembly SIMD128 unsupported — using the TypeScript engine.
```

> **Note:** there is deliberately no separate scalar WASM build. The scalar kernel bodies are
> still compiled — by the host `g++` test build, which has no `-msimd128` — so
> `cpp/tests/test_engine.cpp` keeps proving the two paths agree; they are just not shipped as
> a second browser artifact. Browsers without SIMD128 get the TypeScript engine, which has
> the same public API.

---

## Memory management

The WASM linear memory starts at **64 MB** (`INITIAL_MEMORY=67108864`) and grows
automatically as needed (`ALLOW_MEMORY_GROWTH=1`).

### How pixel buffers are managed in `WasmEngine.ts`

For functions that process image pixel data (luminance, classification, histogram),
the bridge maintains a single **persistent heap buffer** that is grown on demand but
never shrunk between calls.  This avoids repeated `_malloc` / `_free` overhead on
consecutive calls with the same or smaller image sizes (the common case during
auto-play).

Separate small output buffers (histogram: 1 KB, band counts: 44 bytes) are still
allocated per-call because they are fixed-size and inexpensive.

### Guidelines for future WASM integrations

- **Always free** temporary allocations (`_malloc` / `_free`) unless you are
  intentionally keeping a persistent buffer.
- **Do not hold** a heap pointer across `await` boundaries — memory may have moved
  if `ALLOW_MEMORY_GROWTH` caused a reallocation.
- **Prefer bulk operations** (`classifyPixelsBulkWith`) over per-pixel calls
  (`classifyPixelWith`) to minimise JS↔WASM boundary crossings.
- **Avoid accessing** `HEAPU8` / `HEAPF32` etc. after calling any function that
  may trigger heap growth, as typed array views can be invalidated.

---



Once the WASM engine is built and served, users can switch between the TS and C++ engines
at runtime using the **⚡ Engine** panel in the NUNIF control overlay (bottom of the left
side-panel).

- **TS** — always available, uses the TypeScript fallback.
- **C++ WASM** — enabled only when `chromashift_engine.wasm` is present and loaded.  The
  button is greyed-out when the WASM binary has not been built.

The currently active engine is also shown in the top-right corner of the canvas
(`🔷 TS` or `⚡ C++ WASM`).

---

## Architecture

```
cpp/
├── chromashift_engine.h     Header — exported C function declarations
├── chromashift_engine.cpp   C++ implementation
├── band_table.h             Generated from shared/band.json (codegen)
├── decay_table.h            Generated from shared/decay.json (codegen)
├── Makefile                 Emscripten build recipe → public/*.{js,wasm}
└── tests/
    └── test_engine.cpp      Host-side g++ unit tests

shared/
├── band.json                Canonical band thresholds (single source of truth)
└── decay.json               Canonical tracer-decay constants (single source of truth)

scripts/
├── codegen-band.mjs         shared/band.json → cpp/band_table.h
└── codegen-decay.mjs        shared/decay.json → cpp/decay_table.h

public/
├── chromashift_engine.js    (generated) Emscripten ES-module glue
└── chromashift_engine.wasm  (generated) Binary WASM payload

src/engine/
├── WasmEngine.ts            Thin barrel — re-exports the public API, stable import path
└── wasm/
    ├── types.ts             ChromashiftWasmModule interface, EngineKind, export-name list
    ├── loadEngine.ts        Async loader (SIMD128 probe gate), module-level state, persistent heap buffer
    ├── imageBytes.ts         Shared canvas→RGBA byte helpers (used by dispatch + fallbacks)
    ├── fallbacks/
    │   ├── luminance.ts     Pure TS luminance fallbacks
    │   └── decay.ts         Pure TS decay/angle fallbacks (re-exports math/decay.ts)
    └── dispatch/
        ├── luminance.ts      computeAverageLuminance(Strided)?With, computeImageAverageLuminanceWith
        ├── classification.ts classifyPixel(sBulk)?With, classifyImageMaskWith, histogram/band-count
        └── animation.ts      durationToDecayWith, advanceAnglesBy, buildRotationMat3With, simulateTracerDecayWith
```

`WasmEngine.ts` is the single integration point consumed by `App.tsx`, and stays a thin
re-export barrel so the rest of the app keeps importing from `'./engine/WasmEngine'` /
`'../engine/WasmEngine'` regardless of how the implementation underneath is organised. The
loader in `wasm/loadEngine.ts`:

1. Tries `import('/chromashift_engine.js')` on first use.
2. If successful, calls `Module._malloc` / `Module.<function>` / `Module._free`
   with WASM heap copies of pixel/float data — see `wasm/dispatch/*.ts` for the per-function
   marshalling.
3. If the import fails (file not found), silently falls back to the TypeScript implementation
   in `wasm/fallbacks/`.
4. Exposes `isWasmReady()` so the UI can show the correct engine label.

### Classification mask data flow (optional runtime path)

When the active engine is **C++ WASM**, Chromashift can precompute a per-pixel
classification mask at image-load time and bind it to the layer shaders:

1. `App.tsx` loads the image and computes `avgLuminance`.
2. `classifyImageMaskWith(image, avgLum, true)` calls C++ `computeClassificationMask`.
3. The returned `Uint8Array` (band index 0–10 per pixel) is uploaded as `r8uint`.
4. `WebGPURenderer.setClassificationMaskTexture()` binds that mask as an optional
   texture in all 3 layer pipelines.
5. In fixed `cr0p` colour mode, shaders sample the mask to select per-layer bands;
   when no mask is present they fall back to the original per-fragment threshold logic.

### Exported WASM heap views

In addition to `HEAPU8` (byte-level access), the build now exports:

| View | Type | Use |
|---|---|---|
| `HEAPU8` | `Uint8Array` | Read/write raw bytes (pixel input buffers) |
| `HEAPU32` | `Uint32Array` | Read histogram / band-count output (uint32 arrays) |
| `HEAP32` | `Int32Array` | Read bulk classification output (int32 arrays) |
| `HEAPF32` | `Float32Array` | Read/write float angle and tracer buffers |

---

## FAQ

**Q: The C++ WASM button is greyed out — why?**

The WASM binary has not been built yet.  Run `npm run build:wasm` (requires Emscripten).

**Q: Can I use the WASM engine for the GPU rendering pipeline?**

Not in the current phase.  The GPU pipeline (WebGPU / WGSL shaders) lives entirely in
`WebGPURenderer.ts` and is not planned to be moved into WASM.  The C++ engine handles
CPU-side computations (luminance analysis, pixel classification, frame timing helpers).

**Q: When should I use `classifyPixelsBulkWith` vs `classifyPixelWith`?**

For analysis of a full image, always use `classifyPixelsBulkWith`.  It avoids `N` separate
JS↔WASM boundary crossings and processes the entire buffer inside a single C++ call, which
is significantly faster at high pixel counts.  Use `classifyPixelWith` only when you need
to classify a handful of pixels on-demand.

**Q: What is `simulateTracerDecayWith` useful for?**

It provides a CPU-side equivalent of the WGSL persistence shader's decay step.  Useful for
unit tests, offline thumbnail generation, or any scenario where the full GPU pipeline is not
available.  For real-time rendering the GPU persistence pipeline in `WebGPURenderer.ts` is
always more efficient.

**Q: Does switching engines restart the current image/level?**

No.  Engine switching is stateless — it only changes which implementation backs each
computation call.  The WebGPU rendering pipeline and all tracer/persistence state continue
unaffected.
