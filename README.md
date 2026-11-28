# Chromashift

[![CI](https://github.com/ford442/chromashift/actions/workflows/ci.yml/badge.svg)](https://github.com/ford442/chromashift/actions/workflows/ci.yml)

A WebGPU-based visual engine that performs real-time RGB colour separation and independent layer rotation — replacing a legacy Canvas 2D / Emscripten slideshow. WebGL2 is available as an **explicit** diagnostic / XR / screenshot backend (`?renderer=webgl` or `?webgl2=1`); it is not an automatic fallback when WebGPU fails, and an active WebGL2 session shows a **WEBGL2 active** banner.

## Features

- **5-pass GPU rendering pipeline** — 3 colour-band layers (Red/Orange, Violet/Blue, Green/Yellow), a persistence pass that accumulates decaying "tracer" overlays where 2+ layers coincide, and a compositor pass that blends everything to the canvas.
- **GPU-only colour separation** — luminance-based colour masking is computed entirely in WGSL fragment shaders; zero CPU-side pixel manipulation on the hot path.
- **Independent layer rotation** — each layer has its own rotation angle and rate, driven by a `mat3x3` rotation matrix uploaded as a vertex-shader uniform.
- **Hybrid TS/C++ WASM engine** — luminance and classification-mask computation run in an optional SIMD128 C++ WASM module, with a pure-TypeScript fallback exposing the identical API (see [Hybrid Engine](#hybrid-engine-typescript--c-wasm) below).
- **GPU compute analysis** — optional WebGPU compute shaders accelerate luminance histogram + band classification for large (4K–8K) images.
- **WebGL2 diagnostic renderer** — `src/engine/webgl/`, selected with `?renderer=webgl` / the Renderer panel. Failed WebGPU boots still hard-fail (`window.usingWebGL === false`); the overlay may open a *new* diagnostic session. See [docs/webgl-fallback.md](docs/webgl-fallback.md).
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
| GPU | [WebGPU](https://gpuweb.github.io/gpuweb/) (WGSL shaders), WebGL2 diagnostic backend (GLSL ES 3.00) |

## Requirements

- A browser with WebGPU support: **Chrome 113+**, **Edge 113+**, or Chrome Canary.
- For diagnostic / XR / screenshot sessions: any browser with WebGL2 (`?renderer=webgl`).
- Node.js **^20.19 or >=22.12** (`engines.node`; Vite 7's floor). `.nvmrc` pins 22, which CI uses (`nvm use`)

### Recommended GPU / browser setup

| Item | Guidance |
|---|---|
| Browser | Chrome or Edge 113+ with WebGPU enabled |
| GPU | Discrete GPU recommended for 4K+ canvases; integrated GPUs work for HD |
| Texture headroom | Chromashift requests up to **8192 px** `maxTextureDimension2D` when the adapter allows it |
| Chrome flags | On older builds, enable WebGPU via `chrome://flags/#enable-unsafe-webgpu` |
| Fallback | **Off.** Failed WebGPU boots show a blocking probe screen. Explicit WebGL: `?renderer=webgl` ([webgl-fallback.md](docs/webgl-fallback.md)) |

GPU bootstrap (`src/engine/webgpu/webgpuSession.ts`, over `adapter.ts` and `canvasConfig.ts`) logs adapter info at startup, derives conservative `requiredLimits`, handles `device.lost`, and surfaces uncaptured errors. See [docs/gpu-bootstrap.md](docs/gpu-bootstrap.md) for the WebGPU/WebGL options matrix.

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

Renderer selection:

```bash
http://localhost:5173/?renderer=webgpu  # default production path
http://localhost:5173/?renderer=webgl   # diagnostic / XR / Playwright
```

Runtime breadcrumbs: `window.rendererType`, `window.usingWebGPU`, `window.usingWebGL`, `window.webgpuProbe`, `window.rendererFallbackReason`.

## Build

```bash
npm run build
npm run preview
```

## Build-time variables

`npm run build` reads `.env.production` (committed; nothing in it is secret). An exported
`VITE_*` variable or a gitignored `.env.local` overrides it. Every `VITE_*` variable the
code reads is listed here; adding one means adding it here and to `.env.production`.

| Variable | Shipped value | Used by | If unset |
|---|---|---|---|
| `VITE_UPSCALER_BASE` | `https://js.1ink.us` | TF.js Real-ESRGAN / Real-CUGAN model trees (`realesrgan/`, `realcugan/`), fetched by `upscaler.worker.ts` | Those upscalers throw `VITE_UPSCALER_BASE is not set` (the default model, `realesrgan:general_plus`, is one of them) |
| `VITE_NUNIF_BASE` | `https://test.1ink.us/nunif` | waifu2x swin_unet ONNX models (`models/swin_unet/`, `models/utils/`) | Same URL, from `NUNIF_DEFAULT_BASE` in `Upscaler.ts` |
| `VITE_NUNIF_ORT_WASM_BASE` | *(unset)* | onnxruntime-web runtime (`ort-wasm-simd-threaded.{mjs,wasm}`), kept out of `dist/` | `https://cdn.jsdelivr.net/npm/onnxruntime-web@<installed version>/dist`, derived at build time (`ortRuntime.ts`). The runtime must be the bundled package's exact release; set this only for a mirror you keep in step |

The page is cross-origin isolated (COEP `require-corp`), so each host must answer with
`Access-Control-Allow-Origin` and `Cross-Origin-Resource-Policy: cross-origin`; the three
above do (jsDelivr does too). `npm run build` fails (`check:dist`) if the upscaler base did not reach the bundle.

Every build is stamped: `dist/version.json` is `{ "sha", "dirty", "builtAt" }`, and the page
publishes the same object as `window.chromashiftBuild`. `BUILD_SHA` / `BUILD_DIRTY` override
git for builds made without a checkout; a build with neither is `sha: "unknown"`, `dirty: true`.

`npm run preview` sends the production host's isolation headers (COOP `same-origin`, COEP
`require-corp`, CORP `cross-origin`), so the production build is tested the way it is served.
`public/.htaccess` ships in `dist/` and carries the same headers, `DirectoryIndex index.html`,
`Options -Indexes` and the `.wasm`/`.js` MIME types for the Apache host.

`public/` also holds `e2e-fixture.png`, `wasm-benchmark.html` and `wasm-benchmark-core.mjs`.
They are served by `npm run dev` (E2E specs, `bench:wasm`) and deliberately left out of
`dist/`; `check:dist` fails if one ships.

## Deploy

`dist/` is uploaded to the test server via SFTP (`deploy.py`) to one of two targets:

| Target | Remote directory | URL |
|---|---|---|
| `staging` (default) | `test.1ink.us/chromashift-staging` | https://test.1ink.us/chromashift-staging/ |
| `production` | `test.1ink.us/chromashift` | https://test.1ink.us/chromashift/ |

```bash
npm run build
pip install -r requirements-deploy.txt

# Credentials come only from the environment; none are stored in this repo.
export DEPLOY_USER=your-sftp-user
export DEPLOY_KEY=~/.ssh/id_ed25519      # or an ssh-agent, or DEPLOY_PASS as a fallback
python deploy.py                         # staging
python deploy.py --target production
```

Flags:

| Flag | Effect |
|------|--------|
| `--target staging\|production` | Which site to upload to (default `staging`) |
| `--dry-run` | Connect and list remote deletions + local uploads; no server changes |
| `--no-clean` | Upload without wiping the remote target directory first |

By default the script **deletes existing remote files** in the target path before upload
(downtime and no previous copy until #272 makes it atomic). Use `--dry-run` to preview.

Optional env overrides: `DEPLOY_HOST` (default `1ink.us`), `DEPLOY_PORT` (default `22`),
`DEPLOY_REMOTE_DIR` (replaces the target's directory).

**GitHub Actions:** run the [Deploy workflow](.github/workflows/deploy.yml) from the Actions
tab (`workflow_dispatch`) and pick the `target`. It builds the chosen commit, refuses to
upload unless `dist/version.json` is that commit with `dirty: false`, deploys, then checks
the live root URL serves the app, `version.json` matches, and `.wasm` is `application/wasm`.
It needs two repository secrets (Settings > Secrets and variables > Actions), which only a
repository owner can add: `DEPLOY_USER` (SFTP username) and `DEPLOY_KEY` (private key, PEM or
OpenSSH). Never commit credentials or log key/password values.

`npm run build` runs `check:dist`, which fails if `ort-wasm*.wasm` is emitted into `dist/`.
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
| `smoke.spec.ts` | chromium | WebGL bootstrap, `window.usingWebGL`, canvas visible, Renderer panel tooltip |
| `webgpu-hard-fail.spec.ts` | chromium | Failed WebGPU boot does not set `usingWebGL`; overlay offers diagnostic session |
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
SIMD128 (`-msimd128`, with bulk-memory, nontrapping float-to-int and sign-extension) for
accelerated pixel-processing. If the WASM binary
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
    webgpu/             # WebGPU backend: WebGPURenderer (the pass-graph executor draws the frame),
                        #   TextureManager, inspect views (TracerInspectPass, WebGPUPipelines), readback
    graph/              # pass-graph IR, compiler and WebGPU executor (docs/PASS_GRAPH.md)
    webgl/              # WebGL2 diagnostic / XR renderer: WebGLRenderer + WebGLGraphExecutor over the compiled graph
    gpu/                # adapter/device/canvas bootstrap shared by both backends
    rendererMode.ts     # URL/localStorage/backend breadcrumb selection
    library/            # corpus manifest + search, IndexedDB local image library (drag-and-drop)
    live/               # camera / screen / video-file source
    upscale/            # Lazy-loaded AI upscalers (Upscaler.ts + two workers)
    frame/              # FrameClock: the one requestAnimationFrame loop
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

See [docs/webgl-fallback.md](docs/webgl-fallback.md) for the explicit-WebGL policy, debug helpers, and WebGL-to-WebGPU shader porting notes.

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
Open backlog: **[#223](https://github.com/ford442/Chromashift/issues/223)–[#228](https://github.com/ford442/Chromashift/issues/228)**, **[#206](https://github.com/ford442/Chromashift/issues/206)**, **[#178](https://github.com/ford442/Chromashift/issues/178)** and **[#177](https://github.com/ford442/Chromashift/issues/177)**. #143, #144 and #153 were closed as not planned; #145 and #149–#155 otherwise shipped.

| Status | Highlights |
|--------|------------|
| **Shipped** | Colour profiles + schema v3/v4, live source, gpu-chores, compare dual/swipe/quad, WebGPU hard-fail, explicit WebGL diagnostic backend, optional GPU features, WebCodecs export, compute persistence, the pass-graph IR on both backends, motion-aware tracers, real WASM SIMD — see [ROADMAP.md](docs/ROADMAP.md) |
| **Foundation first** | Correctness sweep ([#225](https://github.com/ford442/Chromashift/issues/225)); checked inputs, one parameter registry, one frame clock ([#226](https://github.com/ford442/Chromashift/issues/226)) |
| **Next** | One graph everywhere ([#228](https://github.com/ford442/Chromashift/issues/228)); multi-output slots ([#178](https://github.com/ford442/Chromashift/issues/178)); performance timeline ([#224](https://github.com/ford442/Chromashift/issues/224)) |
| **Then** | Modulation matrix ([#227](https://github.com/ford442/Chromashift/issues/227)); previous-frame feedback ([#223](https://github.com/ford442/Chromashift/issues/223)); one ONNX ML stack ([#206](https://github.com/ford442/Chromashift/issues/206)); node editor ([#177](https://github.com/ford442/Chromashift/issues/177)) |
| **Research** | WebGPU-XR swapchain — [WebXR.md](docs/WebXR.md); WebGL presenter path is unblocked via `?renderer=webgl` |

Full per-issue detail and file pointers: **[docs/ROADMAP.md](docs/ROADMAP.md)**.
