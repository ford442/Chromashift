# Chromashift — AI Agent Guide

## Project Overview

Chromashift is a WebGPU-based visual engine that renders images through a 3-layer color-separation pipeline. Each layer isolates a different luminance band and maps it to a color group (red/orange, violet/blue, green/yellow), with independent per-layer rotation controlled via a Tailwind CSS overlay UI.

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

## Key Dependency Constraint

`@tailwindcss/vite` v4 supports **vite `^5-7` only** — do **not** upgrade vite to v8 or higher until Tailwind's Vite plugin publishes support for it. Similarly, `@vitejs/plugin-react` v5 is required for Vite 7 compatibility; v6 requires Vite 8.

## Architecture

```
src/
├── main.tsx                  # React entry point (createRoot + StrictMode)
├── App.tsx                   # Root component — WebGPU init, animation loop, state
├── index.css                 # @import "tailwindcss" only
├── components/
│   └── NunifOverlay.tsx      # Bottom control panel (layer angles, rates, fps, reset)
└── engine/
    ├── shaders.ts            # WGSL vertex + 3 fragment shaders
    ├── TextureManager.ts     # Image fetch, ImageBitmap → GPUTexture, URL cache
    └── WebGPURenderer.ts     # 3-pipeline GPU renderer, uniform buffer management
```

### Rendering Pipeline

1. `TextureManager.fetchImageList('/images.json')` loads the image list on startup.
2. `TextureManager.loadTexture(url)` converts each image to a `GPUTexture` (RGBA8 unorm).
3. `WebGPURenderer` creates 3 independent `GPURenderPipeline`s — one per color band.
4. Each frame, `renderer.render(state)` writes rotation (mat3x3) and luminance uniforms and calls `draw` on all 3 pipelines, blending results with `src-alpha / one-minus-src-alpha`.

### Color Bands (WGSL fragment shaders)

Luminance is calculated via ITU-R BT.709: `0.2126R + 0.7152G + 0.0722B`, scaled 0–255.

| Layer | Luminance range | Output color |
|---|---|---|
| 0 | 190–209 | Red |
| 0 | 209–229 | Orange |
| 0 | 229+ | Near-white highlight |
| 1 | 177–190 | Violet |
| 1 | 158–177 | Blue |
| 2 | 145–158 | Green |
| 2 | 125–145 | Yellow |

The `avgLuminance` uniform (0–255, controlled by a slider) modulates color saturation: `diff = (avg / 255.0) * 32.0`.

### Image Source

Edit `public/images.json` to change the image list:
```json
[
  { "url": "https://example.com/image.jpg", "label": "My Scene" }
]
```

The `TextureManager` fetches this file at startup and caches textures by URL.

## Browser Requirements

WebGPU is required. Supported in:
- Chrome 113+ / Edge 113+
- Chrome Canary (flags may be needed on older versions)

Firefox and Safari do not yet have stable WebGPU support.

## TypeScript Config Notes

Two project references are used:

- `tsconfig.app.json` — compiles `src/`, includes `vite/client` and `@webgpu/types`
- `tsconfig.node.json` — compiles `vite.config.ts`, includes `@types/node`

Both use strict mode. `skipLibCheck: true` avoids noise from `.d.ts` files in `node_modules`.
