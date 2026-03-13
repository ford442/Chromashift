# Chromashift

A WebGPU-based visual engine that performs real-time RGB colour separation and independent layer rotation — replacing a legacy Canvas 2D / Emscripten slideshow.

## Features

- **3-layer WebGPU rendering pipeline** — Red/Orange, Violet/Blue, Green/Yellow colour bands, each composited with alpha blending on the GPU.
- **GPU-only colour separation** — luminance-based colour masking is computed entirely in WGSL fragment shaders; zero CPU-side pixel manipulation.
- **Independent layer rotation** — each layer has its own rotation angle and rate, driven by a `mat3x3` rotation matrix uploaded as a vertex-shader uniform.
- **TextureManager** — fetches image URLs from a JSON endpoint (simulating the PHP backend) and uploads decoded images directly to GPU textures via `copyExternalImageToTexture`.
- **NUNIF control overlay** — minimal Tailwind CSS UI for adjusting per-layer rotation angle, rotation rate, global frame rate, and average luminance.

## Tech Stack

| Layer | Technology |
|---|---|
| Bundler | [Vite](https://vite.dev/) |
| UI framework | [React 19](https://react.dev/) + [TypeScript](https://www.typescriptlang.org/) |
| Styling | [Tailwind CSS v4](https://tailwindcss.com/) |
| GPU | [WebGPU](https://gpuweb.github.io/gpuweb/) (WGSL shaders) |

## Requirements

- A browser with WebGPU support: **Chrome 113+**, **Edge 113+**, or Chrome Canary.
- Node.js 18+

## Getting Started

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

## Build

```bash
npm run build
npm run preview
```

## Image Data Endpoint

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
    TextureManager.ts   # JSON fetch + GPU texture upload
    shaders.ts          # WGSL vertex + 3 fragment shaders
  components/
    NunifOverlay.tsx    # Tailwind CSS control panel
  App.tsx               # React root, WebGPU init, animation loop
```
