# GPU Bootstrap

Chromashift centralizes renderer initialization in `src/engine/gpuBootstrap.ts` and documents shared canvas options in `src/engine/gpuOptions.ts`. Multi-canvas slot lifecycle (compare views, future quad layout) is owned by `src/engine/RendererOrchestrator.ts`.

## Renderer orchestration

`RendererOrchestrator` (`src/engine/RendererOrchestrator.ts`) owns one shared GPU session, one `TextureManager`, and one `gpu-chores` backend, and binds N `ChromashiftRenderer` instances to independent canvases (compare dual/quad, kiosk monitors, future WebXR layers).

```ts
import { RendererOrchestrator } from './RendererOrchestrator';

const { orchestrator, primarySlot, backend, fallbackReason } =
  await RendererOrchestrator.bootstrap({
    primaryCanvas: mainCanvas,
    antialias: true,
    onRuntimeError: (error) => { /* device.lost, uncaptured, … */ },
  });

rendererRef.current = primarySlot.renderer;          // primary slot id is PRIMARY_SLOT_ID
textureManagerRef.current = orchestrator.textureManagerRef();

orchestrator.createSlot('compare-b', canvasB);       // extra WebGPU contexts, same device
orchestrator.resizeAll();                            // after canvas resize / DPR change
orchestrator.destroySlot('compare-b');
orchestrator.destroy();                              // tears down all slots + device
```

```
RendererOrchestrator.bootstrap(primaryCanvas)
├── preferred backend webgpu → WebGpuSession (device + primary context)
│      └── one GpuChoreSession lease — the device's single WebGpuChoreBackend,
│          borrowed by analysis, coincidence, and motion-field
├── preferred backend webgl → WebGL2 context (no adapter/device request)
│      └── no GpuImageAnalysis / no webgpu chore lane
└── slot "primary" → ChromashiftRenderer on primary canvas
```

| Concern | Behaviour / owner |
|---|---|
| WebGPU bootstrap | First canvas creates `WebGpuSession` (device + primary context); extra slots call `configureWebGpuCanvas` on their own contexts |
| WebGL diagnostic | Single slot only (primary canvas); compare/multi-view is WebGPU-only. Started only when `backend: 'webgl'` / `getRendererPreference()` is webgl — never after a WebGPU catch. |
| Primary slot | `PRIMARY_SLOT_ID` (`'primary'`) — created during bootstrap |
| Compare slot B | `COMPARE_SLOT_B_ID` (`'compare-b'`) via `useCompareSlotRenderer` |
| Ref wiring from React | `useAppWebGPUInit` → `orchestratorRef` + legacy `rendererRef` / `deviceRef` |
| Canvas resize | `useCanvasResize` → `resizeAll()`, which reconfigures the session context and every secondary slot context on the **existing** device. Canvas size must not `requestDevice`. |
| Chore backend | One lease per orchestrator session (see *gpu-chores* below); slot teardown never destroys it |
| `device.lost` | Orchestrator destroys all active slots; shared `onRuntimeError` surfaces the recoverable overlay |
| In-app retry | **Retry GPU** (device-lost only) re-runs `RendererOrchestrator.bootstrap` without navigation. `E_OUTOFMEMORY` / exhausted strategies are **not** retryable — reload required. |
| Tests | `RendererOrchestrator.test.ts` mocks bootstrap/factories — no WebGPU adapter required in CI |

`useAppWebGPUInit` delegates bootstrap and primary-slot creation to the orchestrator; image corpus loading stays in the hook. `useCompareSlotRenderer` calls `createSlot('compare-b')` / `destroySlot` when dual layout is active. Secondary slots must be created **after** bootstrap and destroyed **before** `orchestrator.destroy()` (the compare hook runs between init and unmount for this ordering).

## Options matrix

| Concern | WebGPU (`bootstrapWebGpu`) | WebGL2 (`createWebGL2Context`) |
|---|---|---|
| Alpha | `alphaMode: 'opaque'` on canvas configure | `alpha: false` |
| Antialias | Layer-pass MSAA (`sampleCount` 1 or 4) | `antialias` from `RendererCanvasOptions` |
| Preserve buffer | `usage` includes `COPY_SRC` on swapchain | `preserveDrawingBuffer: false` for a live session; `true` only for screenshot / readback callers (see below) |
| Colour space | `colorSpace: 'srgb'` default; optional `display-p3` from Viewport control / `viewport.colorSpace` | Browser default sRGB framebuffer |
| Tone mapping | `toneMapping.mode: 'standard'`, gated on a page-lifetime capability bit (see below) | N/A |
| Power | `requestAdapter` walks `WEBGPU_POWER_PREFERENCE_ATTEMPTS` (`high-performance` → `low-power` → no preference) | N/A |
| Texture headroom | At most three `requestDevice` strategies, then the live device is reused | `gl.MAX_TEXTURE_SIZE` |

**`preserveDrawingBuffer` (WebGL2).** Off by default: the live diagnostic session never reads the canvas back, and preserving costs a copy per frame. It matches WebXR, which already passes `false` explicitly. `resolveWebGL2PreserveDrawingBuffer()` (`gpuOptions.ts`) turns it on for the paths that *do* read back — `canvas.toBlob` / `toDataURL` / `gl.readPixels` outside the draw call, and Playwright element screenshots — by checking, in order:

1. `?preserve_drawing_buffer=1` / `=0`, an explicit override for reproducing a capture problem in a normal tab;
2. `navigator.webdriver`, which covers the e2e suite without threading a flag through ~40 `page.goto` calls;
3. otherwise off.

**Canvas tone mapping.** `configureWebGpuCanvas` asks for `toneMapping.mode: 'standard'` but caches the answer in a page-lifetime capability bit, because Chromashift reconfigures on every resize, DPR change, and Display-P3 toggle — the old catch-and-retry cost a thrown exception *per configure* on a browser without it. The first configure feature-detects via `GPUCanvasContext.getConfiguration()` (Chrome 131+), which echoes the applied configuration so a silently dropped dictionary member is visible as an absent key; configure-and-catch remains only as the fallback for browsers that expose no `getConfiguration`, and it runs at most once. `getCanvasToneMappingSupport()` reports what was concluded (`null` before the first configure).

## Limits and features

- **Limits / device lease**: one `GPUAdapter` and at most one live `GPUDevice` per page. `requestWebGpuDevice` walks **at most three** strategies — `default-limits` (omit `requiredLimits`) → `canvas-limits` (longest canvas edge, floored at 256 so a 150px layout glitch cannot reshape the request) → `no-optional-features` — then **stops**. A live device is reused; canvas resize reconfigures the context / recreates textures on that device. Queue-create / `E_OUTOFMEMORY` sets `gpuFatal` and never calls `requestDevice` again until reload. React effect re-runs, rAF, and ResizeObserver must not reset `attempt` to 1 (#157 / #158).
- **Perf HUD timestamps**: `GpuTimestampProfiler` resolves into a two-slot buffer whose slots are **256 bytes apart** — `resolveQuerySet`'s destination offset must be a multiple of 256. Packing the 48-byte payloads end to end put slot 1 at offset 48, failing validation; because the resolve shares the frame's command encoder, that discarded the whole command buffer on every other frame (a steady black blink whenever the HUD was on). The profiler also opts out entirely when `GPUCommandEncoder.prototype.writeTimestamp` is missing, rather than throwing mid-encode after the swap-chain texture has been acquired.
- **Logs**: one `[Chromashift:GPU] Adapter ready` and one `[Chromashift:GPU] requestDevice` at **info** per session (`attempt` index + strategy). Further strategies are **debug**. Failures are **error** so D3D12 OOM is not buried.
- **Features**: `listAvailableOptionalFeatures()` filters `CHROMASHIFT_OPTIONAL_FEATURES` (`gpuOptions.ts`) to what the adapter supports. That list is only `timestamp-query` (Perf HUD) and `rg11b10ufloat-renderable` (HDR internal targets via `selectInternalColorFormat`). They are **optional**: a failed `requestDevice` retries with `requiredFeatures: []` before giving up. None are required for core rendering. `float32-filterable` is **not** requested — the graph never samples 32-bit float textures. `device.features` after bootstrap is the source of truth (`WebGpuCapabilityReport`).
- **Internal colour format**: `selectInternalColorFormat(device)` returns `rg11b10ufloat` when `rg11b10ufloat-renderable` is granted, otherwise `rgba8unorm`. Additive tracers clip in the 8-bit fallback. Layer/persistence/compositor pipelines use this format; diagnostic stamp textures stay `rgba8unorm`.
- **Display colour space**: `buildWebGpuCanvasConfiguration` defaults to `colorSpace: 'srgb'`. The Viewport **Display P3** control sets `display-p3` on every canvas via `RendererOrchestrator.setCanvasColorSpace`. Colour-profile LUTs remain sRGB (documented in [COLOR_PROFILES.md](COLOR_PROFILES.md)).
- **Output transfer function**: the pipeline works in **linear light** end to end — source images upload as `rgba8unorm-srgb` (so sampling decodes), and the internal targets (`rg11b10ufloat` / `rgba8unorm`) are linear. `navigator.gpu.getPreferredCanvasFormat()` never returns an `-srgb` format, so every pass that renders to the **canvas format** applies the sRGB OETF itself via `encode_display` (`WGSL_OUTPUT_ENCODE`, emitted into the compositor, tracer view, display, heatmap and compare shaders). Omitting it let the display apply its EOTF twice and crushed every frame. The encode is an exact inverse of the upload decode — a passthrough frame round-trips to the bytes that were uploaded — and carries **no tone curve**; values above 1.0 clip at white. Colours authored in display space (letterbox fill, the compare divider) return *before* the encode, or are written as their linear equivalents.
- **Probe vs renderer breadcrumbs**: `publishWebGpuProbe` writes `window.webgpuProbe` only. `window.usingWebGPU` / `window.rendererType` are set by `publishRendererBreadcrumbs` after device + swapchain exist. A successful adapter probe must not make `waitForWebGPU` return early.

## gpu-chores: compute device adoption

Load-time image analysis (BT.709 histogram + `r8uint` classification mask) runs behind the **`gpu-chores`** facade in `src/engine/compute/chores/`. Chromashift is the reference consumer; the sibling apps in the rollout (`clip_stacker`, `image_video_effects`, `flac_player`, `mod-player`, `web_sequencer`) depend on the same shapes, so treat `chores/index.ts` as the module boundary and keep app-specific wiring in `chromashiftHost.ts`.

**One device, always adopted — and one backend per device.** `bootstrapWebGpuSession()` takes a lease on the device's single `WebGpuChoreBackend` through `acquireGpuChoreSession()` (`src/engine/compute/GpuChoreSession.ts`), then builds `GpuImageAnalysis` from `session.device`. The three compute lanes — `GpuImageAnalysis` (histogram + mask), `PersistencePass` (op `coincidence`), and `MotionFieldPass` (op `motion-field`) — each take their **own lease on that same instance** rather than constructing one. `useClassificationMask` registers *that* lane (`GpuImageAnalysis.backend`) with its runtime rather than building a new one, so:

- there is never a second `requestAdapter`/`requestDevice`;
- pipelines, staging buffers, bind-group caches, and the reused `r8uint` mask texture exist once per device rather than three times, so neither repeated image loads nor an N-layer coincidence graph grows VRAM per lane;
- on a **WebGL** backend there is no device, no `GpuImageAnalysis`, and therefore no `webgpu` lane registered at all — a GL context and a compute device are structurally unable to be live for the same analysis.

Lifecycle stays **ref-counted, not single-owner**: each holder releases its lease in `destroy()`, and the backend is destroyed only when the last one lets go. Tearing down `PersistencePass` therefore cannot pull compute state out from under analysis or motion. The orchestrator's own lease outlives every lane, so a slot teardown or an analysis rebuild never destroys the backend mid-session. The op-level caches inside the backend are keyed per op, so analysis at source resolution and coincidence at tracer resolution do not contend. Breadcrumbs are unaffected — they are published per op (`gpuChoreBackend` vs `motionFieldBackend`), not per instance. `GpuChoreSession.test.ts` asserts the single construct and the ref-counted teardown.

**Fallback order** is fixed in `CHORE_BACKEND_ORDER` and walked by `runJob({ prefer: 'auto' })`:

```
webgpu  →  wasm  →  ts
```

WebGL2 is not a lane (no workable atomics/histogram story). See AGENTS.md § *GPU Image Analysis (Compute)* for the full contract.

**Diagnosing a Chrome-vs-Edge divergence.** A lane that closes always records why, so a failure degrades to WASM with a reason instead of a blank analysis. After a load, read:

| Breadcrumb | Meaning |
|---|---|
| `window.gpuComputeAvailable` | WebGPU compute lane usable at all |
| `window.gpuComputeReason` | Why it is not (`null` when available) |
| `window.gpuComputeDiagnostics` | Adapter `vendor` / `architecture` / `device` / `description`, granted `features`, and compute `limits` |
| `window.gpuChoreBackend` | Which lane served the last job (`webgpu` / `wasm` / `ts`, `null` on total failure) |
| `window.gpuChoreReason` | Joined decline/failure reasons when no lane ran |

`runJob`'s `ChoreFailure.attempts` carries the same per-lane detail programmatically.

**Kill switch**: `?no_gpu_compute` closes the WebGPU lane and names itself in `gpuComputeReason`, so a disabled run is never mistaken for a capability failure.

**Break-even**: the GPU lane wins on 4K–8K images, where the two compute passes dwarf pipeline setup plus the single 1 KiB histogram map. Small stills are dominated by that fixed cost and by `mapAsync` latency; they still take the GPU lane when a source texture already exists, because the alternative is a CPU decode of an image the GPU already holds. Add a resolution floor only with a microbench to justify it.

**Second op: `coincidence` (per-frame, no CPU lane).** `PersistencePass` uses the same `WebGpuChoreBackend` class for a second, GPU-only op: detecting tracer layer overlaps once per frame instead of the fragment shader recomputing the same 3-layer overlap math twice (once per above/below decay pass — see `docs/wasm-engine.md` and issue [#145](https://github.com/ford442/Chromashift/issues/145)). `PersistencePass` **borrows** the device's shared `WebGpuChoreBackend` through `acquireGpuChoreSession()` rather than constructing one, so its lazily-built compute pipelines are shared with the image-analysis and motion-field lanes. The render hot path's lifecycle still is not coupled to the load-time analysis instance's — that decoupling now comes from the ref-counted lease (`PersistencePass.destroy()` releases; the backend survives) instead of from a duplicate backend. The `wasm`/`ts` chore lanes always decline a `coincidence` job outright — there is no CPU implementation, by design (see the job's doc comment in `chores/types.ts`). Compute persistence is feature-detected per frame (`WebGpuChoreBackend.isSupported()` + `canAnalyze()`); the original fused fragment shader in `engine/shaders/persistence.ts` remains the fallback when compute storage textures are unavailable.

## Device loss and errors

| Event | Handler | UI |
|---|---|---|
| `device.lost` (non-destroyed) | `deviceLostRuntimeError` | Recoverable overlay: **Retry GPU** or reload |
| `device.onuncapturederror` | Logged + `uncapturedRuntimeError` | Console + non-recoverable notice |
| Bootstrap failure | `toBootstrapRuntimeError` | Blocking overlay; **not** recoverable (no Retry GPU). Queue OOM names command-queue exhaustion. **Open WebGL diagnostic session** remains. |

### Recovery actions

| Action | Behaviour |
|---|---|
| **Retry GPU** (in-app) | Device-lost only. Re-runs `RendererOrchestrator.bootstrap` on the page adapter; `gpuFatal` (OOM / exhausted strategies) refuses another `requestDevice` until reload. Preserves reducer settings and current image index. |
| **Reload page** | Full navigation |
| **Open WebGL diagnostic session** | `openWebGlDiagnosticSession()` → persist preference and `location.assign(?renderer=webgl)`. New page load. Never an in-place silent switch. |

A failed WebGPU boot still hard-fails. `publishRendererBootFailure` pins `usingWebGPU` and `usingWebGL` false and `rendererType` null. After a successful retry or an explicit WebGL navigation, `publishRendererBreadcrumbs` updates those globals. See [webgl-fallback.md](webgl-fallback.md).

After canvas resize or DPR changes, `RendererOrchestrator.resizeAll()` reconfigures the primary session context and every additional slot context (replacing a direct `WebGpuSession.reconfigure()` call from React hooks).

## Minimum GPU / browser guidance

| Requirement | Notes |
|---|---|
| Browser | Chrome 113+, Edge 113+, or Chrome Canary with WebGPU enabled |
| GPU | Any adapter that exposes `rgba16float` render targets (WebGPU core); discrete GPUs recommended for 4K+ canvases |
| RAM | 8K intermediate textures need adapters with `maxTextureDimension2D ≥ 8192` |
| Flags | If WebGPU is missing: `chrome://flags/#enable-unsafe-webgpu` (older builds) |

WebGPU is **required** for the default session — there is no automatic WebGL2
fallback to catch an unsupported browser. A missing adapter or a failed
`requestDevice` produces a blocking error screen naming the probe stage,
browser, and adapter. Operators can then open an explicit WebGL diagnostic
session (`?renderer=webgl`). See [webgl-fallback.md](webgl-fallback.md).

## Testing

Pure helpers are covered by Vitest without a React tree:

```bash
npm test
```

Tests live in `src/engine/gpuBootstrap.test.ts` and `src/engine/RendererOrchestrator.test.ts`.
