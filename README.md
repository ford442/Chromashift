# Chromashift

[![CI](https://github.com/ford442/chromashift/actions/workflows/ci.yml/badge.svg)](https://github.com/ford442/chromashift/actions/workflows/ci.yml)

A WebGPU-based visual engine that performs real-time RGB colour separation and independent layer rotation — replacing a legacy Canvas 2D / Emscripten slideshow. A toggleable WebGL2 fallback is available for visual debugging, automated screenshots, and shader-porting reference work.

## Features

- **5-pass GPU rendering pipeline** — 3 colour-band layers (Red/Orange, Violet/Blue, Green/Yellow), a persistence pass that accumulates decaying "tracer" overlays where 2+ layers coincide, and a compositor pass that blends everything to the canvas.
- **GPU-only colour separation** — luminance-based colour masking is computed entirely in WGSL fragment shaders; zero CPU-side pixel manipulation on the hot path.
- **Independent layer rotation** — each layer has its own rotation angle and rate, driven by a `mat3x3` rotation matrix uploaded as a vertex-shader uniform.
- **Hybrid TS/C++ WASM engine** — luminance and classification-mask computation run in an optional SIMD128 C++ WASM module, with a pure-TypeScript fallback exposing the identical API (see [Hybrid Engine](#hybrid-engine-typescript--c-wasm) below).
- **GPU compute analysis** — optional WebGPU compute shaders accelerate luminance histogram + band classification for large (4K–8K) images.
- **WebGL2 diagnostic renderer** — implemented in `src/engine/webgl/`, but **user selection is disabled this phase** (`WEBGL_BACKEND_ENABLED`). Failed WebGPU boots hard-fail; restoring an *explicit* (never silent) WebGL path is [#141](https://github.com/ford442/Chromashift/issues/141). See [docs/webgl-fallback.md](docs/webgl-fallback.md).
- **Local image library** — drag-and-drop images or whole folders onto the canvas to persist them in IndexedDB (thumbnails + originals), with no server upload; survives reloads and shows LOCAL/REMOTE badges in the image strip.
- **AI upscalers** — Real-ESRGAN/Real-CUGAN (TF.js) and waifu2x swin_unet (onnxruntime-web), both lazy-loaded as Web Workers so neither ships in the initial bundle.
- **Shareable presets** — render settings serialize to a versioned JSON document, shareable via `?preset=` URL, named local presets, or file export/import.
- **Offline video/frame export** — render composite, tracer, or per-layer passes to a WebM or PNG sequence independent of the live canvas.
- **Inspection viewport modes** — full-res tracer inspector (zoom/pan/freeze), quarter-zoom crop, half-overlay split, reference-image comparison, and per-layer/heatmap diagnostics.
- **Kiosk / gallery mode** — `?kiosk=1` hides chrome, enables autoplay + attract drift, fullscreen, and a bottom IR remote for installations ([docs/KIOSK.md](docs/KIOSK.md)).
- **Audio-reactive + MIDI** — microphone envelope and Web MIDI CC drive layer rotation rates and tracer intensity (`ReactivePanel`).
- **GPU perf HUD** — optional per-pass WebGPU timestamp queries with frame-budget warnings and auto-degrade (Diagnostics panel).
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
| Fallback | Disabled this phase — failed WebGPU boots show a blocking probe screen ([webgl-fallback.md](docs/webgl-fallback.md), [#141](https://github.com/ford442/Chromashift/issues/141)) |

GPU bootstrap (`src/engine/gpuBootstrap.ts`) logs adapter info at startup, derives conservative `requiredLimits`, handles `device.lost`, and surfaces uncaptured errors. See [docs/gpu-bootstrap.md](docs/gpu-bootstrap.md) for the WebGPU/WebGL options matrix.

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

Renderer selection (this phase):

```bash
http://localhost:5173/?renderer=webgpu  # the only supported boot path
# ?renderer=webgl is ignored until WEBGL_BACKEND_ENABLED is restored (#141)
```

Runtime breadcrumbs: `window.rendererType`, `window.usingWebGPU`, `window.usingWebGL`, `window.webgpuProbe`, `window.rendererFallbackReason`.

## Build

```bash
npm run build
npm run preview
```

## Deploy

Production deploys upload `dist/` to the test server via SFTP (`deploy.py`).

```bash
npm run build
pip install -r requirements-deploy.txt

# SSH key (preferred) — agent or explicit key path
export DEPLOY_USER=your-sftp-user
export DEPLOY_KEY=~/.ssh/id_ed25519
python deploy.py

# Password fallback
export DEPLOY_PASS=your-password
python deploy.py
```

Flags:

| Flag | Effect |
|------|--------|
| `--dry-run` | Connect and list remote deletions + local uploads; no server changes |
| `--no-clean` | Upload without wiping the remote target directory first |

By default the script **deletes existing remote files** in the target path before upload.
Use `--dry-run` to preview changes, or `--no-clean` for incremental uploads.

Optional env overrides: `DEPLOY_HOST` (default `1ink.us`), `DEPLOY_PORT` (default `22`),
`DEPLOY_REMOTE_DIR` (default `test.1ink.us/chromashift`).

**GitHub Actions:** run the [Deploy workflow](.github/workflows/deploy.yml) manually
(`workflow_dispatch`). Repository secrets: `DEPLOY_USER`, `DEPLOY_KEY` (private key PEM).
Never commit credentials or log key/password values.

`npm run build` runs `check:dist`, which fails if `ort-wasm*.wasm` is emitted into
`dist/` (ORT runtime loads from `VITE_NUNIF_ORT_WASM_BASE` at upscale time instead).
The deploy script prints total upload size before transferring.

## Testing

```bash
npm test                 # Vitest unit tests (src/**/*.test.ts)
npm run test:e2e         # Playwright E2E (all projects)
npm run test:e2e:webgl   # WebGL smoke, preset URL, kiosk, viewport transforms
npm run test:e2e:webgpu  # WebGPU smoke + compare layouts (--enable-unsafe-webgpu)
npm run test:e2e:update  # refresh visual snapshots (opt-in screenshot specs)
npm run test:cpp         # C++ host parity tests
```

E2E coverage (`e2e/`):

| Spec | Project | What it checks |
|------|---------|----------------|
| `smoke.spec.ts` | chromium | WebGL bootstrap, `window.usingWebGL`, canvas visible |
| `preset-url.spec.ts` | chromium | `?preset=` hydrates layer opacity / tracer intensity; invalid preset error |
| `kiosk.spec.ts` | chromium | `?kiosk=1` hides NUNIF chrome, shows kiosk remote |
| `viewport-transforms.spec.ts` | chromium | Quarter-zoom / half-overlay toggles + preset hydrate |
| `webgpu-smoke.spec.ts` | chromium-webgpu | WebGPU bootstrap (`--enable-unsafe-webgpu`) |
| `compare-dual.spec.ts` | chromium-webgpu | Dual layout, Compare-with slot B, sync-play, perf banner |
| `compare-swipe.spec.ts` | chromium-webgpu | Swipe divider drag + `window.compareSwipePosition` |
| `compare-quad.spec.ts` | chromium-webgpu | Quad grid cells + layer cycle |
| `preset-compare.spec.ts` | chromium-webgpu | v2 `compare.layout=dual` URL hydrate + reload round-trip |
| `opacity-test.spec.ts` | chromium | Opt-in screenshot capture (`RECORD_SCREENSHOTS=1`) |
| `renderer-parity.spec.ts` | chromium | Opt-in WebGL debug-mode screenshots (`RECORD_SCREENSHOTS=1`) |

Compare specs stub `images.json` to `/e2e-fixture.png` so CI does not depend on the remote corpus.

Install Playwright browsers once: `npx playwright install --with-deps chromium`.

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
    webgl/              # WebGL2 fallback (pass modules + GLSL shaders; WebGLRenderer.ts re-export)
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
| **WebGPU** | Primary renderer | Blocking error screen (probe stage + adapter). No automatic WebGL switch |
| **WebGL2** | Diagnostic / XR / Playwright — **gated off** | Code remains; selection restored in [#141](https://github.com/ford442/Chromashift/issues/141) |
| **WASM SIMD128** | Accelerated CPU luminance/classification | TypeScript engine (identical API), used automatically if the WASM binary isn't built |
| **ORT (onnxruntime-web)** | Optional waifu2x upscaling, lazy-loaded | TF.js Real-ESRGAN/Real-CUGAN covers the other upscale path |

See [AGENTS.md](AGENTS.md#browser-requirements) for the full matrix with version/build requirements.

## Roadmap

**[docs/ROADMAP.md](docs/ROADMAP.md)** is the maintained roadmap (shipped vs. planned).
Open strategic backlog: **[#141](https://github.com/ford442/Chromashift/issues/141)–[#145](https://github.com/ford442/Chromashift/issues/145)** (#115–#133 are closed).

| Status | Highlights |
|--------|------------|
| **Shipped** | Colour profiles + schema v3, live source, gpu-chores, compare dual/swipe/quad, WebGPU hard-fail, WebCodecs export — see [ROADMAP.md](docs/ROADMAP.md) |
| **Next** | Explicit WebGL diagnostic backend ([#141](https://github.com/ford442/Chromashift/issues/141)); optional GPU features / HDR ([#142](https://github.com/ford442/Chromashift/issues/142)); profile designer ([#143](https://github.com/ford442/Chromashift/issues/143)) |
| **Then** | Kiosk camera + live capture ([#144](https://github.com/ford442/Chromashift/issues/144)); compute persistence / no per-frame WASM ([#145](https://github.com/ford442/Chromashift/issues/145)) |
| **Research** | WebGPU-XR swapchain — [WebXR.md](docs/WebXR.md); blocked on [#141](https://github.com/ford442/Chromashift/issues/141) while WebGL selection is off |

Full per-issue detail and file pointers: **[docs/ROADMAP.md](docs/ROADMAP.md)**.
