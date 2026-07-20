# C++ WebAssembly Engine

Chromashift ships two parallel computation engines:

| Engine | Source | Always available? |
|--------|--------|-------------------|
| **TypeScript** | `src/engine/WasmEngine.ts` (fallback implementations) | ✅ Yes |
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
| **WASM-routed, lightweight** | `durationToDecayWith` | Per-frame tracer decay multiplier when Engine = C++ WASM — parity with C++/WGSL formula, not a performance win |
| **Out of scope (GPU)** | Layer rotation, persistence/compositing | Handled by WGSL shaders in `WebGPURenderer` / `WebGLRenderer` |
| **Test / benchmark only** | `simulateTracerDecayWith`, `buildRotationMat3With`, `computeLuminanceHistogramWith`, `computeColorBandCountsWith`, bulk classify helpers | `public/wasm-benchmark.html`, C++ host tests — not used in the live render loop |

**Selection order for image analysis** (see `useClassificationMask.ts`):

1. WebGPU compute histogram + mask (preferred when available).
2. C++ WASM classification mask + strided/full luminance (when Engine = C++ WASM).
3. TypeScript fallbacks in `WasmEngine.ts` (always available).

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
| `classifyPixelsBulkLut` | — | LUT-accelerated bulk classification (≥2× on 4K; see benchmark) |
| `computeClassificationMask` | `classifyImageMaskWith` | Generates compact uint8 band mask (`width × height`) for GPU `r8uint` texture upload |
| `computeClassificationMaskLut` | `classifyImageMaskWith` (preferred WASM path) | Byte-identical LUT mask, faster on large images |
| `computeLuminanceHistogram` | `computeLuminanceHistogramWith` | 256-bucket ITU-R BT.709 luminance histogram |
| `computeColorBandCounts` | `computeColorBandCountsWith` | 11-bucket pixel count per Chromashift colour band |
| `buildRotationMat3` | `buildRotationMat3With` | Column-major 3×3 rotation matrix (matches `rotation.ts`) |

### Frame timing & tracer helpers

| C++ function | TS dispatcher | Description |
|---|---|---|
| `durationToDecay` | `durationToDecayWith` | Per-frame decay multiplier for tracer persistence timing |
| `advanceLayerAngles` | `advanceAnglesBy` | Step 3 layer angles with 360° wrapping |
| `simulateTracerDecay` | `simulateTracerDecayWith` | Apply per-frame decay to a Float32 RGBA buffer in-place (CPU-side tracer simulation) |

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
| WGSL | `BAND_WGSL` literals generated from the same TS `BAND` object |

Run `npm run codegen:band` after editing the JSON, then rebuild WASM.

---

## Band LUT fast path

`buildBandLut(avgLum)` amortises the per-pixel threshold chain into a 256-entry table.
`computeClassificationMaskLut` uses a hybrid lookup: when adjacent luminance buckets share
the same band the LUT value is returned directly; at bucket boundaries the exact float `rgb`
path runs so masks stay byte-identical to the branchy classifier.

**Benchmark:** open `/wasm-benchmark.html` after `npm run build:wasm` — compares branchy vs
LUT on a synthetic 3840×2160 buffer. Acceptance target: LUT ≥2× faster in Chrome.

---

### Prerequisites

1. Install the [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html):

   ```bash
   git clone https://github.com/emscripten-core/emsdk.git
   cd emsdk
   ./emsdk install latest
   ./emsdk activate latest
   source ./emsdk_env.sh   # add emcc to PATH
   ```

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
| `npm run codegen:band` | — | — | Regenerate `cpp/band_table.h` from `shared/band.json` |

```bash
npm run codegen:band   # shared/band.json → cpp/band_table.h
npm run build:wasm     # release: public/chromashift_engine.{js,wasm}
npm run build:wasm:debug
npm run build:wasm:force   # clean + release when make says "Nothing to be done"
# equivalent: cd cpp && make release | make debug | make rebuild
```

`make` tracks build mode (release/debug) and emcc flags in local stamp files
(`cpp/.wasm_mode`, `cpp/.wasm_flags`). Switching mode, editing `EXPORTED_FUNCS`,
or changing `shared/band.json` invalidates `public/chromashift_engine.*` so the
next build is not a silent no-op. If you still see `Nothing to be done for 'all'`
with stale glue (common after a git checkout of committed WASM), run
`make -C cpp rebuild` or `npm run build:wasm:force`.

The release build also passes `-fno-exceptions -fno-rtti` for smaller glue (embind-compatible).

### Build

```bash
npm run build:wasm   # produces public/chromashift_engine.js + public/chromashift_engine.wasm
```

The output lands in `public/` so Vite's dev server and production build both serve the files.

### Verify

```bash
npm run check:wasm          # checks that emcc is on PATH
make -C cpp verify-exports  # EXPORTED_FUNCTIONS matches chromashift_engine.h 1:1
npm run test:cpp            # host-side g++ unit tests (band thresholds, durationToDecay)
```

### Clean

```bash
npm run clean:wasm   # or: cd cpp && make clean
```

---

## Export strategy: embind vs raw C symbols

The WASM build uses **both** mechanisms:

| Mechanism | Purpose |
|---|---|
| `EMSCRIPTEN_KEEPALIVE` + `-s EXPORTED_FUNCTIONS` | Underscored C ABI (`_classifyPixel`, …) for direct heap access and tooling |
| `EMSCRIPTEN_BINDINGS` (`--bind`) | JS-friendly names on `Module` used by `WasmEngine.ts` (`classifyPixel`, …) |

**When to prefer each:**

- **Embind (`--bind`)** — best when TypeScript calls functions by name with mixed scalar
  and pointer arguments. `WasmEngine.ts` already uses embind exports; pointer-heavy batch
  functions get thin lambda wrappers in `chromashift_engine.cpp`.
- **Raw `EXPORTED_FUNCTIONS` only** — smaller glue and a clearer ABI when you are willing to
  write thin TS wrappers around `_malloc` / `HEAPU8` / `_classifyPixel` yourself. Every
  `EMSCRIPTEN_KEEPALIVE` symbol in `chromashift_engine.h` must appear in the Makefile list
  (run `make -C cpp verify-exports` after adding functions).

Chromashift keeps both paths in sync: the header is the source of truth, embind mirrors the
same functions for the TS bridge, and `verify-exports` guards the underscored export list.

---

## SIMD status and browser support

The WASM engine is compiled with `-msimd128 -msse2`, which enables the
WebAssembly SIMD128 instruction set for pixel-processing loops.

| Browser | SIMD128 support |
|---|---|
| Chrome 91+ / Edge 91+ | ✅ Full SIMD128 |
| Chrome < 91 | ⚠️ Scalar (SIMD disabled) |
| Firefox 89+ | ✅ Full SIMD128 |
| Safari 16.4+ | ✅ Full SIMD128 |
| Safari < 16.4 | ⚠️ Scalar (SIMD disabled) |

**Feature detection:** `WasmEngine.ts` exports `isWasmSimdSupported()`, which
probes the browser at runtime using `WebAssembly.validate` on a minimal SIMD
instruction.  When the WASM engine loads, a message is written to the browser
console:

```
[WasmEngine] C++ WASM engine loaded. SIMD128: ✅ supported
```

or, on older browsers:

```
[WasmEngine] C++ WASM engine loaded. SIMD128: ⚠️ not supported (scalar fallback)
```

> **Note:** Even when the browser does not support SIMD128, the WASM binary still
> runs — Emscripten automatically falls back to scalar code.  There is no need for
> a separate scalar build.

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
├── Makefile                 Emscripten build recipe → public/*.{js,wasm}
└── tests/
    └── test_engine.cpp      Host-side g++ unit tests

shared/
└── band.json                Canonical band thresholds (single source of truth)

scripts/
└── codegen-band.mjs         shared/band.json → cpp/band_table.h

public/
├── chromashift_engine.js    (generated) Emscripten ES-module glue
└── chromashift_engine.wasm  (generated) Binary WASM payload

src/engine/
└── WasmEngine.ts            TS bridge — async loader, TS fallbacks, public API
```

`WasmEngine.ts` is the single integration point consumed by `App.tsx`.  It:

1. Tries `import('/chromashift_engine.js')` on first use.
2. If successful, calls `Module._malloc` / `Module.<function>` / `Module._free`
   with WASM heap copies of pixel/float data.
3. If the import fails (file not found), silently falls back to the TypeScript implementation.
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
