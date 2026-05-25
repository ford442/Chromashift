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

## What is implemented in C++

### Luminance & colour analysis

| C++ function | TS dispatcher | Description |
|---|---|---|
| `computeAverageLuminance` | `computeAverageLuminanceWith` | ITU-R BT.709 average luminance over an RGBA pixel buffer |
| `classifyPixel` | `classifyPixelWith` | Maps a single pixel's RGB + avgLum to a colour-band index (0–10) |
| `classifyPixelsBulk` | `classifyPixelsBulkWith` | Batch version of `classifyPixel` — one WASM call for the whole image |
| `computeClassificationMask` | `classifyImageMaskWith` | Generates compact uint8 band mask (`width × height`) for GPU `r8uint` texture upload |
| `computeLuminanceHistogram` | `computeLuminanceHistogramWith` | 256-bucket ITU-R BT.709 luminance histogram |
| `computeColorBandCounts` | `computeColorBandCountsWith` | 11-bucket pixel count per Chromashift colour band |

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

## Building the WASM engine

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

### Build

```bash
cd cpp
make        # produces public/chromashift_engine.js + public/chromashift_engine.wasm
```

The output lands in `public/` so Vite's dev server and production build both serve the files.

### Verify

```bash
cd cpp && make check   # just checks that emcc is on PATH
```

### Clean

```bash
cd cpp && make clean
```

---

## Runtime engine switching

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
├── chromashift_engine.cpp   C++ implementation (Phase 1 complete)
└── Makefile                 Emscripten build recipe → public/*.{js,wasm}

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

The WASM binary has not been built yet.  Run `cd cpp && make` (requires Emscripten).

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
