# Chromashift — AI Agent Guide

## Project Overview

Chromashift is a WebGPU-based visual engine that renders images through a multi-pass colour-separation pipeline. It replaces a legacy Canvas 2D / Emscripten slideshow. The current implementation uses a **5-pass GPU pipeline**:

1. **Layer 0** — isolates high-luminance pixels and maps them to red/orange hues.
2. **Layer 1** — isolates mid-high luminance and maps them to violet/blue hues.
3. **Layer 2** — isolates mid luminance and maps them to green/yellow hues.
4. **Persistence pass** — detects spatial overlap between 2+ layers and accumulates the mixed colour into a pair of ping-pong "tracer" textures that decay over time.
5. **Compositor pass** — blends the live layers with the decaying tracer textures and draws the final result to the canvas.

Each layer has independent rotation (driven by a `mat3x3` uniform) and can be flipped. The UI is a fixed left-side control panel built with React and Tailwind CSS v4, using a gold-tinted glass-morphism theme.

For what's already shipped vs. planned next, see [docs/ROADMAP.md](docs/ROADMAP.md) (also summarised in [README.md#roadmap](README.md#roadmap)).

## Tech Stack

| Layer | Technology | Version |
|---|---|---|
| Bundler | Vite | ^7.0.0 |
| UI | React + TypeScript | 19, ~5.9 |
| Styling | Tailwind CSS v4 | ^4.2.1 |
| GPU API | WebGPU + WGSL; WebGL2 + GLSL ES 3.00 as explicit diagnostic / XR / screenshot backend | — |

## Common Commands

```bash
npm run dev       # Start Vite dev server (http://localhost:5173)
npm run build     # Type-check with tsc then build to dist/
npm run lint      # ESLint (flat config, v9+)
npm test          # Vitest unit tests (src/**/*.test.ts)
npm run test:e2e  # Playwright E2E (all projects; install browsers first)
npm run test:e2e:webgl   # Playwright chromium: explicit WebGL diagnostic backend
npm run test:e2e:webgpu  # WebGPU smoke + compare layouts (chromium-webgpu project)
npm run test:cpp  # C++ host tests (g++, no Emscripten)
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
│   ├── useChromashiftStore.ts    # Thin façade: reducer + ref-sync + composed actions (see refs/, store/)
│   ├── refs/                     # Typed ref sub-bundles (Dom, Gpu, Media, Compare, Reactive) + textureRouting
│   ├── store/                    # Ref-dependent store helpers (selectSourceIndex, angle handlers)
│   ├── appUiProps/               # Segment prop builders aligned with AppUI.types segments
│   ├── useAppUiProps.ts          # Composes appUiProps/* builders into AppUIProps
│   ├── useAppWebGPUInit.ts       # WebGPU/WebGL bootstrap, initial image list + local library merge
│   ├── useImagePlayback.ts       # Loads the current/reference texture on index change, evicts old ones
│   ├── useMediaHandlers.ts       # File/drop/upscale handlers (handleDropFiles, handleLoadFile, …)
│   ├── useAnimationLoop.ts, useAppLifecycle.ts, useClassificationMask.ts,
│   │   useTracerInspectInteraction.ts, useVideoExport.ts, usePresets.ts
├── state/                    # Reducer, slices, and (de)serialization — see `ChromashiftState`
│   ├── chromashiftReducer.ts, defaults.ts, types.ts
│   ├── actions/                  # Dispatch wrapper factories mirroring reducer slices (media, compare, reactive, …)
│   └── serializeSettings.ts, presetUrl.ts, presetLibrary.ts, presetGallery.ts  # see docs/PRESETS.md
└── engine/
    ├── shaders/              # WGSL modules assembled in TS (thin assembler)
    │   ├── index.ts          # Re-exports all shader sources (import via './shaders')
    │   ├── bandLiterals.ts   # BAND_WGSL / BAND_GLSL f32 literals from shared/band.json
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
    ├── WebGLRenderer.ts      # Re-export shim → webgl/WebGLRenderer.ts
    ├── webgl/                # WebGL2 diagnostic renderer (mirrors WebGPU pass layout)
    │   ├── WebGLRenderer.ts, WebGLLayerPass.ts, WebGLPersistencePass.ts,
    │   │   WebGLCompositorPass.ts, WebGLDebugPasses.ts, WebGLReadback.ts
    │   ├── resources.ts, programUtils.ts
    │   └── shaders/          # GLSL sources (common, layers, persistence, compositor, debug)
    ├── WebGPURenderer.ts     # 5-pass GPU renderer orchestration (delegates to the below)
    ├── WebGPUPipelines.ts, BindGroupCache.ts, PersistencePass.ts, CompositorPass.ts,
    │   TracerInspectPass.ts, GpuReadback.ts, GpuTimestampProfiler.ts  # pass/readback + WebGPU perf HUD
    ├── videoExport/          # Offline frame-by-frame WebM/MP4 export (WebCodecs + mediabunny, MediaRecorder fallback) — see docs/VIDEO_EXPORT.md
    ├── color/               # Named colour profiles — schema, validation, LUT baking
    │   ├── colorProfile.ts      # Types, built-ins (shared/colorProfiles.json), buildColorProfileLut
    │   ├── colorProfileLibrary.ts  # localStorage user profiles + resolution order
    │   └── ProfileLutTexture.ts    # 256×3 RGBA LUT texture bound to every layer pipeline
    ├── compute/
    │   ├── chores/              # gpu-chores facade — the shared kit boundary
    │   │   ├── types.ts             # Kit API shapes (ChoreJob/ChoreResult/backend order)
    │   │   ├── runtime.ts           # runJob() — walks webgpu → wasm → ts
    │   │   ├── webgpuBackend.ts     # WebGPU compute lane (adopts renderer device)
    │   │   ├── cpuBackend.ts        # WASM + TypeScript lanes (injected host)
    │   │   ├── kernels.ts           # Shared WGSL threshold helpers (C++ parity)
    │   │   ├── support.ts           # Feature detection, kill switch, breadcrumbs
    │   │   ├── chromashiftHost.ts   # Binds the CPU lanes to WasmEngine (app-specific)
    │   │   └── index.ts             # Public entry — sibling apps import from here
    │   ├── GpuImageAnalysis.ts   # Thin adapter over the chores WebGPU lane
    │   ├── computeSupport.ts     # Re-export shim → chores/support
    │   └── wgslSnippets.ts       # Re-export shim → chores/kernels
    └── math/                 # Pure TS (bandClassification, rotation, decay) shared with tests/C++ parity
```

**Store layout:** `useChromashiftStore` is a thin composer — refs live in `hooks/refs/` (Dom, Gpu, Media, Compare, Reactive sub-bundles), dispatch wrappers in `state/actions/` (one module per reducer slice), and ref-dependent callbacks in `hooks/store/`. New compare or reactive setters belong in `state/actions/compareActions.ts` or `state/actions/reactiveActions.ts`, not inline in the store hook. `useAppUiProps` composes segment builders from `hooks/appUiProps/` that align with the `AppUI.types` prop segments.

### Renderer Selection / WebGL2 Diagnostic Backend

> **Automatic `WebGPU → WebGL` fallback is off.** A failed adapter/device init
> **hard-fails** with a blocking probe screen; `window.usingWebGL` stays false
> on that path. WebGL2 starts only when the user (or E2E) asks for it —
> `?renderer=webgl`, `?webgl`, the NUNIF **Renderer** control, or a stored
> `chromashift.renderer = webgl` preference. Explicit WebGL bootstrap does
> **not** request a WebGPU adapter/device first. See
> **[docs/webgl-fallback.md](docs/webgl-fallback.md)**.

`WEBGL_BACKEND_ENABLED` in `src/engine/rendererMode.ts` is the selection kill
switch (`true` = explicit WebGL allowed). It does not enable automatic fallback.
`RendererOrchestrator.bootstrap()` never catches a WebGPU failure to retry on
WebGL.

```bash
npm run dev
http://localhost:5173/?renderer=webgpu   # default
http://localhost:5173/?renderer=webgl    # diagnostic / XR / Playwright
```

**Boot probe**: `probeWebGPU()` (`src/engine/webgpuProbe.ts`) pre-flights the
WebGPU path only: secure context → `navigator.gpu` → `requestAdapter`, publishing
`window.webgpuProbe` `{ ok, browser, stage, reason, adapter, features, limits }`.
It stops before `requestDevice()` and shares the page-lifetime adapter cache
with bootstrap. One `GPUDevice` per page: `requestDevice` walks at most three
strategies (`default-limits` → `canvas-limits` → `no-optional-features`), then
stops. `E_OUTOFMEMORY` sets a fatal circuit breaker — no further
`requestDevice` until reload. Resize reconfigures the existing device; it
must not boot again. See [docs/gpu-bootstrap.md](docs/gpu-bootstrap.md) and
issues #157 / #158. The GPU error overlay may offer **Open WebGL
diagnostic session**, which navigates to `?renderer=webgl` rather than switching
in place.

The NUNIF panel exposes a **Renderer** control that persists `chromashift.renderer`
in localStorage and reloads with the selected `?renderer=` parameter. Tooltip:
diagnostic / XR, not fallback. Runtime breadcrumbs: `window.rendererType`,
`window.usingWebGPU`, `window.usingWebGL`, and `window.rendererFallbackReason`.

WebGL mode consumes the same `RendererState` as WebGPU: image selection, layer angles, flips, average luminance, colour mode, Sobel/soft band toggles, layer opacity, blend modes, output mode, diagnostics, and tracer settings. It is an approximate reference renderer, not a replacement for the full WGSL path. Keep WebGPU as the source of truth for production behaviour.

WebGL-only debug helpers are in the Renderer panel:
- `Composite parity` — normal diagnostic compositing.
- `Luminance mask` — grayscale BT.709 luminance after shared rotation.
- `Rotation UV grid` — transformed UVs and a grid to debug layer rotation/flips.
- `Layer mask isolation` — shows active per-layer mask output before final compositing.

For shader-based effect work, prototype/inspect in `src/engine/webgl/` when browser automation needs visible pixels, then port the final logic into `src/engine/shaders/` / `WebGPUPipelines.ts`. Band thresholds must come from the canonical `BAND` table in `src/engine/math/bandClassification.ts` (via `BAND_WGSL` / `BAND_GLSL` in `bandLiterals.ts`) — never hardcode them in WGSL or GLSL; `src/engine/shaders/bandTable.test.ts` guards TS/WGSL/GLSL/C++ against divergence. Keep thresholds, uniforms, and state fields aligned between both renderers when the effect is meant to be shared.

### Rendering Pipeline (Detailed)

1. `TextureManager.fetchImageList('/images.json')` loads the image list on startup.
2. `TextureManager.loadTexture(url)` converts each image to a `GPUTexture` (`rgba8unorm-srgb`) via `copyExternalImageToTexture`; `WebGLTextureManager.loadTexture(url)` uploads the same decoded image to a WebGL texture.
3. `WebGPURenderer` creates:
   - 3 independent `GPURenderPipeline`s for the colour layers (each can use 4× MSAA).
   - 1 persistence pipeline that reads the 3 layer textures + previous tracer texture.
   - 1 compositor pipeline that blends tracers + live layers and writes to the swap-chain.
4. Each frame, `renderer.render(state)` receives the shared `RendererState`. WebGPU encodes all passes into a single command buffer; WebGL runs equivalent GLSL/FBO passes for debugging/reference output.

### Named Colour Profiles

The colour separation is a selectable **profile**, not a single hard-coded look — see
[docs/COLOR_PROFILES.md](docs/COLOR_PROFILES.md). Built-ins live in
`shared/colorProfiles.json` (`cr0p-classic`, `cr0p-soft-gradient`, `diagnostic-grey`);
user profiles are imported as JSON into localStorage (`chromashift.colorProfiles`).
State: `layers.colorProfileId` + optional embedded `layers.colorProfile`; UI: the
**Colour profile** control in the Layers panel.

Rendering is **hybrid**: `cr0p-classic` keeps the existing branchy WGSL/GLSL band
branches, so the default look is unchanged; every other profile is baked into a 256×3
RGBA8 LUT (column = preprocessed luminance, row = layer) sampled with
`textureLoad(profileLut, …)` (WebGPU binding 5) / `texelFetch(u_profileLut, …)` (WebGL).
`buildRendererState` resolves the profile and memoizes the LUT per profile + average
luminance, so renderers re-upload only when it actually changes. While a non-classic
profile is active the `r8uint` classification mask is bypassed — it encodes classic band
indices only. Band bounds for `cr0p-classic` must stay in sync with `shared/band.json`
(guarded by `src/engine/color/colorProfile.test.ts`).

### Presets & Shareable URLs

Render settings serialize to a versioned JSON document (`src/state/serializeSettings.ts`, `version: 4`). `src/state/presetUrl.ts` encodes it as a base64url `?preset=` parameter applied inside the store's lazy initializer — before the first frame. The Presets panel (`PresetsPanel.tsx` + `usePresets.ts`) offers a built-in gallery (`presetGallery.ts`), named localStorage presets (`presetLibrary.ts`), share-URL copy, and JSON file export/import. Invalid presets fall back to defaults with `ui.presetLoadError` set. Schema v3 adds `layers.colorProfileId` (+ an embedded table in file exports only — share URLs carry the id alone); v4 adds `viewport.colorSpace` (`srgb` / `display-p3`). v1/v2 documents migrate to the classic profile and sRGB canvas. See `docs/PRESETS.md`.

### Kiosk / gallery installation

`?kiosk=1` enables installation mode (see `docs/KIOSK.md`): hides NUNIF chrome, forces autoplay + attract parameter drift, large bottom remote, fullscreen + wake lock (`useKioskMode.ts`), and **Esc** to restore panels. Breadcrumb: `window.kioskMode`. WebXR Phase-0 spike (`docs/WebXR.md`): `window.xrAvailable`, immersive VR via WebGL bridge — mutually exclusive with kiosk.

### Compare / multi-view

Dual 2-up, swipe split, and quad analytical grid are shipped on WebGPU (see [docs/COMPARE_VIEWS.md](docs/COMPARE_VIEWS.md)). Shared types/helpers: `src/engine/compareViews.ts` (`CompareLayoutMode`, `QUAD_VIEW_CELLS`, `effectiveLayerScaleForMultiView`, `multiViewPerformanceNote`). The WebGL diagnostic backend supports single-view only.

### Local Image Library (drag-and-drop)

Dropping image files (or whole folders) anywhere on `#chromashift-container` persists them to IndexedDB (`src/engine/LocalLibrary.ts`, db `chromashift-library`) — labels, dimensions, and a small WebP thumbnail alongside the original bytes — so the personal library survives page reloads without any server upload. `src/engine/fileDrop.ts` flattens a drop's `DataTransfer` (including nested folders, via `webkitGetAsEntry`) into a plain `File[]`; `useMediaHandlers.handleDropFiles` writes them to IndexedDB and appends `ImageEntry`s carrying a `localId` and a `blob:` URL — the corpus, image strip, and texture pipeline don't otherwise distinguish local from remote entries.

`ImageStrip` shows a LOCAL/REMOTE badge per entry (using `thumbUrl`, not the full-res `url`, to avoid decoding full images just for a 144px thumbnail) and a "Clear Library" button that wipes IndexedDB and drops every `localId`-tagged entry from the corpus.

Because local entries are ordinary `blob:` URLs, `TextureManager`/`WebGLTextureManager` need no special-casing to decode them (no CORS, unlike some remote hosts). `evictExcept(keepUrls)` runs after each texture swap in `useImagePlayback` (and `handleLoadSpecificImage`): local `blob:` textures outside the keep set are destroyed immediately so switching away frees GPU memory and switching back re-decodes from the resident IndexedDB blob on demand. Remote `http(s)` and other cached keys follow LRU eviction against an estimated mip-chain byte budget (256 MB default) and a hard entry cap (12 default); the keep set is the current source URL plus the reference image URL. Compare layouts share one decoded texture per URL via the orchestrator's single texture manager. Breadcrumbs: `window.textureCacheSize` and `window.textureCacheBytes`.

### Live Source (camera / screen share / video file)

A webcam feed, shared screen, or looping local video file can drive the main composite in
place of a still image — same rotating layers, tracers, and audio-reactive/MIDI modulation.
`LiveSourceManager` (`src/engine/LiveSource.ts`) owns one `HTMLVideoElement` fed by a
`MediaStream` or file; `TextureManager`/`WebGLTextureManager.updateVideoTexture()` re-upload
the current frame into a texture reused across calls (recreated only on resolution change, no
mip chain) so memory stays stable over long sessions. `useLiveSource` (`src/hooks/useLiveSource.ts`)
runs its own `requestAnimationFrame` loop (mirroring `useReactiveInput`'s pattern) for per-frame
upload and once-a-second luminance resampling, and publishes `window.liveSourceActive` /
`window.liveSourceKind` / `window.liveSourceFps` breadcrumbs. `media.liveSource` is
runtime-only state — never serialized into presets, so a shared preset URL never silently
requests camera/screen access. See [LIVE_SOURCE.md](docs/LIVE_SOURCE.md).

### Upscaler (lazy-loaded)

`Upscaler` (`src/engine/Upscaler.ts`) wraps two Web Workers, both created lazily via `new Worker(new URL('./*.worker.ts', import.meta.url), { type: 'module' })` inside the "Upscale Source" / "Upscale Output" click handlers (`src/hooks/useMediaHandlers.ts`). Vite emits each worker as its own chunk, so neither TF.js nor onnxruntime-web is fetched on initial page load — only after the user actually invokes an upscale. `npm run build` runs `check:dist`, which asserts `dist/` contains no `ort-wasm*.wasm` and that `dist/assets/index-*.js` has no `tfjs`/`ort-wasm` references.

- **`upscaler.worker.ts`** — TF.js Real-ESRGAN / Real-CUGAN. Model weights are **not** bundled or CDN-hosted by default; set `VITE_UPSCALER_BASE` to a URL you self-host (containing `realesrgan/` and `realcugan/` model trees) or upscaling throws.
- **`nunif.worker.ts`** — onnxruntime-web swin_unet (waifu2x). Model ONNX files default to `NUNIF_DEFAULT_BASE` in `Upscaler.ts`; override with `VITE_NUNIF_BASE` to self-host `models/swin_unet/` and `models/utils/`. The ORT wasm runtime is **not** bundled in `dist/` — Vite resolves `onnxruntime-web-use-extern-wasm` (see `vite.config.ts`) and the worker loads `ort-wasm-simd-threaded.{mjs,wasm}` at runtime from `VITE_NUNIF_ORT_WASM_BASE` (default `https://test.1ink.us/nunif/ort`). Mirror those two files from `node_modules/onnxruntime-web/dist/` on the server once per ORT version upgrade; for local dev without the mirror, point `VITE_NUNIF_ORT_WASM_BASE` at jsDelivr in `.env.local`.

Both workers cache downloaded models (`upscaler.worker.ts` in IndexedDB, browser HTTP cache for `nunif.worker.ts`) and post a `"Downloading model…"` progress message only on an actual first-time fetch, not on cache hits.

### Viewport Modes

`src/engine/viewModes.ts` defines `MAIN_VIEW_MODES` (composite, full-res tracer, source/reference/previous image, individual layers, coincidence heatmap, compare split-views, stamp diagnostics). The Viewport panel (`ViewportPanel.tsx`) additionally offers two mutually-exclusive display transforms layered on top of the composite view:

- **Quarter Zoom** (`viewportQuarterZoom`) — crops and scales the main canvas to just its bottom-left quarter, for inspecting fine detail at effectively higher resolution.
- **Half Overlay** (`viewportHalfOverlay`) — overlays the canvas's top and bottom halves on top of each other.

Both are disabled while viewing the full-res tracer or any non-composite view mode.

### Preview strip & view hierarchy

The floating **Original / Separated / Tracer** thumbnails (`PreviewStrip.tsx`) are
**stationary reference frames** at panel preset angles (`layers.angles`). Only the
**main viewport canvas** (`mainCanvasRef`) animates layer rotation.

| Preview | Objective | Implementation |
|---------|-----------|----------------|
| **Original** | Raw decoded source | 2D `drawImage` (`previewOriginalRef`) |
| **Separated** | Colour-band mapping, no tracers | `StationaryPreviewRenderer` / `useStationaryPreviews` |
| **Tracer** | Coincidence map at preset angles | Isolated persistence warmup + tracers pass (`previewTracerRef`) |
| **Main canvas** | Live rotating composite + tracers | `mainCanvasRef` swapchain render |

Full spec: **[docs/PREVIEW_VIEWS.md](docs/PREVIEW_VIEWS.md)**. Compare layouts:
**[docs/COMPARE_VIEWS.md](docs/COMPARE_VIEWS.md)**.

### Video Export

`src/engine/videoExport/` renders offline frames (independent of the live canvas/animation loop) to produce a WebM or MP4 export at a configurable duration, FPS, resolution scale, and pass mode (composite/tracers/layers). Prefers WebCodecs + mediabunny when available; falls back to MediaRecorder. Driven by `useVideoExport.ts` + `ExportPanel.tsx`. See `docs/VIDEO_EXPORT.md`.

### GPU Image Analysis (Compute)

Optional WebGPU compute shaders accelerate load-time analysis for large (4K–8K) images. The kernels and device plumbing live behind the **`gpu-chores`** facade (`src/engine/compute/chores/`); Chromashift is its reference consumer, and sibling apps (`clip_stacker`, `image_video_effects`, `flac_player`, `mod-player`, `web_sequencer`) depend on the same shapes. `GpuImageAnalysis.ts` is now a thin adapter over the facade's WebGPU lane:

1. **Histogram pass** — BT.709 luminance per pixel → 256-bin atomic histogram on GPU; average luminance derived from the histogram (256-entry readback only).
2. **Classification pass** — writes an `r8uint` band-index mask texture (thresholds in `wgslSnippets.ts`, matching `chromashift_engine.cpp` / `bandClassification.ts`).
3. **Layer binding** — mask is fed into existing layer pipelines via `setClassificationMaskTexture()` when `colorMode === 0` (Original CR0P fixed).

**Selection order** — encoded once in `CHORE_BACKEND_ORDER` and walked by `runJob({ op: 'image-analysis', prefer: 'auto' })`; `useClassificationMask.ts` calls the facade rather than branching itself:

1. **WebGPU compute** — primary. Requires `renderer.backend === 'webgpu'` and a GPU-resident source texture.
2. **WASM** `computeClassificationMask` — default fallback (CI / headless / flaky Edge or Chrome). Declines unless Engine mode = WASM *and* the module is loaded.
3. **TypeScript** `classifyImageMaskWith` — terminal fallback.

**WebGL2 is deliberately not a lane.** Histogram atomics have no workable GL2 story, and running a compute device *and* a GL context for one analysis is the failure mode the kit exists to prevent. On a WebGL backend no `webgpu` lane is registered at all, so the fallthrough to WASM/TS is structural rather than a runtime check.

A pinned `prefer` (`'webgpu' | 'wasm' | 'ts'`) never slides to another lane — parity tests depend on that. Failures are never silent: `runJob` returns `{ ok: false, reason, attempts }` recording why every candidate declined or threw.

**Device policy**: the WebGPU lane **adopts** the renderer-owned `GPUDevice` from `RendererOrchestrator`. It must never call `requestAdapter`/`requestDevice`. `useClassificationMask` registers the orchestrator's existing lane instance (`GpuImageAnalysis.backend`) rather than constructing a second one, so pipelines, staging buffers, and the reused mask texture stay shared — repeated image loads do not grow VRAM.

**CPU contract**: 256-bin histogram readback only. The mask stays a `GPUTexture` on the GPU lane; never add a full-image readback. The CPU lanes return a `Uint8Array` that the caller uploads into an `r8uint` texture.

**Feature detection**: `detectGpuComputeSupport(device)` gates on adapter `maxTextureDimension2D`.

**Kill switch**: `?no_gpu_compute` closes the WebGPU lane and reports itself as the reason (rather than masquerading as a capability problem). WebGL mode skips compute entirely.

**Breadcrumbs** (Chrome-vs-Edge diagnosis): `window.gpuComputeAvailable`, `window.gpuComputeReason`, `window.gpuComputeDiagnostics` (adapter vendor/architecture/device/description, `features`, and compute `limits`), plus `window.gpuChoreBackend` / `window.gpuChoreReason` recording which lane served the last job and why the others did not.

**Parity tests**: `src/engine/compute/chores/runtime.test.ts` covers the fallback order, pinned-lane behaviour, and the no-silent-skip contract; `src/engine/compute/chores/support.test.ts` covers detection, the kill switch, and breadcrumbs. `src/engine/compute/goldenMask.test.ts` checks the TS fallback against an f32-accurate port of C++ `computeClassificationMask` on a golden image (exact match, several avgLum values), asserts the WGSL `classify_band()` chain is generated from `BAND_THRESHOLDS`, and bounds the histogram-derived average within one bucket of the exact BT.709 average. `BAND_THRESHOLDS` in `src/engine/math/bandClassification.ts` is the single source of truth for band thresholds — the WGSL threshold chain is generated from it.

### WebGPU MSAA

When `enableMSAA` is true (`sampleCount = 4`):

- Layer pipelines render into a shared `msaaTexture` (4×) and **resolve** into `layerTextures` (always `sampleCount: 1`) so persistence and compositor passes can sample them as ordinary 1× textures.
- The compositor pass writes directly to the swap-chain at 1× (no MSAA resolve on the canvas).
- `setAntialiasing()` recreates pipelines and destroys `msaaTexture`; `ensureLayerTextures()` recreates it when the canvas size changes.

MSAA pipelines must match the render-pass attachment `sampleCount`. A 4× pipeline cannot target a 1× texture without a `resolveTarget`.

### GPU Performance Instrumentation (WebGPU only)

Per-pass GPU timing uses the optional `timestamp-query` feature. At bootstrap, Chromashift requests every adapter-supported entry in `CHROMASHIFT_OPTIONAL_FEATURES` (`gpuOptions.ts`): `timestamp-query` and `rg11b10ufloat-renderable`. Missing features skip the corresponding path (CPU-only HUD, rgba8 internal targets). Breadcrumbs: `window.gpuTimestampAvailable`, `window.gpuTimestampReason`.

`GpuTimestampProfiler` (`src/engine/GpuTimestampProfiler.ts`) wraps the live render path in `WebGPURenderer`:

1. **Layers** — three colour-band passes (MSAA resolve when enabled).
2. **Persistence** — dual tracer ping-pong + diagnostic texture.
3. **Compositor** — final blend or alternate main-view pass (tracer inspect, layer isolation, etc.).
4. **Readback** — preview thumbnail + collision-stats blit/copy when queued.

Timestamps resolve into a `QUERY_RESOLVE | COPY_SRC` buffer, then `copyBufferToBuffer` into a `MAP_READ | COPY_DST` readback (`MAP_READ` may only pair with `COPY_DST`). Results appear one frame later. If query/buffer allocation fails or the timestamp period is 0, GPU timing is skipped and the HUD uses CPU `performance.now()` — renderer init must not fail. The Diagnostics panel **Perf HUD** toggle (`output.performanceHudEnabled`) gates all query writes and resolves — when off, there is zero timestamp cost. The HUD shows CPU ms, per-pass GPU ms, an approximate bandwidth model, a 120-frame sparkline, budget warnings (`1000 / fps` ms), and optional auto-degrade (disable MSAA, tracer scale ×0.75, live preview readback off).

WebGL2 reports CPU timing only (`GPU timing N/A` in the HUD). See `docs/webgl-fallback.md`.

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

- Default layer spin rates: `[130, 230, 330]` (normalized degrees; wall-clock °/s = value × 30). FPS only changes sampling density — not angular speed.
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

Chromashift has three test tiers. CI runs all of them on every push/PR (see `.github/workflows/ci.yml`).

| Tier | Command | Scope |
|------|---------|-------|
| **Vitest** | `npm test` | Unit tests in `src/**/*.test.ts` — math (`decay`, `rotation`, `bandClassification`), state (`serializeSettings`, `presetUrl`), engine (`blendModes`, `gpuBootstrap`, `goldenMask`, `kioskMode`, `compareViews`, `GpuTimestampProfiler`, `colorProfile`, `colorProfileLibrary`, `buildRendererState`, video export, reactive modulation) |
| **Playwright** | `npm run test:e2e` | E2E specs under `e2e/`. **`chromium` project** (`npm run test:e2e:webgl`): WebGL smoke (`smoke.spec.ts`), preset URL hydration (`preset-url.spec.ts`), kiosk (`kiosk.spec.ts`), viewport transforms (`viewport-transforms.spec.ts`), colour profiles (`color-profiles.spec.ts`), WebGPU hard-fail policy (`webgpu-hard-fail.spec.ts`). **`chromium-webgpu` project** (`npm run test:e2e:webgpu`, `--enable-unsafe-webgpu`): WebGPU smoke (`webgpu-smoke.spec.ts`), compare dual/swipe/quad (`compare-*.spec.ts`), v2 compare preset URL (`preset-compare.spec.ts`). Opt-in screenshot specs: `opacity-test.spec.ts`, `renderer-parity.spec.ts` (`RECORD_SCREENSHOTS=1`). Install browsers once: `npx playwright install --with-deps chromium` |
| **C++ host** | `npm run test:cpp` | `cpp/tests/` via `g++` — band/decay parity with `chromashift_engine.cpp`; no Emscripten required |

### CI job matrix

| Job | What it runs |
|-----|----------------|
| `guard` | Blocks `dist/` and accidental secrets in PR diffs |
| `web` | `npm run lint`, `npx tsc -b`, `npm run build` |
| `unit` | `npm test` (Vitest) |
| `e2e` | `npx playwright test --project=chromium` (WebGL smoke, preset URL, kiosk) |
| `e2e-webgpu` | `npx playwright test --project=chromium-webgpu` (`--enable-unsafe-webgpu`) |
| `wasm` | `npm run test:cpp` + `npm run build:wasm` + artifact check |

WebGPU E2E runs in the `chromium-webgpu` Playwright project with
`--enable-unsafe-webgpu` (see `playwright.config.ts`). For local WebGPU validation,
use Chrome with `?renderer=webgpu`. The WebGL project is the named diagnostic
lane (`?renderer=webgl`) when WebGPU is unavailable in a headless environment.

## Deployment Process

A Python script (`deploy.py` at repo root) handles deployment:

```bash
npm run build
pip install -r requirements-deploy.txt
export DEPLOY_USER=… DEPLOY_KEY=~/.ssh/id_ed25519   # or DEPLOY_PASS for password fallback
python deploy.py              # clean remote + upload (default)
python deploy.py --dry-run    # preview deletions/uploads only
python deploy.py --no-clean   # skip remote wipe
```

- It uses **Paramiko/SFTP** to recursively upload the `dist/` directory.
- Target server: `1ink.us` (port 22) — override with `DEPLOY_HOST` / `DEPLOY_PORT`.
- Remote path: `test.1ink.us/chromashift` — override with `DEPLOY_REMOTE_DIR`.
- **Auth**: SSH key via `DEPLOY_KEY` or `SSH_AUTH_SOCK` (preferred); `DEPLOY_PASS` password fallback.
- **Safety**: refuses `CHANGEME` / missing credentials; `--dry-run` lists changes without mutating remote;
  default cleans remote before upload (`--no-clean` to skip).
- **CI**: manual [Deploy workflow](.github/workflows/deploy.yml) (`workflow_dispatch`) with
  `DEPLOY_USER` + `DEPLOY_KEY` GitHub secrets.

## Browser Requirements

Chromashift layers four independent capability checks:

| Capability | Role | Requirement | If unavailable |
|---|---|---|---|
| **WebGPU** | Primary renderer (5-pass pipeline, GPU compute analysis) | Chrome 113+ / Edge 113+ / Chrome Canary | Blocking probe screen; optional **new** `?renderer=webgl` diagnostic session |
| **WebGL2** | Diagnostic / XR / Playwright screenshots, shader-porting | Any browser with WebGL2 (Firefox, Safari included) | XR and WebGL E2E cannot run |
| **WASM SIMD128** | Accelerated CPU luminance/classification (`cpp/chromashift_engine.cpp`) | Chrome/Edge/Firefox with WASM SIMD; requires `npm run build:wasm` (Emscripten) | Silently uses the TypeScript engine (`WasmEngine.ts`) — same public API either way |
| **ORT (onnxruntime-web)** | Optional waifu2x upscaling (`nunif.worker.ts`) | Any WebGPU/WebGL2 browser; loaded lazily only when "Upscale" is clicked | Real-ESRGAN/Real-CUGAN via TF.js (`upscaler.worker.ts`) covers the other upscale path |

Firefox and Safari do not yet have stable WebGPU support — use `?renderer=webgl` there for diagnostics, not as a silent production fallback.

See `docs/gpu-bootstrap.md` (WebGPU/WebGL matrix), `docs/wasm-engine.md` (SIMD build/browser
support), and the Upscaler section above (ORT vs TF.js) for the full detail behind this table.

## Cursor Cloud specific instructions

Frontend-only project — no backend/database/services to run. Standard commands are in
"Common Commands" above (`npm run dev`, `npm run build`, `npm run lint`, `npm test`).

- **No WebGPU in the cloud VM.** The headless Chrome available here does not expose
  WebGPU, so `http://localhost:5173/` shows the **blocking** "WebGPU is required and
  failed to initialize" screen with the probe stage and adapter detail. This is expected —
  WebGPU behaviour cannot be validated here. Automatic WebGL fallback stays off (see
  `docs/webgl-fallback.md`). Use `http://localhost:5173/?renderer=webgl` for a diagnostic
  session. Read `window.webgpuProbe` in the console to confirm the failure stage.
  Playwright's `chromium` project is first-class (`npm run test:e2e:webgl`) and must
  **not** skip. The `chromium-webgpu` project (`--enable-unsafe-webgpu`) may still fail
  in this VM.
- **Playwright browsers must be installed once per fresh VM** before `npm run test:e2e`:
  `npx playwright install --with-deps chromium`. This is intentionally not in the update
  script (heavy, network-dependent). The `opacity-test.spec.ts` spec is skipped by default.
- **Remote images:** `public/images.json` points at `https://cr0p.1ink.us/...`; loading the
  displayed corpus requires outbound network access to that host. Drag-and-drop local images
  work offline.
- **WASM engine is optional:** `npm run build:wasm` needs Emscripten (not installed by
  default). Without it the TypeScript engine is used automatically — no action needed for
  normal dev/test/build.
