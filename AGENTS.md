# Chromashift — AI Agent Guide

## Project Overview

Chromashift is a WebGPU-based visual engine that renders images through a multi-pass colour-separation pipeline. It replaces a legacy Canvas 2D / Emscripten slideshow. The current implementation uses a **5-pass GPU pipeline**:

1. **Layer 0** — isolates high-luminance pixels and maps them to red/orange hues.
2. **Layer 1** — isolates mid-high luminance and maps them to violet/blue hues.
3. **Layer 2** — isolates mid luminance and maps them to green/yellow hues.
4. **Persistence pass** — detects spatial overlap between 2+ layers and accumulates the mixed colour into a pair of ping-pong "tracer" textures that decay over time.
5. **Compositor pass** — blends the live layers with the decaying tracer textures and draws the final result to the canvas.

Each layer has independent rotation (driven by a `mat3x3` uniform) and can be flipped. The UI is a fixed left-side control panel built with React and Tailwind CSS v4, using a gold-tinted glass-morphism theme.

For what's already shipped vs. planned next, see the [Roadmap](README.md#roadmap) in README.md — it groups open GitHub issues into foundation / features / research.

## Tech Stack

| Layer | Technology | Version |
|---|---|---|
| Bundler | Vite | ^7.0.0 |
| UI | React + TypeScript | 19, ~5.9 |
| Styling | Tailwind CSS v4 | ^4.2.1 |
| GPU API | WebGPU + WGSL, WebGL2 + GLSL ES 3.00 fallback | — |

## Common Commands

```bash
npm run dev       # Start Vite dev server (http://localhost:5173)
npm run build     # Type-check with tsc then build to dist/
npm run lint      # ESLint (flat config, v9+)
npm run preview   # Preview the production build locally
```

## Key Dependency Constraints

- `@tailwindcss/vite` v4 supports **Vite `^5-7` only** — do **not** upgrade Vite to v8 or higher until Tailwind's Vite plugin publishes support for it.
- `@vitejs/plugin-react` v5 is required for Vite 7 compatibility; v6 requires Vite 8.

## Architecture

This tree covers every top-level directory under `src/`; file comments are illustrative,
not exhaustive — grep the directory itself for the full file list.

```
src/
├── main.tsx                  # React entry point (createRoot + StrictMode)
├── App.tsx                   # Root component — wires all hooks below, renders <AppUI>
├── index.css                 # @import "tailwindcss" + extensive gold/glass custom CSS
├── components/
│   ├── AppUI.tsx              # Presentational root: canvas, previews, ImageStrip, overlay
│   ├── ImageStrip.tsx         # Corpus browser (remote + LOCAL/REMOTE badges, drag-drop target)
│   ├── RotaryKnob.tsx         # Reusable rotation-angle dial control
│   └── overlay/               # NunifOverlay split into per-concern section panels
│       ├── NunifOverlay.tsx       # Shell that composes the panels below
│       ├── LayerPanel.tsx, TracerPanel.tsx, PlayPanel.tsx, ViewportPanel.tsx,
│       │   RendererPanel.tsx, DiagnosticsPanel.tsx, ExportPanel.tsx,
│       │   PresetsPanel.tsx, UpscalePanel.tsx  # one panel per settings group
│       └── useOverlaySections.ts, types.ts, constants.ts
├── hooks/                    # App.tsx's logic, extracted so the component stays declarative
│   ├── useChromashiftStore.ts    # Reducer-backed store (state slices) + refs bundle
│   ├── useAppWebGPUInit.ts       # WebGPU/WebGL bootstrap, initial image list + local library merge
│   ├── useImagePlayback.ts       # Loads the current/reference texture on index change, evicts old ones
│   ├── useMediaHandlers.ts       # File/drop/upscale handlers (handleDropFiles, handleLoadFile, …)
│   ├── useAnimationLoop.ts, useAppLifecycle.ts, useClassificationMask.ts,
│   │   useTracerInspectInteraction.ts, useVideoExport.ts, usePresets.ts, useAppUiProps.ts
├── state/                    # Reducer, slices, and (de)serialization — see `ChromashiftState`
│   ├── chromashiftReducer.ts, defaults.ts, types.ts
│   └── serializeSettings.ts, presetUrl.ts, presetLibrary.ts, presetGallery.ts  # see docs/PRESETS.md
└── engine/
    ├── shaders/              # WGSL modules assembled in TS (thin assembler)
    │   ├── index.ts          # Re-exports all shader sources (import via './shaders')
    │   ├── common.ts         # Vertex shaders, colour/blend helpers, BAND_WGSL
    │   │                     # (band thresholds generated from math/bandClassification.ts BAND)
    │   ├── layers.ts         # 3 layer fragment shaders (shared header/prelude)
    │   ├── persistence.ts    # Tracer persistence pass
    │   ├── compositor.ts     # Final compositor pass
    │   └── diagnostics.ts    # Tracer view, display, heatmap, diagnostic, compare passes
    ├── TextureManager.ts     # Image fetch, ImageBitmap → GPUTexture, URL cache, evictExcept()
    ├── WebGLTextureManager.ts # Image fetch, HTMLImageElement/raw pixels → WebGLTexture
    ├── LocalLibrary.ts       # IndexedDB-backed local image library (drag-and-drop uploads)
    ├── fileDrop.ts           # Flattens a drop's DataTransfer (incl. folders) into File[]
    ├── Upscaler.ts           # Lazy Web Worker wrapper for the two upscale backends below
    ├── upscaler.worker.ts    # TF.js Real-ESRGAN / Real-CUGAN
    ├── nunif.worker.ts       # onnxruntime-web swin_unet (waifu2x)
    ├── viewModes.ts          # MAIN_VIEW_MODES enum (composite, tracer, layers, quarter-zoom, …)
    ├── rendererMode.ts       # URL/localStorage renderer selection + runtime breadcrumbs
    ├── RendererTypes.ts / types/RendererContracts.ts  # Shared renderer/texture contracts
    ├── gpuBootstrap.ts, gpuOptions.ts  # Adapter/device/context setup, limits, device.lost
    ├── WebGLRenderer.ts      # WebGL2 fallback/reference implementation with debug modes
    ├── WebGPURenderer.ts     # 5-pass GPU renderer orchestration (delegates to the below)
    ├── WebGPUPipelines.ts, BindGroupCache.ts, PersistencePass.ts, CompositorPass.ts,
    │   TracerInspectPass.ts, GpuReadback.ts, GpuTimestampProfiler.ts  # pass/readback + WebGPU perf HUD
    ├── videoExport/          # Offline frame-by-frame WebM/PNG-sequence export — see docs/VIDEO_EXPORT.md
    ├── compute/
    │   ├── GpuImageAnalysis.ts   # WebGPU histogram + r8uint classification mask
    │   ├── computeSupport.ts     # Feature detection + window breadcrumbs
    │   └── wgslSnippets.ts       # Shared WGSL threshold helpers (C++ parity)
    └── math/                 # Pure TS (bandClassification, rotation, decay) shared with tests/C++ parity
```

### Renderer Selection / WebGL2 Fallback

The primary backend remains WebGPU. A WebGL2 fallback is available for visual debugging, Playwright screenshots, and shader-porting reference work:

```bash
npm run dev
# Primary path
http://localhost:5173/?renderer=webgpu
# Fallback/reference path
http://localhost:5173/?renderer=webgl
http://localhost:5173/?webgl
```

The NUNIF panel exposes a **Renderer** control that persists `chromashift.renderer` in localStorage and reloads with the selected `?renderer=` parameter. Runtime breadcrumbs are intentionally global for automation: `window.rendererType`, `window.usingWebGPU`, `window.usingWebGL`, and `window.rendererFallbackReason`.

WebGL mode consumes the same `RendererState` as WebGPU: image selection, layer angles, flips, average luminance, colour mode, Sobel/soft band toggles, layer opacity, blend modes, output mode, diagnostics, and tracer settings. It is an approximate reference renderer, not a replacement for the full WGSL path. Keep WebGPU as the source of truth for production behaviour.

WebGL-only debug helpers are in the Renderer panel:
- `Composite parity` — normal fallback compositing.
- `Luminance mask` — grayscale BT.709 luminance after shared rotation.
- `Rotation UV grid` — transformed UVs and a grid to debug layer rotation/flips.
- `Layer mask isolation` — shows active per-layer mask output before final compositing.

For shader-based effect work, prototype/inspect in `WebGLRenderer.ts` when browser automation needs visible pixels, then port the final logic into `src/engine/shaders/` / `WebGPUPipelines.ts`. Band thresholds must come from the canonical `BAND` table in `src/engine/math/bandClassification.ts` (via `BAND_WGSL`) — never hardcode them in WGSL; `src/engine/shaders/bandTable.test.ts` guards TS/WGSL/C++ against divergence. Keep thresholds, uniforms, and state fields aligned between both renderers when the effect is meant to be shared.

### Rendering Pipeline (Detailed)

1. `TextureManager.fetchImageList('/images.json')` loads the image list on startup.
2. `TextureManager.loadTexture(url)` converts each image to a `GPUTexture` (`rgba8unorm-srgb`) via `copyExternalImageToTexture`; `WebGLTextureManager.loadTexture(url)` uploads the same decoded image to a WebGL texture.
3. `WebGPURenderer` creates:
   - 3 independent `GPURenderPipeline`s for the colour layers (each can use 4× MSAA).
   - 1 persistence pipeline that reads the 3 layer textures + previous tracer texture.
   - 1 compositor pipeline that blends tracers + live layers and writes to the swap-chain.
4. Each frame, `renderer.render(state)` receives the shared `RendererState`. WebGPU encodes all passes into a single command buffer; WebGL runs equivalent GLSL/FBO passes for debugging/reference output.

### Presets & Shareable URLs

Render settings serialize to a versioned JSON document (`src/state/serializeSettings.ts`, `version: 1`). `src/state/presetUrl.ts` encodes it as a base64url `?preset=` parameter applied inside the store's lazy initializer — before the first frame. The Presets panel (`PresetsPanel.tsx` + `usePresets.ts`) offers a built-in gallery (`presetGallery.ts`), named localStorage presets (`presetLibrary.ts`), share-URL copy, and JSON file export/import. Invalid presets fall back to defaults with `ui.presetLoadError` set. See `docs/PRESETS.md`.

### Kiosk / gallery installation

`?kiosk=1` enables installation mode (see `docs/KIOSK.md`): hides NUNIF chrome, forces autoplay + attract parameter drift, large bottom remote, fullscreen + wake lock (`useKioskMode.ts`), and **Esc** to restore panels. Breadcrumb: `window.kioskMode`. WebXR remains future research — kiosk targets desktop Chrome today.

### Compare / multi-view (planned)

Side-by-side preset comparison (dual 2-up, quad grid, swipe split) is **not shipped yet**. Architecture, GPU budget rules, and phased acceptance criteria: `docs/COMPARE_VIEWS.md`. Shared types/helpers: `src/engine/compareViews.ts` (`CompareLayoutMode`, `effectiveLayerScaleForMultiView`, `multiViewPerformanceNote`).

### Local Image Library (drag-and-drop)

Dropping image files (or whole folders) anywhere on `#chromashift-container` persists them to IndexedDB (`src/engine/LocalLibrary.ts`, db `chromashift-library`) — labels, dimensions, and a small WebP thumbnail alongside the original bytes — so the personal library survives page reloads without any server upload. `src/engine/fileDrop.ts` flattens a drop's `DataTransfer` (including nested folders, via `webkitGetAsEntry`) into a plain `File[]`; `useMediaHandlers.handleDropFiles` writes them to IndexedDB and appends `ImageEntry`s carrying a `localId` and a `blob:` URL — the corpus, image strip, and texture pipeline don't otherwise distinguish local from remote entries.

`ImageStrip` shows a LOCAL/REMOTE badge per entry (using `thumbUrl`, not the full-res `url`, to avoid decoding full images just for a 144px thumbnail) and a "Clear Library" button that wipes IndexedDB and drops every `localId`-tagged entry from the corpus.

Because local entries are ordinary `blob:` URLs, `TextureManager`/`WebGLTextureManager` need no special-casing to decode them (no CORS, unlike some remote hosts). The one addition is `evictExcept(keepUrls)`, called after each texture swap in `useImagePlayback`: it destroys any cached GPU texture backed by a `blob:` URL that isn't the current source or reference, so switching away frees GPU memory and switching back simply re-decodes from the (already-resident) blob on demand. Remote `http(s)` textures are still cached forever.

### Upscaler (lazy-loaded)

`Upscaler` (`src/engine/Upscaler.ts`) wraps two Web Workers, both created lazily via `new Worker(new URL('./*.worker.ts', import.meta.url), { type: 'module' })` inside the "Upscale Source" / "Upscale Output" click handlers (`src/hooks/useMediaHandlers.ts`). Vite emits each worker as its own chunk, so neither TF.js nor onnxruntime-web (and its ~26 MB `ort-wasm-simd-threaded.jsep.wasm`) is fetched on initial page load — only after the user actually invokes an upscale. Verify this stays true after changes by running `npm run build` and confirming `dist/assets/index-*.js` contains no `tfjs`/`ort-wasm` references, or by checking the Network panel on a fresh load.

- **`upscaler.worker.ts`** — TF.js Real-ESRGAN / Real-CUGAN. Model weights are **not** bundled or CDN-hosted by default; set `VITE_UPSCALER_BASE` to a URL you self-host (containing `realesrgan/` and `realcugan/` model trees) or upscaling throws.
- **`nunif.worker.ts`** — onnxruntime-web swin_unet (waifu2x). Defaults to a public CDN base (`NUNIF_DEFAULT_BASE` in `Upscaler.ts`); override with `VITE_NUNIF_BASE` to self-host the `models/swin_unet/` and `models/utils/` ONNX files instead. The ORT wasm runtime itself is always loaded from jsDelivr (`ort.env.wasm.wasmPaths` in `nunif.worker.ts`), not bundled, to avoid shipping it in `dist/`.

Both workers cache downloaded models (`upscaler.worker.ts` in IndexedDB, browser HTTP cache for `nunif.worker.ts`) and post a `"Downloading model…"` progress message only on an actual first-time fetch, not on cache hits.

### Viewport Modes

`src/engine/viewModes.ts` defines `MAIN_VIEW_MODES` (composite, full-res tracer, source/reference/previous image, individual layers, coincidence heatmap, compare split-views, stamp diagnostics). The Viewport panel (`ViewportPanel.tsx`) additionally offers two mutually-exclusive display transforms layered on top of the composite view:

- **Quarter Zoom** (`viewportQuarterZoom`) — crops and scales the main canvas to just its bottom-left quarter, for inspecting fine detail at effectively higher resolution.
- **Half Overlay** (`viewportHalfOverlay`) — overlays the canvas's top and bottom halves on top of each other.

Both are disabled while viewing the full-res tracer or any non-composite view mode.

### Video Export

`src/engine/videoExport/` renders offline frames (independent of the live canvas/animation loop) to produce a WebM or PNG-sequence export at a configurable duration, FPS, resolution scale, and pass mode (composite/tracers/layers). Driven by `useVideoExport.ts` + `ExportPanel.tsx`. See `docs/VIDEO_EXPORT.md`.

### GPU Image Analysis (Compute)

Optional WebGPU compute shaders accelerate load-time analysis for large (4K–8K) images. Implemented in `src/engine/compute/GpuImageAnalysis.ts`:

1. **Histogram pass** — BT.709 luminance per pixel → 256-bin atomic histogram on GPU; average luminance derived from the histogram (256-entry readback only).
2. **Classification pass** — writes an `r8uint` band-index mask texture (thresholds in `wgslSnippets.ts`, matching `chromashift_engine.cpp` / `bandClassification.ts`).
3. **Layer binding** — mask is fed into existing layer pipelines via `setClassificationMaskTexture()` when `colorMode === 0` (Original CR0P fixed).

**Selection order** (`useClassificationMask.ts`):

1. WebGPU compute (preferred when `renderer.backend === 'webgpu'` and `GpuImageAnalysis.isSupported()`).
2. WASM `computeClassificationMask` (when Engine mode = WASM).
3. TypeScript `classifyImageMaskWith` fallback.

**Feature detection**: `detectGpuComputeSupport(device)` gates on adapter `maxTextureDimension2D`. Breadcrumbs: `window.gpuComputeAvailable`, `window.gpuComputeReason`. WebGL mode skips compute entirely.

**Parity tests**: `src/engine/compute/goldenMask.test.ts` checks the TS fallback against an f32-accurate port of C++ `computeClassificationMask` on a golden image (exact match, several avgLum values), asserts the WGSL `classify_band()` chain is generated from `BAND_THRESHOLDS`, and bounds the histogram-derived average within one bucket of the exact BT.709 average. `BAND_THRESHOLDS` in `src/engine/math/bandClassification.ts` is the single source of truth for band thresholds — the WGSL threshold chain is generated from it.

### WebGPU MSAA

When `enableMSAA` is true (`sampleCount = 4`):

- Layer pipelines render into a shared `msaaTexture` (4×) and **resolve** into `layerTextures` (always `sampleCount: 1`) so persistence and compositor passes can sample them as ordinary 1× textures.
- The compositor pass writes directly to the swap-chain at 1× (no MSAA resolve on the canvas).
- `setAntialiasing()` recreates pipelines and destroys `msaaTexture`; `ensureLayerTextures()` recreates it when the canvas size changes.

MSAA pipelines must match the render-pass attachment `sampleCount`. A 4× pipeline cannot target a 1× texture without a `resolveTarget`.

### GPU Performance Instrumentation (WebGPU only)

Per-pass GPU timing uses the optional `timestamp-query` feature. At bootstrap, Chromashift requests every adapter-supported entry in `CHROMASHIFT_OPTIONAL_FEATURES` (`gpuOptions.ts`), including `timestamp-query` when present. Breadcrumbs: `window.gpuTimestampAvailable`, `window.gpuTimestampReason`.

`GpuTimestampProfiler` (`src/engine/GpuTimestampProfiler.ts`) wraps the live render path in `WebGPURenderer`:

1. **Layers** — three colour-band passes (MSAA resolve when enabled).
2. **Persistence** — dual tracer ping-pong + diagnostic texture.
3. **Compositor** — final blend or alternate main-view pass (tracer inspect, layer isolation, etc.).
4. **Readback** — preview thumbnail + collision-stats blit/copy when queued.

Timestamps resolve to a ping-pong buffer after submit; results appear one frame later. The Diagnostics panel **Perf HUD** toggle (`output.performanceHudEnabled`) gates all query writes and resolves — when off, there is zero timestamp cost. The HUD shows CPU ms, per-pass GPU ms, an approximate bandwidth model, a 120-frame sparkline, budget warnings (`1000 / fps` ms), and optional auto-degrade (disable MSAA, tracer scale ×0.75, live preview readback off).

WebGL2 fallback reports CPU timing only (`GPU timing N/A` in the HUD). See `docs/webgl-fallback.md`.

### Colour Bands (WGSL Fragment Shaders)

Luminance is calculated via ITU-R BT.709: `0.2126R + 0.7152G + 0.0722B`, scaled 0–255.

Each fragment shader first preprocesses the luminance with values derived from `avgLuminance`:

```
diff      = (avgLuminance / 255) * 32
lightDark = 128 + abs(avgLuminance - 128) / 2
rgb       = lum + lightDark / 2
grey      = avgLuminance
```

Then each shader checks `rgb` against the original cr0p thresholds and outputs fixed RGB colours (not smooth gradients).

| Band | Threshold | Layer | Colour (RGB 0–1) |
|---|---|---|---|
| Grey highlight | `rgb > 229` | 0 | `(grey+(rgb-229))/255` |
| Orange | `209 < rgb ≤ 229` | 0 | `(255, 128-diff, 0)` |
| Red | `193 < rgb ≤ 209` | 0 | `(255-diff, 0, 0)` |
| Border red | `190 < rgb ≤ 193` | 0 | `(255, 0, 0)` |
| Violet | `177 < rgb ≤ 190` | 1 | `(128-diff, 0, 255)` |
| Blue | `161 < rgb ≤ 177` | 1 | `(0, 0, 255-diff)` |
| Border blue | `158 < rgb ≤ 161` | 1 | `(0, 0, 255)` |
| Green | `145 < rgb ≤ 158` | 2 | `(0, 255-diff, 0)` |
| Yellow | `128 < rgb ≤ 145` | 2 | `(255, 255-diff, 0)` |
| Border yellow | `125 < rgb ≤ 128` | 2 | `(255, 255, 0)` |
| Dark / grey | `rgb ≤ 126` | All | `(grey-(rgb-128))/255` |

The `avgLuminance` uniform is computed automatically when an image loads — preferring the GPU histogram when compute is available, otherwise `computeAverageLuminanceWith()` (WASM or TypeScript). Users can still override it with the UI slider.

### Persistence / Tracer System

- **Dual tracers**: There are two independent ping-pong buffers — "Above" and "Below".
  - `tracerAboveDuration` / `tracerAboveIntensity` — short-lived, vivid overlay (default 500 ms, 85 %).
  - `tracerBelowDuration` / `tracerBelowIntensity` — longer-lived base glow (default 2000 ms, 30 %).
- **Decay**: `durationToDecay(ms, fps)` computes a per-frame multiplier so the tracer fades to ~1/255 over the configured duration. 3-layer overlaps decay slower than 2-layer overlaps.
- **Modes**: `tracerMode` can be `0` (combined colours) or `1` (grey highlight).
- **Blend modes**: Both the live layers and the tracers support independent blend modes — Alpha, Add, Subtract, Multiply, Screen.

### State & Animation Loop (`App.tsx`)

- Default per-frame rotation steps: `[-130, 230, 330]` degrees per frame (layer 0 subtracts, layers 1 & 2 add).
- Default FPS: 30.
- Auto-play: every `imageChangeInterval` seconds the current image index changes to a random entry from `images.json`.
- Canvas sizing: the main canvas is kept square and sized to `min(95vh, container width, container height)` with `devicePixelRatio` scaling.

## Image Source

Edit `public/images.json` to change the image list:

```json
[
  { "url": "https://example.com/image.jpg", "label": "My Scene" }
]
```

The `TextureManager` fetches this file at startup and caches textures by URL.

## Code Style & Conventions

- **Linting**: ESLint v9 flat config (`eslint.config.js`). Extends `@eslint/js/recommended`, `typescript-eslint/recommended`, `react-hooks/flat/recommended`, and `react-refresh/vite`.
- **TypeScript**: Strict mode is enabled. Two project references are used:
  - `tsconfig.app.json` — compiles `src/`, includes `vite/client` and `@webgpu/types`.
  - `tsconfig.node.json` — compiles `vite.config.ts`, includes `@types/node`.
- **Styling**: Tailwind CSS utility classes are used inline in JSX. Custom gold/glass theme variables and animations live in `src/index.css`.
- **File naming**: PascalCase for components and engine classes (`App.tsx`, `WebGPURenderer.ts`), camelCase for utilities and hooks.
- **Imports**: `type` imports are used where appropriate (`verbatimModuleSyntax` is enabled).

## Testing Strategy

There is **no test framework** currently configured in this project. There are no unit tests, integration tests, or E2E tests. If you add tests, consider:

- **Vitest** for unit-testing pure TS utilities (e.g. `durationToDecay`, `buildRotationMat3`).
- **Playwright** for E2E validation of the WebGPU canvas (note: requires a Chromium browser with WebGPU enabled).

## Deployment Process

A Python script (`deploy.py` at repo root) handles deployment:

```bash
npm run build
python deploy.py
```

- It uses **Paramiko/SFTP** to recursively upload the `dist/` directory.
- Target server: `1ink.us` (port 22).
- Remote path: `test.1ink.us/chromashift`.
- **Security note**: Credentials are read from `DEPLOY_USER` / `DEPLOY_PASS` env vars (falling back to `CHANGEME` placeholders in the script, which refuse to run). There is no password-only, key-based auth path yet, and `CLEAN_BEFORE_UPLOAD = True` is destructive with no dry-run — see issue tracking hardening this further.

## Browser Requirements

Chromashift layers four independent capability checks; each degrades gracefully to the
next without blocking the app from loading:

| Capability | Role | Requirement | Fallback if unavailable |
|---|---|---|---|
| **WebGPU** | Primary renderer (5-pass pipeline, GPU compute analysis) | Chrome 113+ / Edge 113+ / Chrome Canary | Falls back to WebGL2 automatically on init failure or `device.lost`; force with `?renderer=webgl` |
| **WebGL2** | Debug/reference renderer, Playwright screenshots, shader-porting | Any browser with WebGL2 (Firefox, Safari included) | N/A — this *is* the fallback |
| **WASM SIMD128** | Accelerated CPU luminance/classification (`cpp/chromashift_engine.cpp`) | Chrome/Edge/Firefox with WASM SIMD; requires `npm run build:wasm` (Emscripten) | Silently uses the TypeScript engine (`WasmEngine.ts`) — same public API either way |
| **ORT (onnxruntime-web)** | Optional waifu2x upscaling (`nunif.worker.ts`) | Any WebGPU/WebGL2 browser; loaded lazily only when "Upscale" is clicked | Real-ESRGAN/Real-CUGAN via TF.js (`upscaler.worker.ts`) covers the other upscale path |

Firefox and Safari do not yet have stable WebGPU support — use `?renderer=webgl` there.

See `docs/gpu-bootstrap.md` (WebGPU/WebGL matrix), `docs/wasm-engine.md` (SIMD build/browser
support), and the Upscaler section above (ORT vs TF.js) for the full detail behind this table.
