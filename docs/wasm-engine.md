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

The C++ WASM engine is mostly a **load-time analysis accelerator**, not a replacement for the
GPU render loop. The one per-frame exception is `computeMotionFlow`, which serves `direction`
motion on lanes without GPU compute and runs in `motion.worker.ts`, never on the animation
thread. Toggling **C++ WASM** in the Engine panel routes specific CPU-side work through
the compiled module when it is available; the WebGPU/WGSL pipeline remains the source of truth
for real-time rendering.

| Category | Functions | Role |
|---|---|---|
| **In scope (load-time)** | `computeAverageLuminanceWith`, `computeAverageLuminanceStridedWith`, `classifyImageMaskWith`, histogram/band helpers | Average luminance and classification masks when GPU compute analysis (#82) is unavailable; strided luminance for large (4K–8K) and upscaled buffers |
| **In scope (export / offline)** | `advanceAnglesBy` | Video-export angle stepping when Engine = C++ WASM |
| **In scope (per frame)** | `computeMotionFlowWith` | Optical flow behind `motionMode: 'direction'`, on backends with no compute lane (WebGL, or WebGPU with `?no_gpu_compute` / a compute decline). The only per-frame WASM call, and it runs in `motion.worker.ts`, never on the animation thread |
| **Out of scope (GPU)** | Layer rotation, persistence/compositing, tracer decay, tracer overlap detection | Handled by WGSL/GLSL shaders in `WebGPURenderer` / `WebGLRenderer`; the per-frame decay multiplier is the pure `durationToDecay()` in `math/decay.ts` (constants from `shared/decay.json`, see [Shared decay table](#shared-decay-table-shareddecayjson)), and the 3-layer overlap ("coincidence") detection is a `gpu-chores` compute pass (`op: 'coincidence'`, see `docs/gpu-bootstrap.md`) with a fragment-shader fallback — neither is ever dispatched through WASM |
| **Test / benchmark only** | `durationToDecayWith`, `classifyPixelsBulkWith`; the C++ `classifyPixel`, `buildRotationMat3`, `simulateTracerDecay`, `computeLuminanceHistogram` and `computeColorBandCounts` exports (no TS dispatcher) | `public/wasm-benchmark.html`, C++ host tests, WASM/TS parity tests — not used in the live render loop |

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
| `computeAverageLuminanceStridedWith` | `engine/live/LiveSource.ts`, `hooks/useMediaHandlers.ts`; also called internally by `computeImageAverageLuminanceWith` | Load-time / live source |
| `computeImageAverageLuminanceWith` | `hooks/useMediaHandlers.ts`, `hooks/useImagePlayback.ts` (both only on the mask-generation error path); also called by `chores/chromashiftHost.ts` and, inside the analysis worker, `analysis.worker.ts` — both reached indirectly from `hooks/useClassificationMask.ts` via `CpuChoreHost.analyzeImage`/`computeAverageLuminance` | Load-time |
| `classifyImageMaskWith` | `chores/chromashiftHost.ts` and, inside the analysis worker, `analysis.worker.ts` — both reached indirectly from `hooks/useClassificationMask.ts` via `CpuChoreHost.analyzeImage` | Load-time (mask generation) |
| `advanceAnglesBy` | `engine/videoExport/exportVideoFrameLoop.ts` | Video export |
| `computeMotionFlowWith` | `engine/compute/motion.worker.ts`, reached from `engine/live/liveMotionField.ts` via `chores/motionWorkerHost.ts` | Per frame (throttled), `motionMode: 'direction'` only |

No `*With()` dispatcher is called from a per-frame render or animation-loop path
(`useAnimationLoop.ts`, `WebGPURenderer.ts` and the graph executor / `WebGLRenderer.ts`
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
| `classifyPixel` | — (benchmark / C++ tests) | Maps a single pixel's RGB + avgLum to a colour-band index (0–10) |
| `buildBandLut` | `buildBandLut` (TS) / WASM heap | 256-entry band LUT from avgLuminance |
| `classifyPixelsBulk` | `classifyPixelsBulkWith` | Batch version of `classifyPixel` — one WASM call for the whole image |
| `classifyPixelsBulkLut` | — | Bulk classification via the band LUT (scalar) / the SIMD ladder |
| `computeClassificationMask` | `classifyImageMaskWith` | Generates compact uint8 band mask (`width × height`) for GPU `r8uint` texture upload |
| `computeClassificationMaskLut` | `classifyImageMaskWith` (preferred WASM path) | Byte-identical mask via the LUT shortcut (scalar) / the SIMD ladder |
| `computeLuminanceHistogram` | — (benchmark / C++ tests) | 256-bucket ITU-R BT.709 luminance histogram |
| `computeColorBandCounts` | — (benchmark / C++ tests) | 11-bucket pixel count per Chromashift colour band |
| `buildRotationMat3` | — (benchmark / C++ tests; TS is `math/rotation.ts`) | Column-major 3×3 rotation matrix (matches `rotation.ts`) |

### Frame timing & tracer helpers

| C++ function | TS dispatcher | Description |
|---|---|---|
| `durationToDecay` | `durationToDecayWith` | Per-frame decay multiplier for tracer persistence timing |
| `advanceLayerAngles` | — (reference for `advanceAnglesBy`) | Step `count` layer angles with 360° wrapping |
| `simulateTracerDecay` | — (benchmark / C++ tests) | Apply per-frame decay to a Float32 RGBA buffer in-place (CPU-side tracer simulation) |
| `computeMotionFlow` | `computeMotionFlowWith` | Coarse-to-fine Lucas–Kanade optical flow over two low-resolution luminance planes; mirrors `chores/motionKernel.ts` and the WGSL flow passes (see `docs/LIVE_SOURCE.md`) |

`advanceLayerAngles` takes `(const float* angles, const float* steps, float* out,
uint32_t count)` — a session runs 1–10 band layers, so the angle list is a pointer
and a count rather than a fixed argument list. `out` may alias `angles`.

`advanceAnglesBy()` does not call it: for at most ten floats, a `_malloc`, two heap
copies and a `_free` per exported frame cost more than the loop, so the dispatcher
always runs the TypeScript mirror (`fallbacks/decay.ts`). The export stays as the
reference that mirror follows, with its wrap and aliasing rules pinned by the host
tests. (The deprecated six-float `advanceLayerAngles3` wrapper is gone; every
committed artifact since #194 exports the count-taking ABI.)

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

Every bulk kernel has a hand-written `wasm_simd128.h` path guarded by `CS_HAS_SIMD`
(`cpp/simd_util.h`: set under `__wasm_simd128__` unless `CS_FORCE_SCALAR` is defined),
followed by the scalar loop that finishes its tail. The vector helpers more than one
kernel uses — BT.709 luminance of four pixels, the vector ladder, a NaN-preserving clamp —
live in `simd_util.h`:

| Kernel | Vector strategy |
|---|---|
| `computeAverageLuminance` / `…Strided` (stride 1) | Widen RGBA bytes into a `[R,G,B,A]` u32 lane accumulator, drained into `double` every 2²⁰ pixels; weights applied once at the end |
| `computeClassificationMask{,Lut}` | 16 pixels per iteration: 4× (luminance → ladder), narrowed to one 16-byte mask store |
| `classifyPixelsBulk{,Lut}` | 4 pixels per iteration, i32 band indices stored directly |
| `computeLuminanceHistogram` | Vectorised luminance + `trunc_sat`; the bucket increment is a scatter, so lanes are drained scalar |
| `computeColorBandCounts` | Vectorised ladder, scalar tally |
| `simulateTracerDecay` | Straight `f32x4` multiply |
| `computeMotionFlow` (`cpp/motion_flow.cpp`) | 2×2 `halvePlane` deinterleaves even/odd lanes with `wasm_i32x4_shuffle` and sums them `((a + b) + c) + d`, the scalar order; the coarse LK level solves 4 interior cells per lane (`clampQuad` passes a NaN through, as the scalar clamp does). The fine level stays scalar: its warped bilinear fetch is a per-cell gather |

Output is bit-identical to the scalar path, for every kernel. The luminance step issues its
three multiplies and two adds in the same order as the scalar code and f32 lanes round
exactly like scalar f32, and the ladder is the same comparison set. The average-luminance
kernels changed formulation — integer channel sums weighted once, instead of a running
`double` sum — which removes accumulated rounding error rather than adding any, and returns
the same `float`. Floating-point addition does not associate, so any vector body that sums
must keep the scalar operation order; `halvePlane` once paired its four taps as
`(a + b) + (c + d)` and differed from the scalar path on 99,157 of 120,608 outputs over 40
random sizes (max |Δ| 1.5e-5) — invisible to the `2e-3` cross-language fixture tolerance.

**How that is proven.** The host `g++` build never compiles a `CS_HAS_SIMD` block, so it
cannot test them. `make -C cpp test-simd` (`npm run test:cpp:simd`, run by `wasm.yml`):

1. builds `cpp/tests/test_engine.cpp` with `em++ -msimd128` and runs it under Node — the
   whole host suite against the SIMD128 build; then
2. builds `cpp/tests/simd_parity.cpp`: the engine as shipped plus a second copy of every
   engine translation unit compiled with `CS_FORCE_SCALAR` and its exports renamed to
   `cs_scalar_*` (`tests/scalar_names.h`), linked into one module. Every bulk kernel runs on
   both and must match **bit for bit** — widths and pixel counts at every residue mod 16 and
   mod 4 (1×1 … 97×61), trailing partial-pixel bytes, and NaN / ±inf / denormal / ±0 /
   out-of-range inputs. NaN matches NaN regardless of payload, which WebAssembly leaves
   nondeterministic for scalar and vector arithmetic alike.

A tolerance belongs only where two languages meet: `computeMotionFlow`'s TypeScript
reference solves in doubles, so the C++ and TypeScript lanes are pinned to one shared
fixture within `2e-3` (`test_engine.cpp`, `motionKernel.test.ts`, and the bench's run of the
release artifact). Between two compilations of one C++ source, any difference is a bug.

Every build disables FP contraction (`-ffp-contract=off` in `CXXFLAGS_COMMON`): a host where
clang fuses `a*b + c` by default (aarch64) would otherwise round `lkSolve` differently from
wasm32, which has no scalar FMA. For the same reason the build never uses
`-mrelaxed-simd`, whose fused and relaxed ops have implementation-defined results.

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

The mask kernels take `avgLum` as a `float` and round it themselves. `std::lround` of a NaN
or of anything outside `long` is unspecified, so NaN maps to the neutral 128 and every other
value is clamped to [0, 255] before rounding.

### Benchmark and the CI perf gate

```bash
npm run bench:wasm             # report throughput of every bulk kernel
npm run bench:wasm -- --assert # enforce the floors (how CI runs it)
```

`scripts/bench-wasm.mjs` loads the committed artifacts in Node (passing `wasmBinary`, since
`-s ENVIRONMENT=web,worker` leaves the glue with no Node file loader) and runs every bulk
kernel over a deterministic 3841×2161 golden image. It fails when a kernel drops below its
throughput floor, so losing the SIMD path fails the `wasm` job instead of silently
un-accelerating the CPU fallback lane. The size is 4K plus one pixel each way on purpose:
3840×2160 is a multiple of 16 pixels, so the mask kernels' scalar tail never ran on it. It
also checks both mask kernels against the scalar reference — the `classifyPixel` export,
which has no vector path — rather than against each other: the two share one SIMD body, so
comparing them proved nothing. The golden image, kernel list and floors live in
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

The release build also passes `-fno-exceptions`, `-fno-rtti`, `-flto` and `--closure 1` for
smaller output; debug builds skip the last two so stack traces and `ASSERTIONS` output stay
readable.

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
npm run test:cpp:werror     # same tests, -Werror — what wasm.yml's host-tests job runs
npm run test:cpp:simd       # same tests on em++ -msimd128 + bit-exact SIMD/scalar parity (needs emsdk)
npm run bench:wasm -- --assert  # kernel throughput floors (the CI perf gate)
```

### Warnings and sanitizers

Every compile — host tests, SIMD tests, the shipped `emcc` build and the clangd database — starts from `CXXFLAGS_COMMON` in `cpp/Makefile` (`-std=c++17 -Wall -Wextra -ffp-contract=off -I.`), so a warning cannot be present in the shipped `.wasm` while being invisible to the test gate.

| Command | What it does |
|---|---|
| `npm run test:cpp` | Host tests, warnings printed |
| `npm run test:cpp:werror` | Host tests with `-Werror` — **the CI gate** (`wasm.yml` `host-tests`); a new implicit conversion or unused parameter fails it |
| `npm run test:cpp:simd` | The host suite built with `em++ -msimd128 -Werror` and run under Node, then the SIMD/scalar parity harness — `wasm.yml`'s `wasm` job. Needs emsdk on `PATH` |
| `npm run test:cpp:asan` | Host tests under `-fsanitize=address,undefined`. Optional: the instrumented binary is several times slower, so it is **not** part of the per-PR gate. Run it when touching pointer arithmetic in the bulk/LUT kernels. Host-only — sanitizers are never applied to the shipped `.wasm`. |

### Editor setup (clangd)

```bash
npm run compile-commands    # writes cpp/compile_commands.json
```

This emits one real `-c <file> -o <file>.o` command per translation unit, with the compiler and flags passed in by `cpp/Makefile` — there is no second copy of the flags to keep in sync. It is gitignored because it embeds absolute paths; regenerate it per checkout. `cpp/.clangd` points clangd at it.

With emsdk active (`$EMSDK` set, e.g. after `source emsdk_env.sh`), the engine TUs (`chromashift_engine.cpp`, `motion_flow.cpp`) and the parity harness get a **wasm32** entry — emsdk's own `clang++ --target=wasm32-unknown-emscripten --sysroot=$EMSDK/upstream/emscripten/cache/sysroot` plus `WASM_CXXFLAGS` (`-msimd128` included), i.e. what emcc compiles. Every `#if CS_HAS_SIMD` block sits in front of a scalar tail that is always compiled, so clangd then sees **all** of the code: diagnostics and navigation inside the SIMD kernels as well as the scalar bodies. Without emsdk the engine TUs fall back to the host (`g++`) entry and the SIMD blocks grey out; `tests/test_engine.cpp` always gets the host entry. Rerun `npm run compile-commands` after activating emsdk.

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
`--bind` and `-DEMSCRIPTEN_HAS_UNBOUND_TYPE_NAMES=0` flags it needed.

`make -C cpp verify-exports` is the single source of truth for the export list: it fails if
any `EMSCRIPTEN_KEEPALIVE` symbol in the header is missing from `EXPORTED_FUNCS`. It runs in
the `wasm` job of `wasm.yml`. Adding a function
means touching three places — the header, `EXPORTED_FUNCS`, and `WASM_API_FUNCTIONS` in
`src/engine/wasm/types.ts` (which `loadEngine.ts` checks at load time to warn about a stale
build).

---

## Emscripten flag audit

`cpp/Makefile`'s `EMFLAGS_COMMON` against what `src/engine/wasm/` actually calls at runtime.

| Flag | Verdict | Reasoning |
|---|---|---|
| `--bind` (embind) | **Removed** | Every binding was a `reinterpret_cast` passthrough over the C ABI the module already exported. The TS bridge now calls `mod._name(...)` directly — see "Export strategy" above. Dropping it also dropped `-DEMSCRIPTEN_HAS_UNBOUND_TYPE_NAMES=0`, which existed only to make embind compile. |
| `CXXFLAGS_COMMON` (`-std=c++17 -Wall -Wextra -ffp-contract=off -I.`) | **Added** | The one compile-flag set every build shares — host tests (CI runs them at `-Werror`), SIMD tests, this build and the clangd database — so a warning that fails the test gate cannot be silently absent from the shipped build. `-ffp-contract=off` keeps every target from fusing `a*b + c`, which bit-exact parity depends on (see "SIMD128 kernels"). |
| `-mrelaxed-simd` | **Never** | Relaxed ops (FMA, swizzle, min/max) have implementation-defined results: output would differ between browsers and from the scalar path. |
| `-fno-rtti` | **Added** | Nothing uses `typeid` / `dynamic_cast`; with embind gone there is nothing that needs type info. |
| `-msse2` | **Removed** | Nothing includes `<emmintrin.h>`; the SIMD kernels use `<wasm_simd128.h>` directly, which needs only `-msimd128`. |
| `-s EXPORTED_FUNCTIONS=[...]` | **Keep — now the only ABI** | Produces `_malloc` / `_free` and every engine entry point. Guarded by `verify-exports`. |
| `-msimd128` | **Keep — load-bearing** | Enables the hand-written `wasm_simd128.h` kernels (`__wasm_simd128__`). See "SIMD status" below. |
| `-flto` (release) | **Added** | Whole-program optimisation across the engine's TUs (`chromashift_engine.cpp`, `motion_flow.cpp`) and libc; part of the drop from 47.2 kB to 33.4 kB of `.wasm`. |
| `--closure 1` (release) | **Added** | The glue is a thin C-ABI shim, so Closure has nothing to break: 10.7 kB → 4.9 kB. Off in debug builds. Output is reproducible for a pinned emsdk version, which `wasm.yml`'s freshness check relies on. |
| `-s ENVIRONMENT=web,worker` | **Added** | The engine only ever runs in a browser window or a Web Worker (the analysis worker included); this drops the Node/shell detection branches from the glue. Node callers such as `scripts/bench-wasm.mjs` pass `wasmBinary` instead of relying on a file loader. |
| `-s FILESYSTEM=0` | **Added** | Nothing in the engine touches a file; this drops the FS glue entirely. |
| `-s DYNAMIC_EXECUTION=0` | **Added** | Keeps `eval` / `new Function` out of the glue, so the engine loads under a strict Content-Security-Policy without `'unsafe-eval'`. |
| `-s MALLOC=emmalloc` | **Added** | The engine holds a few long-lived buffers (the TypeScript side pools its inputs; `computeMotionFlow` keeps a grow-only arena), so dlmalloc's small-object bins buy nothing. emmalloc made the `.wasm` ~13% smaller (38,959 → 34,174 bytes on emsdk 3.1.64) with throughput unchanged. |
| `-s INITIAL_MEMORY=16777216` (16 MiB) | **Changed from 64 MiB** | Up to three instances exist at once — the main thread, the analysis worker and the motion worker each load their own module — and each reserved 64 MiB up front, 192 MiB before any image arrived. The big buffers (a 4K–8K RGBA image and its mask) now grow the heap on first use, and the TypeScript side's persistent buffer keeps it from churning afterwards: a steady image size costs one growth, not one per call. |
| `-s ALLOW_MEMORY_GROWTH=1` | **Keep** | Required: any image above ~2K grows the heap past the 16 MiB start. |
| `-s MODULARIZE=1` + `-s EXPORT_ES6=1` | **Keep** | Correct for Vite — `loadEngine.ts` does a dynamic `import()` of `/chromashift_engine.js` and calls the default export as a factory (`await glue.default()`); a non-modularized build would attach a global instead. |
| `-fno-exceptions` | **Keep** | Smaller output; the C API surface in `chromashift_engine.h` does not throw. |

**Net result:** artifact sizes dropped from 33.9 kB glue + 47.2 kB wasm to 4.9 kB glue +
33.4 kB wasm; adding `motion_flow.cpp` took the wasm to 39.0 kB, and emmalloc brought it back
to **34.2 kB** (emsdk 3.1.64).

---

## SIMD status and browser support

The WASM engine is compiled with `-msimd128` and its pixel kernels contain real `v128`
instructions (`cpp/chromashift_engine.cpp`, `cpp/motion_flow.cpp`, guarded by `CS_HAS_SIMD`). SIMD128 is
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

The probe module is built from its sections (`wasmSection` + `leb128` in `loadEngine.ts`),
so every size field is computed rather than typed in. The hand-written bytes it replaced
had two section sizes short (`0x0f`/`0x0d` for 22/20-byte bodies): `WebAssembly.validate`
rejected the module on every browser, and the engine silently never loaded.
`loadEngine.test.ts` pins `isWasmSimdSupported() === true` under Node 22, which has SIMD128.

**Load status breadcrumbs.** The main thread publishes `window.wasmEngineState`
(`'idle' | 'loading' | 'ready' | 'unavailable' | 'error'`) and `window.wasmEngineError`
(the caught message, or `null`). `unavailable` means no SIMD128; `error` means the fetch or
instantiation threw, and is also logged once as
`[WasmEngine] C++ WASM engine failed to load — using the TypeScript engine:` with the error.
Workers have no `window`, so `analysis.worker.ts` and `motion.worker.ts` return their
module's status with every response and their hosts merge it into
`window.wasmEngineWorkers` (`{ analysis?, motion? }`, each `{ state, error }`).
`e2e/wasm-engine.spec.ts` asserts `ready` on the main thread and in both workers.

> **Note:** there is deliberately no separate scalar WASM build. The scalar kernel bodies are
> still compiled — they finish every SIMD loop's tail, the host `g++` test build runs them
> alone, and `make -C cpp test-simd` links a `CS_FORCE_SCALAR` copy next to the SIMD engine
> to prove the two bit-identical — they are just not shipped as a second browser artifact.
> Browsers without SIMD128 get the TypeScript engine, which has the same public API.

---

## Memory management

The WASM linear memory starts at **16 MiB** (`INITIAL_MEMORY=16777216`) and grows
automatically as needed (`ALLOW_MEMORY_GROWTH=1`). Each module instance — main thread,
analysis worker, motion worker — has its own memory.

### How pixel buffers are managed in `WasmEngine.ts`

For functions that process image pixel data (luminance, classification, histogram),
the bridge maintains a single **persistent heap buffer** that is grown on demand but
never shrunk between calls.  This avoids repeated `_malloc` / `_free` overhead on
consecutive calls with the same or smaller image sizes (the common case during
auto-play).

`classifyImageMaskWith` and `computeMotionFlowWith` put their outputs in the same
persistent buffer, after the inputs, so a mask or flow field costs no allocation per call.
Separate small output buffers (histogram: 1 KB, band counts: 44 bytes) are still
allocated per-call because they are fixed-size and inexpensive, through
`withWasmScratch` (freed in a `finally`).

Every allocation goes through `checkedMalloc`: with `ALLOW_MEMORY_GROWTH` a `_malloc`
the heap cannot grow to fit returns `0` instead of aborting, and the caller would then
copy the pixels over heap offset 0. `checkedMalloc` throws instead.

Strided luminance copies only its samples. `computeAverageLuminanceStridedWith` with
`stride > 1` packs the sampled pixels in JS and hands C++ a contiguous run (stride 1), and
`computeImageAverageLuminanceWith` reads only the sampled rows out of the image
(`getStridedRows`). At 8K and stride 30 that is ~37k pixels instead of a ~132 MB frame,
and the result is the same: the C++ sums are exact. On the C++ side,
`computeMotionFlow` keeps its half-resolution scratch planes in a grow-only arena for the
same reason.

### Guidelines for future WASM integrations

- **Always free** temporary allocations: use `withWasmScratch` (or `getPersistentBuf`
  for a buffer you mean to keep), never a bare `_malloc`, which returns `0` on failure.
- **Do not hold** a heap pointer across `await` boundaries — memory may have moved
  if `ALLOW_MEMORY_GROWTH` caused a reallocation.
- **Prefer bulk operations** (`classifyPixelsBulkWith`) over per-pixel calls
  to minimise JS↔WASM boundary crossings.
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
        ├── classification.ts classifyPixelsBulkWith, classifyImageMaskWith
        └── animation.ts      durationToDecayWith, advanceAnglesBy
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

**Q: Does switching engines restart the current image/level?**

No.  Engine switching is stateless — it only changes which implementation backs each
computation call.  The WebGPU rendering pipeline and all tracer/persistence state continue
unaffected.
