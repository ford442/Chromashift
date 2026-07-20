# Chromashift — Agent Handoff

## Project
Chromashift is a WebGPU-based 5-pass colour-separation slideshow engine at `/root/chromashift`. Stack: React 19 + TypeScript + Tailwind CSS v4 + WGSL (WebGPU).

## View hierarchy (canonical)

See **[docs/PREVIEW_VIEWS.md](../docs/PREVIEW_VIEWS.md)**.

- **Main canvas** (`mainCanvasRef`) — the only view that rotates/flips layers live.
- **Preview strip** — stationary at preset angles (`useStationaryPreviews.ts`):
  - **Original** — raw source (`previewOriginalRef`)
  - **Separated** — `StationaryPreviewRenderer` layers pass
  - **Tracer** — isolated persistence warmup + tracers pass (`previewTracerRef`)

## Key Context
- **5-pass pipeline:** 3 colour layers → persistence ping-pong (Above/Below) → compositor.
- **Default rotation speeds:** `[-130, 230, 330]` deg/frame at 30 FPS (main canvas only).
- **Conventions:** See `AGENTS.md` for coding style, architecture, and build commands.

## Continuing Work
Compare swipe/quad layouts per `docs/COMPARE_VIEWS.md`. Run `npm run build` and `npm test` after changes.
