# GPU Bootstrap

Chromashift centralizes renderer initialization in a few small modules, and documents shared canvas options in `src/engine/gpu/gpuOptions.ts`:

| Module | Owns |
|---|---|
| `src/engine/webgpu/webgpuSession.ts` | `bootstrapWebGpu()` — one canvas's session on the page's leased device |
| `src/engine/webgpu/adapter.ts` | Adapter request, the page device gate (`requestDevice` strategies), adapter / capability reports |
| `src/engine/webgpu/canvasConfig.ts` | `configureWebGpuCanvas()` — SDR / `hdr-extended`, the tone-mapping and HDR probes |
| `src/engine/gpu/gpuErrors.ts` | `GpuRuntimeError` and the mappings into it, `withErrorScope`, device diagnostics, the fatal breaker |
| `src/engine/webgl/webgl2Context.ts` | `createWebGL2Context()` (one sticky context per canvas) and `watchWebGL2Context()` |

 Multi-canvas slot lifecycle (compare views, future quad layout) is owned by `src/engine/RendererOrchestrator.ts`.

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
| Antialias | Layer-pass MSAA (`sampleCount` 1 or 4) | `antialias: false` on the context; layer-pass MSAA is a `samples: 4` renderbuffer (see below) |
| Preserve buffer | Swap-chain `usage` is `RENDER_ATTACHMENT` only: nothing copies from the canvas texture (export and readback render offscreen) | `preserveDrawingBuffer: false` for a live session; `true` only for screenshot / readback callers (see below) |
| Desynchronized | N/A | `desynchronized: false`; `?desynchronized=1` opts in, ignored while preserve-drawing-buffer is on (see below) |
| Depth / stencil | No depth/stencil attachments | `depth: false`, `stencil: false` |
| Premultiplied alpha | N/A (opaque canvas) | `premultipliedAlpha: false` |
| Colour space | `colorSpace: 'srgb'` default; optional `display-p3` from Viewport control / `viewport.colorSpace` | Browser default sRGB framebuffer |
| Tone mapping | `toneMapping.mode: 'standard'`, gated on a page-lifetime capability bit (see below) | N/A — the Viewport HDR toggle is hidden on WebGL |
| Power | `requestAdapter` walks `WEBGPU_POWER_PREFERENCE_ATTEMPTS` (`high-performance` → `low-power` → no preference) | `getContext` walks `WEBGL2_POWER_PREFERENCE_ATTEMPTS` (`high-performance` → `low-power` → `powerPreference` omitted); never `requestAdapter` |
| Internal targets | `rg11b10ufloat` under `rg11b10ufloat-renderable`, else `rgba8unorm` | `RGBA16F` layer/tracer targets when the context renders it, else `RGBA8` (see below) |
| Context loss | `device.lost` → recoverable overlay | `webglcontextlost` → the same overlay; `webglcontextrestored` → boot again on the same context |
| Texture headroom | At most two `requestDevice` strategies, both on default limits, then the live device is reused | `gl.MAX_TEXTURE_SIZE` |

`getWebGL2ContextAttributes(options, powerPreference)` (`gpuOptions.ts`) builds every attempt from `RENDERER_CANVAS_OPTIONS_MATRIX.webgl2`, and `gpuOptions.test.ts` checks this table against it. WebXR's xr-compatible context goes through the same `createWebGL2Context`.

**Context attempts (WebGL2).** `createWebGL2Context` tries `high-performance`, then `low-power`, then attributes with `powerPreference` omitted, and logs one `[Chromashift:GPU] WebGL2 context ready` info line naming the attempt that succeeded. A null `getContext` creates nothing, so each attempt is a fresh request. If all three return null it logs an error and throws `WebGL2UnavailableError`; the explicit WebGL session never falls through to WebGPU. Once granted, the context is remembered per canvas: `getContext` is sticky (a second call returns the same context, or null), so every later bootstrap on that canvas — a React effect re-run, **Retry GPU**, a restore — reuses it rather than asking again.

**Context loss (WebGL2).** `watchWebGL2Context` listens on the canvas. `webglcontextlost` is `preventDefault()`ed — without that the browser never restores — and the orchestrator destroys its slot and reports `webglContextLostRuntimeError()`: `kind: 'device-lost'`, recoverable, the same overlay `device.lost` raises. Its listeners outlive that teardown. On `webglcontextrestored` the orchestrator calls `onContextRestored`, and `useAppWebGPUInit` re-runs the Retry GPU path: a fresh orchestrator over the restored context, which recompiles every program, reallocates every FBO and reloads the current image. **Retry GPU** pressed while the context is still lost answers with the same overlay (`WebGL2ContextLostError`). If the restore never arrives, **Reload page** is the way out.

**MSAA (WebGL2).** The context `antialias` flag only multisamples the default framebuffer, and every pass renders into an FBO, so it never antialiased the picture. The Viewport **MSAA 4x** toggle reaches `WebGLRenderer.setAntialiasing` instead, which gives the executor's pool a sample count. The band-layer passes then draw into one shared multisample renderbuffer (`createMultisampleTarget` in `webgl/resources.ts`, `samples: 4`, clamped to what the context supports for the format) and `blitFramebuffer` it into the existing single-sample layer texture — what WebGPU does with its MSAA texture and resolve target. Persistence and the compositor stay 1×. Toggling reallocates that renderbuffer on the same context; nothing creates a new one, which is why `antialias` stays `false`.

**Internal targets (WebGL2).** `selectWebGLInternalFormat(gl)` (`webgl/resources.ts`) enables `EXT_color_buffer_half_float` (or `EXT_color_buffer_float`, which includes it) and checks that an `RGBA16F` framebuffer is complete. When it is, the executor's pool — layers, tracers, `history` rings, every intermediate target — allocates `RGBA16F`, so additive tracers no longer clip at 1.0 before the compositor. Otherwise it stays `RGBA8`, draws the same, and `window.webglInternalFormatNote` says the tracers clip (`webglInternalFormatNote`, the twin of `canvasHdrNote`); `window.webglInternalFormat` names the format either way. Targets that are read back — debug readback, export, the stationary previews, the upsample composite — stay `RGBA8` / `UNSIGNED_BYTE`. This is not Canvas HDR: WebGL has no `toneMapping: 'extended'`, the canvas is 8-bit, and the Viewport HDR toggle stays hidden.

**`desynchronized` (WebGL2).** Off by default. A low-latency canvas can hand the compositor its buffer before a `readPixels` / `toBlob` / Playwright screenshot reads it, which is exactly what preserve-drawing-buffer exists for. `resolveWebGL2Desynchronized(preserve)` therefore honours `?desynchronized=1` only when `resolveWebGL2PreserveDrawingBuffer()` resolved **off**, and `getWebGL2ContextAttributes` refuses the pair again on its own. Under automation (`navigator.webdriver`) preserve is on, so the param is ignored there unless the run also passes `?preserve_drawing_buffer=0`.

**`preserveDrawingBuffer` (WebGL2).** Off by default: the live diagnostic session never reads the canvas back, and preserving costs a copy per frame. It matches WebXR, which already passes `false` explicitly. `resolveWebGL2PreserveDrawingBuffer()` (`gpuOptions.ts`) turns it on for the paths that *do* read back — `canvas.toBlob` / `toDataURL` / `gl.readPixels` outside the draw call, and Playwright element screenshots — by checking, in order:

1. `?preserve_drawing_buffer=1` / `=0`, an explicit override for reproducing a capture problem in a normal tab;
2. `navigator.webdriver`, which covers the e2e suite without threading a flag through ~40 `page.goto` calls;
3. otherwise off.

**Canvas tone mapping.** `configureWebGpuCanvas` asks for `toneMapping.mode: 'standard'` but caches the answer in a page-lifetime capability bit, because Chromashift reconfigures on every resize, DPR change, and Display-P3 toggle — the old catch-and-retry cost a thrown exception *per configure* on a browser without it. The first configure feature-detects via `GPUCanvasContext.getConfiguration()` (Chrome 131+), which echoes the applied configuration so a silently dropped dictionary member is visible as an absent key; configure-and-catch remains only as the fallback for browsers that expose no `getConfiguration`, and it runs at most once. `getCanvasToneMappingSupport()` reports what was concluded (`null` before the first configure).

**Canvas presentation (Canvas HDR).** The swap chain has two presentation modes. `sdr` is the default, and the Viewport **Canvas HDR** toggle (`viewport.canvasHdr`, schema v8) opts into `hdr-extended`:

| Mode | Canvas configure | Canvas-target encode | For |
|---|---|---|---|
| `sdr` (default) | preferred format (`bgra8unorm` / `rgba8unorm`), `toneMapping: 'standard'` when supported | `encode_display` (sRGB OETF, clip at 1.0) | every existing preset, e2e, SDR galleries — pixel-identical to before |
| `hdr-extended` | `rgba16float`, `toneMapping: 'extended'` | extended-sRGB OETF (`WGSL_OUTPUT_ENCODE_EXTENDED`: same curve, sign-mirrored, unclamped) | HDR monitors, installations, screen-share capture |

- **Why `rgba16float`.** The 8-bit preferred formats cannot store values above 1.0, so `'extended'` only has headroom to show on a float canvas.
- **Probe.** `probeCanvasHdr` runs one HDR configure at bootstrap, verified through `getConfiguration()` where the browser has it. It publishes `window.canvasHdrAvailable` / `window.canvasHdrReason`. The reason also reports `(dynamic-range: high)`, since an SDR display still clips.
- **Fallback.** `configureWebGpuCanvas` caches the answer per page, like `'standard'`. A UA that throws or drops the format or tone mapping gets an SDR configure in the same call, so the canvas is never left black. `configureWebGpuCanvas` returns the presentation it actually applied.
- **Which passes change.** Each `WebGPURenderer` chooses its present passes from the canvas texture's format. On an `rgba16float` canvas the frame's graph variant presents `hdr-extended`: the `output` node carries `presentation`, and the compositor writing it emits the `toHdrPresentWgsl` source into an `rgba16float` target (docs/PASS_GRAPH.md § *The hdr-extended present*). The inspect views build their HDR `TracerInspectPass` the same way, on first use. Export keeps drawing the SDR variant. Until the device has validated the HDR variant, the canvas is cleared rather than drawn with SDR pipelines it cannot take.
- **Readback is RGBA.** The SDR canvas format is the browser's preferred one, often `bgra8unorm`, and export renders offscreen in that format. `GpuReadback.readTexturePixels` and the tracer export swap R and B when the texture is `bgra*` (`packRgbaRows`), so PNG / video export and the stationary previews always get RGBA. `e2e/webgpu-bgra-export.spec.ts` forces `getPreferredCanvasFormat()` to `bgra8unorm` and compares against `rgba8unorm`.
- **Export stays SDR.** `exportFrame` (WebM / WebCodecs / PNG sequence) always renders to the SDR pipelines' format through `encode_display`. The tracer PNG renders offscreen. Upscale captures the canvas via a 2D `drawImage`, which converts to the 2D canvas's SDR space. WebGL has no extended canvas tone mapping, so the toggle is hidden there.
- **Internal targets.** Canvas HDR does not request new device features. If `rg11b10ufloat-renderable` was not granted, the frame has already clipped in `rgba8unorm`. Diagnostics then shows `window.canvasHdrNote`: "canvas HDR requested, internal targets are rgba8unorm — highlights still clip".
- **Manual HDR-display check.** Use Chrome on an HDR monitor with OS HDR on. Load a bright image, raise *Tracer above* intensity and stamp boost until trails saturate, then toggle **Canvas HDR**. With it on, overlapping additive trails should glow brighter than the UI's white. With it off, they should match it. Toggling back off must look identical to a fresh session.

## Limits and features

- **Limits / device lease**: one `GPUAdapter` and at most one live `GPUDevice` per page. `requestWebGpuDevice` walks **at most two** strategies — `default-limits` (omit `requiredLimits`; on a compatibility-mode adapter, core's texture size capped at the adapter's, see [Compatibility mode](#compatibility-mode)) → `no-optional-features` (default limits, without the optional features) — then **stops**. There used to be a `canvas-limits` strategy between them, requesting a `maxTextureDimension2D` sized to the canvas; it could never help, because a request that failed on default limits does not succeed by asking for *more*. When the device is lost, `releasePageGpuDevice` drops the adapter with it: an adapter that has made a device is consumed and its second `requestDevice` rejects, so **Retry GPU** starts again from `requestAdapter`. The lease releases itself on `device.lost` (whoever's handler runs first), and a detached `attachDeviceDiagnostics` listener stays silent, so a dead renderer's handler does not report into its successor. A live device is reused; canvas resize reconfigures the context / recreates textures on that device. Queue-create / `E_OUTOFMEMORY` sets `gpuFatal` and never calls `requestDevice` again until reload. React effect re-runs, rAF, and ResizeObserver must not reset `attempt` to 1 (#157 / #158).
- **Perf HUD timestamps**: `GpuTimestampProfiler` resolves into a two-slot buffer whose slots are **256 bytes apart** — `resolveQuerySet`'s destination offset must be a multiple of 256. Packing the 48-byte payloads end to end put slot 1 at offset 48, failing validation; because the resolve shares the frame's command encoder, that discarded the whole command buffer on every other frame (a steady black blink whenever the HUD was on). The profiler also opts out entirely when `GPUCommandEncoder.prototype.writeTimestamp` is missing, rather than throwing mid-encode after the swap-chain texture has been acquired.
- **Logs**: one `[Chromashift:GPU] Adapter ready` and one `[Chromashift:GPU] requestDevice` at **info** per session (`attempt` index + strategy). Further strategies are **debug**. Failures are **error** so D3D12 OOM is not buried.
- **Features**: `listAvailableOptionalFeatures()` filters `CHROMASHIFT_OPTIONAL_FEATURES` (`gpuOptions.ts`) to what the adapter supports. That list is only `timestamp-query` (Perf HUD), `rg11b10ufloat-renderable` (HDR internal targets via `selectInternalColorFormat`) and `texture-formats-tier1` (the GPU analysis lane's `r8uint` storage mask — see *gpu-chores* below). They are **optional**: a failed `requestDevice` retries with `requiredFeatures: []` before giving up. None are required for core rendering. `float32-filterable` is **not** requested — the graph never samples 32-bit float textures. `device.features` after bootstrap is the source of truth (`WebGpuCapabilityReport`).
- **Internal colour format**: `selectInternalColorFormat(device)` returns `rg11b10ufloat` when `rg11b10ufloat-renderable` is granted, otherwise `rgba8unorm`. Additive tracers clip in the 8-bit fallback. Layer/persistence/compositor pipelines use this format; diagnostic stamp textures stay `rgba8unorm`.
- **Display colour space**: `buildWebGpuCanvasConfiguration` defaults to `colorSpace: 'srgb'`. The Viewport **Display P3** control sets `display-p3` on every canvas via `RendererOrchestrator.setCanvasColorSpace`. Colour-profile LUTs remain sRGB (documented in [COLOR_PROFILES.md](COLOR_PROFILES.md)).
- **Output transfer function**: the pipeline works in **linear light** end to end — source images upload as `rgba8unorm-srgb` (so sampling decodes), and the internal targets (`rg11b10ufloat` / `rgba8unorm`) are linear. `navigator.gpu.getPreferredCanvasFormat()` never returns an `-srgb` format, so every pass that renders to the **canvas format** applies the sRGB OETF itself via `encode_display` (`WGSL_OUTPUT_ENCODE`, emitted into the compositor, tracer view, display, heatmap and compare shaders). Omitting it let the display apply its EOTF twice and crushed every frame. The encode is an exact inverse of the upload decode — a passthrough frame round-trips to the bytes that were uploaded — and carries **no tone curve**; values above 1.0 clip at white. Colours authored in display space (letterbox fill, the compare divider) return *before* the encode, or are written as their linear equivalents.
- **Probe vs renderer breadcrumbs**: `publishWebGpuProbe` writes `window.webgpuProbe` only. `window.usingWebGPU` / `window.rendererType` are set by `publishRendererBreadcrumbs` after device + swapchain exist. A successful adapter probe must not make `waitForWebGPU` return early.

## Compatibility mode

WebGPU has two feature levels. Core is what Chrome, Edge, Safari and Firefox
hand out on a D3D12 / Metal / Vulkan GPU. **Compatibility mode** is what a
GL ES / D3D11-class backend can offer: the same API with a few features
withheld and lower default limits (#228).

**The adapter attempts.** `requestWebGpuAdapter` asks for core first:
`high-performance`, then `low-power`, then no preference. Only when every one
of those returns `null` does it ask for `featureLevel: 'compatibility'`. A
browser without compatibility mode ignores the member, so there the last
attempt is the previous one again. The level is recorded in
`window.webgpuProbe.featureLevel` (`'core'` / `'compatibility'`, `null`
without an adapter), the `Adapter ready` log and the capability report. A
compatibility adapter that can do core (`core-features-and-limits` among its
features) gets a core device: its device request asks for that feature.

**Limits.** These are a compatibility device's defaults where they differ
from core's, read off Dawn:

| Limit | Compatibility | Core |
|---|---|---|
| `maxTextureDimension2D` (and 1D) | 4096 | 8192 |
| `maxColorAttachments` | 4 | 8 |
| `maxUniformBufferBindingSize` | 16384 | 65536 |
| `maxComputeInvocationsPerWorkgroup`, `maxComputeWorkgroupSizeX/Y` | 128 | 256 |
| `maxInterStageShaderVariables` | 15 | 16 |
| `maxStorageBuffersInVertexStage`, `maxStorageTexturesInVertexStage` | 0 | 8, 4 |
| `maxStorageBuffersInFragmentStage` | 4 (0 on GL ES) | 8 |

The frame fits all of them except the texture size. A 2× export of a 4K
canvas, or a large photo, needs more than 4096. So the device request asks for
`maxTextureDimension2D: min(adapter's, 8192)`, which is core's default and
never more than the adapter has, and for nothing else. A core device asks for
no limits at all. An export that is still too large for the device is refused
by name ("Export size … is larger than this GPU's maxTextureDimension2D"),
not exported black.

**What it withholds, and what the graph uses.** Each restriction that could
touch a pipeline is a capability bit in `src/engine/graph/capabilities.ts`
(`DeviceCapability`):

| Restriction | The pipelines | Bit |
|---|---|---|
| Blend state or write mask differing between a pass's color attachments | Every target is `{ format }`, with the default blend and mask (`nodePipelines.ts`, `WebGPUPipelines.ts`, the mip blit), including the two targets of the decay pass | `independent-blend` |
| `textureLoad` of a depth texture | No depth textures | `depth-texture-load` |
| Storage buffers / textures in a fragment shader (none on GL ES) | Storage bindings only in compute (`chores/kernels.ts`, `motionFlowKernels.ts`, the stamp kernel) | `fragment-storage` |
| `r8uint` storage (`texture-formats-tier1`, optional at either level) | The GPU analysis lane's mask; without it the lane declines and the C++ engine runs | `r8uint-storage` |
| `rgba16float` canvas with `extended` tone mapping | The `hdr-extended` present, probed at bootstrap; SDR otherwise | `hdr-canvas` |
| One view dimension per texture; no cube arrays | 2D textures and 2D views only | — |
| `sample_mask`, `sample_index`, sample / linear interpolation | None | — |

`WEBGPU_NEEDS` lists the bits each node kind's program needs. Today it is
empty, and `hdr-canvas` follows from an `hdr-extended` output. When
`WebGPURenderer` compiles a variant, it checks the graph against the device's
bits (`webGpuDeviceCapabilities`). A variant that needs a withheld bit is an
`unsupported-capability` refusal naming it, reported like any other refusal,
and the default graph draws.

The audit behind the table was run on Dawn through the headless renderer
(docs/HEADLESS.md), with the device forced to compatibility mode. Dawn
validates compatibility mode on any backend. It covered the default graph at
1, 3, 7 and 10 layers, every other shape at three, every main view (on every
shape), Quarter Zoom and the export pass modes, with MSAA off and on, and
produced no validation errors. The one failure
was a texture over 4096, which the limit request above removes.
`capabilities.test.ts` pins that no preset variant needs a withheld bit.

**Safari and Firefox** draw the same frame on core WebGPU. What differs is
already handled:

- The preferred canvas format can be `bgra8unorm` (Safari's is). Readback and
  export swizzle it (`packRgbaRows`; `e2e/webgpu-bgra-export.spec.ts`).
- `timestamp-query` can be absent (Safari). The Perf HUD then shows CPU timing.
- Limits can be lower. No limit is ever requested above the adapter's: none on
  core, the texture size above on compatibility mode.
- Canvas HDR is probed, as everywhere (`getConfiguration` where the browser
  has it, configure-and-catch where it does not).

Playwright's `firefox` and `webkit` projects run `webgpu-smoke.spec.ts` and
`graph-executor.spec.ts` on each browser's default WebGPU exposure. A test
skips only when the build exposes no `navigator.gpu`
(`webgpuProbe.stage === 'navigator-gpu'`), and the SwiftShader frame goldens
become a content check there. In CI they run where the browsers ship WebGPU:
Firefox on `windows-latest`, WebKit on `macos-latest`. Both are non-blocking
until they have been green twice. Playwright's Linux builds expose no
`navigator.gpu` (Firefox's is behind `dom.webgpu.enabled` and then
blocklisted without a GPU), so locally on Linux every test skips.

## gpu-chores: compute device adoption

Load-time image analysis (BT.709 histogram + `r8uint` classification mask) runs behind the **`gpu-chores`** facade in `src/engine/compute/chores/`. Chromashift is the reference consumer; the sibling apps in the rollout (`clip_stacker`, `image_video_effects`, `flac_player`, `mod-player`, `web_sequencer`) depend on the same shapes, so treat `chores/index.ts` as the module boundary and keep app-specific wiring in `chromashiftHost.ts`.

**One device, always adopted — and one backend per device.** `bootstrapWebGpuSession()` takes a lease on the device's single `WebGpuChoreBackend` through `acquireGpuChoreSession()` (`src/engine/compute/GpuChoreSession.ts`), then builds `GpuImageAnalysis` from `session.device`. The compute lanes — `GpuImageAnalysis` (histogram + mask) and `MotionFieldPass` (op `motion-field`); the hand encoder's `PersistencePass` (op `coincidence`) was a third until it went with the hand encoder — each take their **own lease on that same instance** rather than constructing one. `useClassificationMask` registers *that* lane (`GpuImageAnalysis.backend`) with its runtime rather than building a new one, so:

- there is never a second `requestAdapter`/`requestDevice`;
- pipelines, staging buffers, bind-group caches, and the reused `r8uint` mask texture exist once per device rather than three times, so neither repeated image loads nor an N-layer coincidence graph grows VRAM per lane;
- on a **WebGL** backend there is no device, no `GpuImageAnalysis`, and therefore no `webgpu` lane registered at all — a GL context and a compute device are structurally unable to be live for the same analysis.

Lifecycle stays **ref-counted, not single-owner**: each holder releases its lease in `destroy()`, and the backend is destroyed only when the last one lets go. Tearing down `MotionFieldPass` with a slot therefore cannot pull compute state out from under analysis. The orchestrator's own lease outlives every lane, so a slot teardown or an analysis rebuild never destroys the backend mid-session. The op-level caches inside the backend are keyed per op, so analysis at source resolution and coincidence at tracer resolution do not contend. Breadcrumbs are unaffected — they are published per op (`gpuChoreBackend` vs `motionFieldBackend`), not per instance. `GpuChoreSession.test.ts` asserts the single construct and the ref-counted teardown.

**The GPU lane needs `texture-formats-tier1` for `image-analysis`.** The classification kernel writes a `texture_storage_2d<r8uint, write>`, and `r8uint` is a storage format only under that feature. Without it every object in the chain is invalid — and invalid WebGPU objects are not exceptions, so the lane used to hand back an invalid mask texture that the renderer bound into every band-layer pass, dropping each frame's command buffer (a black canvas). `supportsR8uintStorage(device)` now gates the op, and the job falls through to WASM/TS.

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

**Second op: `coincidence` (GPU-only, no CPU lane) — facade only.** The facade's `coincidence` op detects tracer layer overlaps once per dispatch in a compute kernel, instead of the fragment shader evaluating the same overlap math once per decay pass (issue [#145](https://github.com/ford442/Chromashift/issues/145)). Chromashift's hand encoder used it every frame, through `PersistencePass`; the pass graph that replaced it runs the fused fragment pass on every device instead, accepting the ±1-pixel difference (docs/PASS_GRAPH.md § *The compute-fed stamp*). The kernel — the one-shot `op: 'coincidence'` job and `WebGpuChoreBackend.encodeCoincidenceInto` — stays in the facade for the sibling apps until none uses it. The `wasm`/`ts` chore lanes always decline a `coincidence` job outright — there is no CPU implementation, by design (see the job's doc comment in `chores/types.ts`).

## Device loss and errors

| Event | Handler | UI |
|---|---|---|
| `device.lost` (non-destroyed) | `deviceLostRuntimeError` | Recoverable overlay: **Retry GPU** or reload |
| `webglcontextlost` (WebGL) | `watchWebGL2Context` → `webglContextLostRuntimeError` | The same recoverable overlay; `webglcontextrestored` re-boots on the same context, or **Reload page** if it never comes |
| `device.onuncapturederror` | `attachDeviceDiagnostics` → logged; rendering continues | Console only |
| A pipeline the device refused (inspect views, a compare slot's renderer, the collision-stats blit) | `PipelineCompileError` → `pipelineRuntimeError` | Dismissable notice with the compiler's `line:column` messages; the frame keeps drawing (that view shows the composite) |
| Bootstrap failure | `toBootstrapRuntimeError` | Blocking overlay; **not** recoverable (no Retry GPU). Queue OOM names command-queue exhaustion. **Open WebGL diagnostic session** remains. |

### Recovery actions

| Action | Behaviour |
|---|---|
| **Retry GPU** (in-app) | Device-lost only. Re-runs `RendererOrchestrator.bootstrap` on the page adapter; `gpuFatal` (OOM / exhausted strategies) refuses another `requestDevice` until reload. Preserves reducer settings and current image index. On WebGL it re-uses the canvas's context, and answers with the same overlay while that context is still lost. |
| **Reload page** | Full navigation |
| **Open WebGL diagnostic session** | `openWebGlDiagnosticSession()` → persist preference and `location.assign(?renderer=webgl)`. New page load. Never an in-place silent switch. |

A failed WebGPU boot still hard-fails. `publishRendererBootFailure` pins `usingWebGPU` and `usingWebGL` false and `rendererType` null. After a successful retry or an explicit WebGL navigation, `publishRendererBreadcrumbs` updates those globals. See [webgl-fallback.md](webgl-fallback.md).

After canvas resize or DPR changes, `RendererOrchestrator.resizeAll()` reconfigures the primary session context and every additional slot context (replacing a direct `WebGpuSession.reconfigure()` call from React hooks).

## Minimum GPU / browser guidance

| Requirement | Notes |
|---|---|
| Browser | Chrome 113+, Edge 113+, Safari 26+, Firefox 141+ on Windows (other Firefox platforms as they ship WebGPU) |
| Feature level | Core, or [compatibility mode](#compatibility-mode) on a GL ES / D3D11-class GPU |
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

Tests live beside each module (`adapter.test.ts` — including the compatibility-mode attempt and its limits —, `canvasConfig.test.ts`, `gpuErrors.test.ts`, `gpuOptions.test.ts`, `webgl2Context.test.ts`) and in `src/engine/RendererOrchestrator.test.ts` (Retry GPU on a fresh adapter, one error-scope pop, detachable device-lost listeners, refused secondary pipelines), `src/engine/webgpu/GpuReadback.test.ts` (BGRA → RGBA readback) and `src/engine/webgpu/WebGPUPipelines.test.ts` (compiler messages). `src/engine/graph/capabilities.test.ts` pins the capability bits and that no preset variant needs a bit compatibility mode withholds. In the browser, `e2e/webgpu-device-loss.spec.ts` destroys the device and clicks **Retry GPU**, and `e2e/webgpu-bgra-export.spec.ts` checks readback on a forced `bgra8unorm` canvas.
