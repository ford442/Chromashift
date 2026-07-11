# Chromashift — AI Agent Guide

## Project Overview

Chromashift is a WebGPU-based visual engine that renders images through a multi-pass colour-separation pipeline. It replaces a legacy Canvas 2D / Emscripten slideshow. The current implementation uses a **5-pass GPU pipeline**:

1. **Layer 0** — isolates high-luminance pixels and maps them to red/orange hues.
2. **Layer 1** — isolates mid-high luminance and maps them to violet/blue hues.
3. **Layer 2** — isolates mid luminance and maps them to green/yellow hues.
4. **Persistence pass** — detects spatial overlap between 2+ layers and accumulates the mixed colour into a pair of ping-pong "tracer" textures that decay over time.
5. **Compositor pass** — blends the live layers with the decaying tracer textures and draws the final result to the canvas.

Each layer has independent rotation (driven by a `mat3x3` uniform) and can be flipped. The UI is a fixed left-side control panel built with React and Tailwind CSS v4, using a gold-tinted glass-morphism theme.

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

```
src/
├── main.tsx                  # React entry point (createRoot + StrictMode)
├── App.tsx                   # Root component — renderer init, animation loop, state management,
│                             # preview canvases (Original, Separated, Tracer), image auto-play
├── index.css                 # @import "tailwindcss" + extensive gold/glass custom CSS
├── components/
│   └── NunifOverlay.tsx      # Left-side control panel (angles, rates, fps, opacity, tracers,
│                             # blend modes, reset, play/pause, image interval)
└── engine/
    ├── shaders/              # WGSL modules assembled in TS (thin assembler)
    │   ├── index.ts          # Re-exports all shader sources (import via './shaders')
    │   ├── common.ts         # Vertex shaders, colour/blend helpers, BAND_WGSL
    │   │                     # (band thresholds generated from math/bandClassification.ts BAND)
    │   ├── layers.ts         # 3 layer fragment shaders (shared header/prelude)
    │   ├── persistence.ts    # Tracer persistence pass
    │   ├── compositor.ts     # Final compositor pass
    │   └── diagnostics.ts    # Tracer view, display, heatmap, diagnostic, compare passes
    ├── TextureManager.ts     # Image fetch, ImageBitmap → GPUTexture, URL cache
    ├── WebGLTextureManager.ts # Image fetch, HTMLImageElement/raw pixels → WebGLTexture
    ├── rendererMode.ts       # URL/localStorage renderer selection + runtime breadcrumbs
    ├── RendererTypes.ts      # Shared renderer/texture contracts consumed by App.tsx
    ├── WebGLRenderer.ts      # WebGL2 fallback/reference implementation with debug modes
    └── WebGPURenderer.ts     # 5-pass GPU renderer, uniform buffer management,
                              # MSAA toggle, dual ping-pong persistence buffers
    └── compute/
        ├── GpuImageAnalysis.ts   # WebGPU histogram + r8uint classification mask
        ├── computeSupport.ts     # Feature detection + window breadcrumbs
        └── wgslSnippets.ts       # Shared WGSL threshold helpers (C++ parity)
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
- **Security note**: The script currently contains a hard-coded password. Treat it as sensitive and avoid committing it to public repositories.

## Browser Requirements

WebGPU is required for the primary renderer. Supported in:
- Chrome 113+ / Edge 113+
- Chrome Canary (flags may be needed on older versions)

Firefox and Safari do not yet have stable WebGPU support.

Use `?renderer=webgl` on browsers or CI environments where WebGPU is unavailable but WebGL2 is present.
