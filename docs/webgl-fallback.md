# WebGL2 Diagnostic Renderer

> [!IMPORTANT]
> WebGL2 is a **named diagnostic / XR / screenshot backend**. It is **never**
> an automatic rescue for a failed WebGPU boot. Default sessions require
> WebGPU; adapter/device failure still **hard-fails** with the probe overlay.

Issue [#133](https://github.com/ford442/Chromashift/issues/133) removed silent
`WebGPU → WebGL` fallback so Chrome-vs-Edge device bugs could not hide behind
WebGL. Issue [#141](https://github.com/ford442/Chromashift/issues/141) restores
**explicit** WebGL selection without bringing that slide back.

## Policy

| Path | Behaviour |
|------|-----------|
| Default / `?renderer=webgpu` | Probe + WebGPU bootstrap. Failure blocks with probe stage/adapter. `window.usingWebGL === false`. |
| Explicit `?renderer=webgl` / `?webgl` / Renderer panel / stored preference | Start WebGL2 **without** requesting a WebGPU adapter or device. gpu-chores has no WebGPU lane. |
| Failed WebGPU overlay | **Open WebGL diagnostic session** navigates to `?renderer=webgl` (new load). Not an in-place switch. |

`WEBGL_BACKEND_ENABLED` in `src/engine/rendererMode.ts` is the kill switch for
*selection*. While `true`, URL/panel/storage can start WebGL. While `false`,
those requests are ignored and WebGPU is required. Automatic fallback is
**never** implemented in `RendererOrchestrator.bootstrap()`: a WebGPU catch
tears down the partial boot and rethrows.

## Boot probe

`probeWebGPU()` (`src/engine/webgpuProbe.ts`) runs only on the WebGPU path,
before the orchestrator. It stops **before** `requestDevice()`. Explicit WebGL
sessions skip the probe so nothing is left for gpu-chores to adopt.

Stages: `secure-context` → `navigator-gpu` → `adapter` → `device` → `context` → `ok`.

On WebGPU failure the app shows a **blocking** error screen naming the stage,
reason, browser, and adapter.

## Breadcrumbs

```js
window.webgpuProbe        // { ok, browser, stage, reason, adapter, features, limits } (WebGPU path)
window.usingWebGPU        // true only when device + swapchain are live
window.usingWebGL         // true only after a successful explicit WebGL bootstrap
window.rendererType       // 'webgpu' | 'webgl' | null on a hard-failed boot
window.rendererFallbackReason  // hard-fail detail, or null
```

`window.usingWebGL` never becomes true on a WebGPU failure path.

## Selecting a renderer

```text
?renderer=webgpu
?renderer=webgl
?webgpu
?webgl
```

The NUNIF **Renderer** control persists `localStorage.chromashift.renderer` and
reloads with `?renderer=`. Tooltip: diagnostic / XR, not fallback.

WebXR **Enter** is available only on this explicit WebGL backend. The presenter
creates its **own** `xrCompatible` WebGL2 context via
`getWebGL2ContextAttributes({ xrCompatible: true })` and does not share a
WebGPU device. See [WebXR.md](WebXR.md).

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

Per-pass GPU frame timing (`layers`, `persistence`, `compositor`, `readback`) is available on the WebGPU path when the adapter grants `timestamp-query`. Enable **Perf HUD** in the Diagnostics panel. The WebGL2 diagnostic backend keeps CPU-only timing and shows **GPU timing N/A**.

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

- WebGPU textures use `rgba8unorm-srgb` source uploads; the WebGL path uses standard WebGL texture uploads and is visually approximate.
- WebGPU keeps the full dual-ping-pong tracer and diagnostic texture path; WebGL implements a simpler FBO-based tracer suitable for reference/debug work.
- WebGPU remains the source of truth for deployment-quality output.
- The dual (2-up) compare view (docs/COMPARE_VIEWS.md Phase 1) is WebGPU-only: it requires a second renderer sharing one `GPUDevice`, which the WebGL path does not support. The Dual toggle is disabled on the WebGL backend.
