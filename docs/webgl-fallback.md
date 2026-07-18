# WebGL2 Fallback Renderer

Chromashift's production renderer is still WebGPU/WGSL. The WebGL2 backend exists as an opt-in reference path for visual debugging, Playwright screenshots, and safer iteration on shader effects when WebGPU output is hard to inspect.

## Selecting A Renderer

Use URL flags:

```text
?renderer=webgpu
?renderer=webgl
?webgpu
?webgl
```

The NUNIF panel also exposes a **Renderer** control. It persists the selected backend in `localStorage.chromashift.renderer` and reloads with the matching `?renderer=` parameter.

Automation can read:

```js
window.rendererType
window.usingWebGPU
window.usingWebGL
window.rendererFallbackReason
```

If the default WebGPU initialization fails, the app tries WebGL2 and records the failure message in `window.rendererFallbackReason`.

## Shared State Contract

Both renderers consume the same `RendererState` from `App.tsx`:

- Source image texture.
- Layer angles and flips.
- `avgLuminance`.
- Colour mode, Sobel edge boost, and soft CROP toggle.
- Global and per-layer opacity.
- Layer and tracer blend modes.
- Output/main-view mode.
- Diagnostics opacity, stamp boost, peak-collision mode.
- Dual tracer duration/intensity values.

Keep new shared visual controls in `RendererState` first, then implement them in both `WebGPURenderer.ts` and `src/engine/webgl/` as needed.

## WebGL Debug Modes

The WebGL-only debug selector in the Renderer panel supports:

- `Composite parity`: normal three-layer separation, simplified tracer persistence, and compositor output.
- `Luminance mask`: grayscale BT.709 luminance after layer UV rotation and optional Sobel boost.
- `Rotation UV grid`: transformed UV coordinates plus grid lines for debugging angle, flip, and aspect correction.
- `Layer mask isolation`: active colour-band masks before final compositing.

These modes are intended for fast browser-visible checks. The WebGPU renderer ignores `webglDebugMode`. Debug shaders live in `src/engine/webgl/shaders/debug.ts`; `WebGLDebugPasses` owns the three debug programs.

## GPU Performance HUD (WebGPU only)

Per-pass GPU frame timing (`layers`, `persistence`, `compositor`, `readback`) is available on the WebGPU path when the adapter grants `timestamp-query`. Enable **Perf HUD** in the Diagnostics panel. The WebGL2 fallback keeps CPU-only timing and shows **GPU timing N/A**.

Automation breadcrumbs (WebGPU bootstrap):

```js
window.gpuTimestampAvailable
window.gpuTimestampReason
```

When the HUD is disabled, Chromashift does not write or resolve timestamp queries.

## Porting GLSL Effects To WGSL

Use this workflow for shader-based image effects:

1. Prototype in `src/engine/webgl/` (GLSL in `webgl/shaders/`, pass logic in `WebGLLayerPass`, `WebGLCompositorPass`, etc.) when Playwright or manual screenshots need visible pixels.
2. Keep uniform names and state fields close to the WebGPU equivalents.
3. Port final logic to `src/engine/shaders/` and, when needed, `src/engine/WebGPUPipelines.ts`.
4. Verify `npm run build` and `npm run lint`.
5. Smoke both `?renderer=webgl` and `?renderer=webgpu` when the environment supports WebGPU.

Important differences:

- WebGPU textures use `rgba8unorm-srgb` source uploads; the WebGL fallback uses standard WebGL texture uploads and is visually approximate.
- WebGPU keeps the full dual-ping-pong tracer and diagnostic texture path; WebGL implements a simpler FBO-based tracer suitable for reference/debug work.
- WebGPU remains the source of truth for deployment-quality output.
- The dual (2-up) compare view (docs/COMPARE_VIEWS.md Phase 1) is WebGPU-only: it requires a second renderer sharing one `GPUDevice`, which the WebGL path does not support. The Dual toggle is disabled on the WebGL backend.
