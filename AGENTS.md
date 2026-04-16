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
| GPU API | WebGPU + WGSL | — |

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
├── App.tsx                   # Root component — WebGPU init, animation loop, state management,
│                             # preview canvases (Original, Separated, Tracer), image auto-play
├── index.css                 # @import "tailwindcss" + extensive gold/glass custom CSS
├── components/
│   └── NunifOverlay.tsx      # Left-side control panel (angles, rates, fps, opacity, tracers,
│                             # blend modes, reset, play/pause, image interval)
└── engine/
    ├── shaders.ts            # WGSL vertex + 3 fragment shaders, persistence shader,
    │                         # compositor shader, and blend-mode helpers
    ├── TextureManager.ts     # Image fetch, ImageBitmap → GPUTexture, URL cache
    └── WebGPURenderer.ts     # 5-pass GPU renderer, uniform buffer management,
                              # MSAA toggle, dual ping-pong persistence buffers
```

### Rendering Pipeline (Detailed)

1. `TextureManager.fetchImageList('/images.json')` loads the image list on startup.
2. `TextureManager.loadTexture(url)` converts each image to a `GPUTexture` (`rgba8unorm`) via `copyExternalImageToTexture`.
3. `WebGPURenderer` creates:
   - 3 independent `GPURenderPipeline`s for the colour layers (each can use 4× MSAA).
   - 1 persistence pipeline that reads the 3 layer textures + previous tracer texture.
   - 1 compositor pipeline that blends tracers + live layers and writes to the swap-chain.
4. Each frame, `renderer.render(state)` encodes all passes into a single command buffer and submits it.

### Colour Bands (WGSL Fragment Shaders)

Luminance is calculated via ITU-R BT.709: `0.2126R + 0.7152G + 0.0722B`, scaled 0–255.

| Layer | Luminance range | Output colour |
|---|---|---|
| 0 | 190–209 | Red |
| 0 | 209–229 | Orange |
| 0 | 229+ | Near-white highlight (yellow-tinted) |
| 1 | 177–190 | Violet |
| 1 | 158–177 | Blue |
| 2 | 145–158 | Green |
| 2 | 125–145 | Yellow |

The `avgLuminance` uniform (0–255, controlled by a slider) is passed to the fragment shaders but currently acts as a global parameter rather than directly modulating saturation (the shaders use fixed saturation values per band).

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

WebGPU is required. Supported in:
- Chrome 113+ / Edge 113+
- Chrome Canary (flags may be needed on older versions)

Firefox and Safari do not yet have stable WebGPU support.
