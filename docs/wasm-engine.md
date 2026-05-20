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

| Function | Description |
|----------|-------------|
| `computeAverageLuminance` | ITU-R BT.709 average luminance over an RGBA pixel buffer |
| `classifyPixel` | Maps a pixel's RGB + avgLum to a Chromashift colour-band index (0–10) |

The classification logic is a direct port of the WGSL fragment-shader preprocessing:

```
diff      = (avgLuminance / 255) × 32
lightDark = 128 + |avgLuminance − 128| / 2
rgb       = lum + lightDark / 2
```

Then `rgb` is compared against the same thresholds used in the shaders.

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
├── chromashift_engine.cpp   C++ implementation (luminance + pixel classification)
└── Makefile                 Emscripten build recipe → public/*.{js,wasm}

public/
├── chromashift_engine.js    (generated) Emscripten ES-module glue
└── chromashift_engine.wasm  (generated) Binary WASM payload

src/engine/
└── WasmEngine.ts            TS bridge — async loader, TS fallbacks, public API
```

`WasmEngine.ts` is the single integration point consumed by `App.tsx`.  It:

1. Tries `import('/chromashift_engine.js')` on first use.
2. If successful, calls `Module._malloc` / `Module.computeAverageLuminance` / `Module._free`
   with a WASM heap copy of the pixel data.
3. If the import fails (file not found), silently falls back to the TypeScript implementation.
4. Exposes `isWasmReady()` so the UI can show the correct engine label.

---

## FAQ

**Q: The C++ WASM button is greyed out — why?**

The WASM binary has not been built yet.  Run `cd cpp && make` (requires Emscripten).

**Q: Can I use the WASM engine for the GPU rendering pipeline?**

Not in the current phase.  The GPU pipeline (WebGPU / WGSL shaders) lives entirely in
`WebGPURenderer.ts` and is not planned to be moved into WASM.  The C++ engine handles
CPU-side computations (luminance analysis, pixel classification).

**Q: Does switching engines restart the current image/level?**

No.  Engine switching only affects `computeAverageLuminance` and `classifyPixel` — both are
stateless per-call functions.  The WebGPU rendering pipeline and all tracer/persistence state
continue unaffected.
