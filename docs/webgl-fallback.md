# WebGL2 Fallback Renderer

> [!IMPORTANT]
> **WebGL2 fallback is DISABLED for this development phase.** WebGPU is
> required. If adapter or device init fails, Chromashift **hard-fails** with a
> blocking error screen — it does not start the WebGL renderer.
>
> Restoring the fallback is a later issue wave. Until then the code below is
> documentation of a deferred path, not current behaviour.

## Why it is disabled

Automatic `WebGPU → WebGL` fallback **hid** Chrome-vs-Edge WebGPU
disagreements. A machine where Edge failed to get a device would quietly render
through WebGL2 instead, so the bug presented as "the two browsers look
different" — a visual-parity problem — when it was really a device/init
problem. Failing loudly, with the adapter and browser named, turns that back
into a one-line diagnosis.

## Current behaviour (fallback disabled)

`WEBGL_BACKEND_ENABLED` in `src/engine/rendererMode.ts` is the single switch.
While it is `false`:

- `?renderer=webgl`, `?webgl`, and a stored `localStorage.chromashift.renderer = webgl`
  are **ignored** — `getRendererPreference()` returns `webgpu` and logs a warning.
  None of them can rescue a failed WebGPU boot.
- `switchRendererPreference('webgl')` refuses to persist, and the NUNIF
  **Renderer** panel's WebGL button is disabled with an explanatory tooltip.
- `RendererOrchestrator.bootstrap()` no longer catches a WebGPU failure to
  retry on WebGL. It tears down the partial boot and rethrows, so **no device
  survives** for gpu-chores to adopt.
- The GPU error overlay no longer offers "Switch to WebGL2".
- Playwright specs that drive `?renderer=webgl` self-skip via
  `skipWhileWebGlDisabled()` (`e2e/helpers/rendererPhase.ts`) and report as
  pending. Run them with `CHROMASHIFT_E2E_WEBGL=1` against a build with the
  flag flipped on.

Explicitly passing `backend: 'webgl'` to `RendererOrchestrator.bootstrap()`
still works — the WebGL renderer itself is untouched. Only *automatic*
fallback and *user* selection are gated.

## Boot probe

`probeWebGPU()` (`src/engine/webgpuProbe.ts`) is the single pre-flight check
`useAppWebGPUInit` runs before touching the orchestrator. It stops
**before** `requestDevice()` — the real bootstrap owns the one and only device
request — so a successful probe followed by a real boot performs exactly one
`requestDevice()`, and a *failed* probe means gpu-chores never sees a device at
all.

Stages, in order: `secure-context` → `navigator-gpu` → `adapter` → `device` →
`context` → `ok`. Device- and context-stage outcomes are folded back into the
same published result, so `window.webgpuProbe` always describes how far boot
actually got.

On any failure the app shows a **blocking** error screen (not a toast) naming
the stage, reason, browser, and adapter.

## Breadcrumbs

```js
window.webgpuProbe        // { ok, browser, stage, reason, adapter, features, limits }
window.usingWebGPU        // true only when device + swapchain are live
window.usingWebGL         // pinned false while fallback is disabled
window.rendererType       // null on a hard-failed boot
window.rendererFallbackReason  // the hard-fail detail string
```

`window.usingWebGL` never becomes true on a failure path, so automation can
treat it as a fallback-happened signal without ambiguity.

## Selecting A Renderer (deferred)

Once the fallback wave re-enables `WEBGL_BACKEND_ENABLED`, these apply again:

```text
?renderer=webgpu
?renderer=webgl
?webgpu
?webgl
```

The NUNIF panel also exposes a **Renderer** control. It persists the selected backend in `localStorage.chromashift.renderer` and reloads with the matching `?renderer=` parameter.

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
