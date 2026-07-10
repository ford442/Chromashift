# Chromashift

[![CI](https://github.com/ford442/chromashift/actions/workflows/ci.yml/badge.svg)](https://github.com/ford442/chromashift/actions/workflows/ci.yml)

A WebGPU-based visual engine that performs real-time RGB colour separation and independent layer rotation — replacing a legacy Canvas 2D / Emscripten slideshow. A toggleable WebGL2 fallback is available for visual debugging, automated screenshots, and shader-porting reference work.

## Features

- **3-layer GPU rendering pipeline** — Red/Orange, Violet/Blue, Green/Yellow colour bands, each composited with alpha blending on the GPU.
- **GPU-only colour separation** — luminance-based colour masking is computed entirely in WGSL fragment shaders; zero CPU-side pixel manipulation.
- **Independent layer rotation** — each layer has its own rotation angle and rate, driven by a `mat3x3` rotation matrix uploaded as a vertex-shader uniform.
- **WebGL2 fallback renderer** — opt in with `?renderer=webgl`, the NUNIF renderer control, or `localStorage.chromashift.renderer = "webgl"` for Playwright-friendly output and GLSL shader debugging.
- **TextureManager** — fetches image URLs from a JSON endpoint (simulating the PHP backend) and uploads decoded images directly to GPU textures via `copyExternalImageToTexture`.
- **NUNIF control overlay** — minimal Tailwind CSS UI for adjusting per-layer rotation angle, rotation rate, global frame rate, and average luminance.

## Tech Stack

| Layer | Technology |
|---|---|
| Bundler | [Vite](https://vite.dev/) |
| UI framework | [React 19](https://react.dev/) + [TypeScript](https://www.typescriptlang.org/) |
| Styling | [Tailwind CSS v4](https://tailwindcss.com/) |
| GPU | [WebGPU](https://gpuweb.github.io/gpuweb/) (WGSL shaders), WebGL2 fallback (GLSL ES 3.00) |

## Requirements

- A browser with WebGPU support: **Chrome 113+**, **Edge 113+**, or Chrome Canary.
- For fallback/debug mode: any browser with WebGL2 support.
- Node.js **18+** (`engines.node` in `package.json`; CI uses Node 22)

### Recommended GPU / browser setup

| Item | Guidance |
|---|---|
| Browser | Chrome or Edge 113+ with WebGPU enabled |
| GPU | Discrete GPU recommended for 4K+ canvases; integrated GPUs work for HD |
| Texture headroom | Chromashift requests up to **8192 px** `maxTextureDimension2D` when the adapter allows it |
| Chrome flags | On older builds, enable WebGPU via `chrome://flags/#enable-unsafe-webgpu` |
| Fallback | `?renderer=webgl` for WebGL2 when WebGPU is unavailable or after device loss |

GPU bootstrap (`src/engine/gpuBootstrap.ts`) logs adapter info at startup, derives conservative `requiredLimits`, handles `device.lost`, and surfaces uncaptured errors. See [docs/gpu-bootstrap.md](docs/gpu-bootstrap.md) for the WebGPU/WebGL options matrix.

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

Renderer selection:

```bash
http://localhost:5173/?renderer=webgpu  # primary WebGPU renderer
http://localhost:5173/?renderer=webgl   # WebGL2 fallback/reference renderer
http://localhost:5173/?webgl            # shorthand for WebGL2
```

The NUNIF panel has a Renderer control that persists the choice in localStorage and reloads with the matching URL parameter. Runtime breadcrumbs are also exposed for automation: `window.rendererType`, `window.usingWebGPU`, `window.usingWebGL`, and `window.rendererFallbackReason`.

## Build

```bash
npm run build
npm run preview
```

## Hybrid Engine (TypeScript + C++ WASM)

Chromashift ships two parallel computation engines:

| Engine | Source | Always available? |
|---|---|---|
| **TypeScript** | `src/engine/WasmEngine.ts` (fallback) | ✅ Yes |
| **C++ WASM** | `cpp/chromashift_engine.cpp` | After building (requires Emscripten) |

Both engines expose the same public API. The C++ engine is compiled with WebAssembly
SIMD128 (`-msimd128 -msse2`) for accelerated pixel-processing. If the WASM binary
has not been built, all calls fall back silently to the TypeScript implementation.

To build the C++ engine:

```bash
# Install Emscripten: https://emscripten.org/docs/getting_started/downloads.html
source /path/to/emsdk/emsdk_env.sh
npm run build:wasm          # or: cd cpp && make
npm run check:wasm          # verify emcc is on PATH
npm run test:cpp            # host-side band/decay unit tests (plain g++, no emcc)
```

Host-side C++ tests (`cpp/tests/`) run with `g++` and do not require Emscripten. Rebuild
the WASM binary after changing `cpp/` and commit `public/chromashift_engine.{js,wasm}` when
shipping C++ changes.

See [docs/wasm-engine.md](docs/wasm-engine.md) for full build instructions, SIMD
browser support details, and memory management guidelines.



Place a JSON file at `public/images.json` with the following shape:

```json
[
  { "url": "https://example.com/image1.jpg", "label": "Scene 1" },
  { "url": "https://example.com/image2.jpg", "label": "Scene 2" }
]
```

The `TextureManager` fetches this file on startup and loads each image into a GPU texture.

## Architecture

```
src/
  engine/
    WebGPURenderer.ts   # 3-layer GPU pipeline, rotation uniforms, render loop
    WebGLRenderer.ts    # WebGL2 fallback with shared RendererState + debug modes
    rendererMode.ts     # URL/localStorage/backend breadcrumb selection
    TextureManager.ts   # JSON fetch + GPU texture upload
    WebGLTextureManager.ts # JSON fetch + WebGL texture upload
    shaders.ts          # WGSL vertex + 3 fragment shaders
  components/
    NunifOverlay.tsx    # Tailwind CSS control panel
  App.tsx               # React root, WebGPU init, animation loop
```

See [docs/webgl-fallback.md](docs/webgl-fallback.md) for fallback scope, debug helpers, and WebGL-to-WebGPU shader porting notes.
