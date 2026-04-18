# Chromashift — Agent Handoff

## Project
Chromashift is a WebGPU-based 5-pass colour-separation slideshow engine at `/root/chromashift`. Stack: React 19 + TypeScript + Tailwind CSS v4 + WGSL (WebGPU).

## Recent Changes (just applied)
1. **Chrome sub-pixel blur fix** — `src/App.tsx` now enforces `Math.floor()` on all CSS canvas boundaries (`width`, `height`, `left`, `top`) and internal resolution (`canvas.width`, `canvas.height`). The canvas also respects the loaded image's native aspect ratio when "Square Canvas" is off.
2. **Tracer uniform buffer alignment fix** — `src/engine/WebGPURenderer.ts` now writes the persistence-pass uniform buffer with strict `Float32Array`/`Uint32Array` alignment. The WGSL shader (`src/engine/shaders.ts`) `PersistUniforms.tracerMode` was updated from `f32` to `u32` to match.
3. **Tracer preview texture copy fix** — Fixed a bug where the tracer preview assumed square textures (`texSize` for both dimensions). Now uses proper width/height (`texW`, `texH`) for texture copy and downsampling, fixing the "copy range touches outside of texture" error for rectangular images.
4. **Square canvas now defaults to ON** — Changed `squareCanvas` state default from `false` to `true` in `src/App.tsx`.
5. **Layer opacity fix** — Layer fragment shaders now actually use `layerOpacity` uniform to modulate output alpha, fixing the issue where opacity sliders didn't work.
6. **Transparent background + tracer/layer fallback** — Changed compositor to clear to transparent (`a: 0`) instead of opaque black. Added logic so that when main layers are black/transparent, the tracer shows through, and vice versa. Final output preserves actual alpha instead of forcing to 1.0.
7. **CRITICAL FIX: Layer opacity no longer breaks tracer** — Removed alpha modulation from layer shaders. Now layers always output full alpha (for persistence detection), and opacity is only applied in the compositor. This fixes the bug where lowering layer opacity below 10% made the tracer vanish because the persistence pass couldn't detect overlapping layers.
8. **Preview sync fix** — Added `clearPersistence()` method to WebGPURenderer and call it when changing images. The tracer preview is now frozen when an image changes, then captured once after the first render along with the separated preview. This ensures Original, Separated, and Tracer previews all show the same image.
9. **Pause button + tracer persistence** — Added `paused` state to `RendererState`. When paused, the decay factor is set to 1.0 (no decay), so the tracer stays exactly as-is instead of fading out. Added Pause button to the UI (bottom-left).

## Current State
- `npm run build` ✅ clean
- `npm run lint` ✅ clean

## Key Context
- **5-pass pipeline:** 3 colour layers → persistence ping-pong (Above/Below) → compositor.
- **Default rotation speeds:** `[-130, 230, 330]` deg/frame at 30 FPS.
- **Dual tracers:** Above (500ms, 85% intensity) and Below (2000ms, 30% intensity).
- **Blend modes:** Supported independently for live layers and tracers (Alpha, Add, Subtract, Multiply, Screen, etc.).
- **Images:** Loaded from `public/images.json`, cached by URL in `TextureManager`.
- **Conventions:** See `AGENTS.md` for coding style, architecture, and build commands.

## Continuing Work
We want to keep working on this repo. Pick up from the current state. Run `npm run build` and `npm run lint` after any changes. If you're unsure about requirements, ask before making large architectural changes.
