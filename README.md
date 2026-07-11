# Chromashift

[![CI](https://github.com/ford442/chromashift/actions/workflows/ci.yml/badge.svg)](https://github.com/ford442/chromashift/actions/workflows/ci.yml)

A WebGPU-based visual engine that performs real-time RGB colour separation and independent layer rotation — replacing a legacy Canvas 2D / Emscripten slideshow. A toggleable WebGL2 fallback is available for visual debugging, automated screenshots, and shader-porting reference work.

## Features

- **5-pass GPU rendering pipeline** — 3 colour-band layers (Red/Orange, Violet/Blue, Green/Yellow), a persistence pass that accumulates decaying "tracer" overlays where 2+ layers coincide, and a compositor pass that blends everything to the canvas.
- **GPU-only colour separation** — luminance-based colour masking is computed entirely in WGSL fragment shaders; zero CPU-side pixel manipulation on the hot path.
- **Independent layer rotation** — each layer has its own rotation angle and rate, driven by a `mat3x3` rotation matrix uploaded as a vertex-shader uniform.
- **Hybrid TS/C++ WASM engine** — luminance and classification-mask computation run in an optional SIMD128 C++ WASM module, with a pure-TypeScript fallback exposing the identical API (see [Hybrid Engine](#hybrid-engine-typescript--c-wasm) below).
- **GPU compute analysis** — optional WebGPU compute shaders accelerate luminance histogram + band classification for large (4K–8K) images.
- **WebGL2 fallback renderer** — opt in with `?renderer=webgl`, the Renderer panel control, or `localStorage.chromashift.renderer = "webgl"` for Playwright-friendly output and GLSL shader debugging.
- **Local image library** — drag-and-drop images or whole folders onto the canvas to persist them in IndexedDB (thumbnails + originals), with no server upload; survives reloads and shows LOCAL/REMOTE badges in the image strip.
- **AI upscalers** — Real-ESRGAN/Real-CUGAN (TF.js) and waifu2x swin_unet (onnxruntime-web), both lazy-loaded as Web Workers so neither ships in the initial bundle.
- **Shareable presets** — render settings serialize to a versioned JSON document, shareable via `?preset=` URL, named local presets, or file export/import.
- **Offline video/frame export** — render composite, tracer, or per-layer passes to a WebM or PNG sequence independent of the live canvas.
- **Inspection viewport modes** — full-res tracer inspector (zoom/pan/freeze), quarter-zoom crop, half-overlay split, reference-image comparison, and per-layer/heatmap diagnostics.
- **TextureManager** — fetches image URLs from a JSON endpoint and uploads decoded images directly to GPU textures via `copyExternalImageToTexture`.
- **NUNIF control overlay** — Tailwind CSS panel (split into per-concern sections) for layer rotation, tracers, viewport, renderer, presets, export, and upscaling.

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

## Image Source

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
    WebGPURenderer.ts, WebGPUPipelines.ts, PersistencePass.ts,
    CompositorPass.ts, TracerInspectPass.ts   # 5-pass GPU pipeline (layers → persistence → compositor)
    WebGLRenderer.ts    # WebGL2 fallback with shared RendererState + debug modes
    rendererMode.ts     # URL/localStorage/backend breadcrumb selection
    TextureManager.ts, WebGLTextureManager.ts  # JSON/blob fetch + GPU/WebGL texture upload
    LocalLibrary.ts, fileDrop.ts               # IndexedDB local image library (drag-and-drop)
    Upscaler.ts, upscaler.worker.ts, nunif.worker.ts  # Lazy-loaded AI upscalers
    videoExport/        # Offline WebM/PNG-sequence export
    compute/             # WebGPU histogram + classification-mask compute shaders
    shaders/             # WGSL vertex + fragment shader modules
  hooks/                 # useAppWebGPUInit, useImagePlayback, useMediaHandlers, usePresets, …
  state/                 # Reducer, slices, preset (de)serialization
  components/
    AppUI.tsx, ImageStrip.tsx
    overlay/             # NunifOverlay split into per-concern panels (Layer, Tracer, Viewport, …)
  App.tsx                # React root — wires hooks together, renders <AppUI>
```

Full per-file detail lives in [AGENTS.md](AGENTS.md#architecture) — keep it as the source of truth
when this summary and the actual `src/` tree diverge again.

See [docs/webgl-fallback.md](docs/webgl-fallback.md) for fallback scope, debug helpers, and WebGL-to-WebGPU shader porting notes.

## Browser Matrix

| Capability | Role | Fallback if unavailable |
|---|---|---|
| **WebGPU** | Primary renderer | WebGL2 (`?renderer=webgl`), automatic on init failure or device loss |
| **WebGL2** | Debug/reference renderer, screenshots | N/A — this is the fallback tier |
| **WASM SIMD128** | Accelerated CPU luminance/classification | TypeScript engine (identical API), used automatically if the WASM binary isn't built |
| **ORT (onnxruntime-web)** | Optional waifu2x upscaling, lazy-loaded | TF.js Real-ESRGAN/Real-CUGAN covers the other upscale path |

See [AGENTS.md](AGENTS.md#browser-requirements) for the full matrix with version/build requirements.

## Roadmap

Closed issues **#16–#84** cover the foundation this app is built on: the C++/WASM hybrid
engine, WebGPU hardening (adapter limits, `device.lost`, error scopes), the WebGL2
fallback renderer, `App.tsx` state consolidated into a reducer, shader modularization
with TS/WGSL/C++ threshold parity tests, CI (lint/typecheck/build/wasm), GPU compute
analysis, shareable presets, and offline video export.

Open work, roughly foundation → features → research:

| Stage | Issue | Summary |
|---|---|---|
| Foundation | [#90](https://github.com/ford442/Chromashift/issues/90) | Harden `deploy.py` (key auth, dry-run, drop the doc-vs-code drift on credentials) |
| Foundation | [#91](https://github.com/ford442/Chromashift/issues/91) | GPU timestamp queries + per-pass frame budget HUD |
| Feature ✅ *in review* | [#80](https://github.com/ford442/Chromashift/issues/80) | Lazy-load the upscaler workers so ORT/TF.js don't ship on first load |
| Feature ✅ *in review* | [#88](https://github.com/ford442/Chromashift/issues/88) | Local image library: drag-drop upload, IndexedDB cache |
| Feature ✅ *in review* | [#89](https://github.com/ford442/Chromashift/issues/89) | This doc pass — README/AGENTS refresh + roadmap |
| Research | [#86](https://github.com/ford442/Chromashift/issues/86) | Expand the C++ WASM engine (rotation matrices, band LUT, offline composite) |
| Research | [#87](https://github.com/ford442/Chromashift/issues/87) | Multi-viewport / A-B preset comparison layout |
| Research | [#92](https://github.com/ford442/Chromashift/issues/92) | Audio-reactive + MIDI control of layer rates / tracer intensity |
| Research | [#85](https://github.com/ford442/Chromashift/issues/85) | WebXR / kiosk / immersive installation mode |

See the [issue tracker](https://github.com/ford442/Chromashift/issues) for current status —
this table is a snapshot, not a live query.
