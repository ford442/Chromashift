# GPU Bootstrap

Chromashift centralizes renderer initialization in `src/engine/gpuBootstrap.ts` and documents shared canvas options in `src/engine/gpuOptions.ts`. Multi-canvas slot lifecycle (compare views, future quad layout) is owned by `src/engine/RendererOrchestrator.ts`.

## Renderer orchestration

`RendererOrchestrator` owns one shared GPU session and texture manager, and spawns or destroys N renderer instances bound to separate canvases:

```ts
import { RendererOrchestrator } from './RendererOrchestrator';

const { orchestrator, primarySlot, backend, fallbackReason } =
  await RendererOrchestrator.bootstrap({
    primaryCanvas: mainCanvas,
    antialias: true,
    onRuntimeError: (error) => { /* device.lost, uncaptured, … */ },
  });

// Primary slot id defaults to "main"
rendererRef.current = primarySlot.renderer;
textureManagerRef.current = orchestrator.textureManagerRef();

// Additional canvases (compare slot B, future quad cells)
const slotB = orchestrator.createSlot('compare-b', canvasB);
orchestrator.destroySlot('compare-b');

orchestrator.resizeAll(); // after canvas resize / DPR change
orchestrator.destroy();   // tears down all slots + device
```

| Concern | Behaviour |
|---|---|
| WebGPU bootstrap | First canvas creates `WebGpuSession` (device + primary context); extra slots call `configureWebGpuCanvas` on their own contexts |
| WebGL fallback | Single slot only (primary canvas); compare/multi-view is WebGPU-only |
| `device.lost` | Orchestrator destroys all active slots; shared `onRuntimeError` surfaces the recoverable overlay |
| In-app retry | **Retry GPU** on the error overlay re-runs `RendererOrchestrator.bootstrap` without navigation; reducer state and current image index are preserved |
| Resize | `resizeAll()` reconfigures the session context and every secondary slot context |
| Tests | `RendererOrchestrator.test.ts` mocks bootstrap/factories — no WebGPU adapter required in CI |

`useAppWebGPUInit` bootstraps the orchestrator and wires refs (`orchestratorRef`, `rendererRef`, `textureManagerRef`, …). `useCompareSlotRenderer` calls `createSlot('compare-b')` / `destroySlot` when dual layout is active.

## Options matrix

| Concern | WebGPU (`bootstrapWebGpu`) | WebGL2 (`createWebGL2Context`) |
|---|---|---|
| Alpha | `alphaMode: 'opaque'` on canvas configure | `alpha: false` |
| Antialias | Layer-pass MSAA (`sampleCount` 1 or 4) | `antialias` from `RendererCanvasOptions` |
| Preserve buffer | `usage` includes `COPY_SRC` on swapchain | `preserveDrawingBuffer: true` |
| Colour space | `colorSpace: 'srgb'` | Browser default sRGB framebuffer |
| Tone mapping | `toneMapping.mode: 'standard'` when set | N/A |
| Power | `powerPreference: 'high-performance'` | N/A |
| Texture headroom | `requiredLimits.maxTextureDimension2D` derived from canvas + 8K target | `gl.MAX_TEXTURE_SIZE` |

## Limits and features

- **Limits**: `bootstrapWebGpu` first derives **canvas-sized** `requiredLimits` (`requestHeadroom: false`). `requestWebGpuDeviceAttempts` then tries: (1) default `requestDevice` with optional features, (2) those canvas limits, (3) 8K headroom (`8192`, capped by the adapter). See [#142](https://github.com/ford442/Chromashift/issues/142) — this retry order should stay documented if the 8K-first wording returns.
- **Features**: `listAvailableOptionalFeatures()` filters `CHROMASHIFT_OPTIONAL_FEATURES` (`gpuOptions.ts`) down to what the adapter supports, and `requestWebGpuDevice()` passes that list as `requiredFeatures` on every `requestDevice` attempt (minimal → canvas limits → 8K headroom), so a granted feature survives limit fallback. None are required for core rendering: if a feature-bearing request fails outright (rare driver quirk), bootstrap retries the same limit tiers with no optional features rather than failing. `device.features` after bootstrap reflects what was actually granted (see `WebGpuCapabilityReport.grantedOptionalFeatures` / `timestampQueryAvailable`).
- **Pipeline errors**: `withErrorScope('validation', …)` wraps WebGPU renderer construction so shader/pipeline failures surface with a label.

## Renderer orchestration

Multi-canvas layouts (compare dual/quad, kiosk monitors, future WebXR layers) share **one** `GPUDevice` and `TextureManager` while binding separate `WebGPURenderer` instances to independent canvases. `RendererOrchestrator` (`src/engine/RendererOrchestrator.ts`) owns that lifecycle:

```
RendererOrchestrator.bootstrap(primaryCanvas)
├── WebGpuSession (device + primary context)  OR  WebGL2 context
├── shared TextureManager + GpuImageAnalysis (WebGPU only)
│      └── gpu-chores WebGPU lane — adopts this device, never requests one
└── slot "primary" → ChromashiftRenderer on primary canvas

orchestrator.createSlot('compare-b', canvasB)   // extra WebGPU contexts, same device
orchestrator.resizeAll()                        // after canvas/DPR resize
orchestrator.destroySlot('compare-b')
orchestrator.destroy()                          // tears down all slots + device
```

| Concern | Owner |
|---|---|
| Bootstrap / WebGL fallback | `RendererOrchestrator.bootstrap()` |
| Primary slot | `PRIMARY_SLOT_ID` (`'primary'`) — created during bootstrap |
| Compare slot B | `COMPARE_SLOT_B_ID` (`'compare-b'`) via `useCompareSlotRenderer` |
| Ref wiring from React | `useAppWebGPUInit` → `orchestratorRef` + legacy `rendererRef` / `deviceRef` |
| Canvas resize | `useCanvasResize` → `orchestrator.resizeAll()` |
| `device.lost` | Session callback → `teardownAllSlots()`; recoverable overlay with **Retry GPU** |

`useAppWebGPUInit` delegates bootstrap and primary-slot creation to the orchestrator; image corpus loading stays in the hook. Secondary slots must be created **after** bootstrap and destroyed **before** `orchestrator.destroy()` (compare hook runs between init and unmount for this ordering).

Unit tests in `src/engine/RendererOrchestrator.test.ts` mock GPU factories so CI does not require WebGPU.

## gpu-chores: compute device adoption

Load-time image analysis (BT.709 histogram + `r8uint` classification mask) runs behind the **`gpu-chores`** facade in `src/engine/compute/chores/`. Chromashift is the reference consumer; the sibling apps in the rollout (`clip_stacker`, `image_video_effects`, `flac_player`, `mod-player`, `web_sequencer`) depend on the same shapes, so treat `chores/index.ts` as the module boundary and keep app-specific wiring in `chromashiftHost.ts`.

**One device, always adopted.** `bootstrapWebGpuSession()` constructs `GpuImageAnalysis` from `session.device`, and that instance owns the single `WebGpuChoreBackend`. `useClassificationMask` registers *that* lane (`GpuImageAnalysis.backend`) with its runtime rather than building a new one, so:

- there is never a second `requestAdapter`/`requestDevice`;
- pipelines, the histogram staging buffer, and the reused `r8uint` mask texture are shared, so repeated image loads do not grow VRAM;
- on a **WebGL** backend there is no device, no `GpuImageAnalysis`, and therefore no `webgpu` lane registered at all — a GL context and a compute device are structurally unable to be live for the same analysis.

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

## Device loss and errors

| Event | Handler | UI |
|---|---|---|
| `device.lost` (non-destroyed) | `deviceLostRuntimeError` | Recoverable overlay: **Retry GPU** or reload |
| `device.onuncapturederror` | Logged + `uncapturedRuntimeError` | Console + non-recoverable notice |
| Bootstrap failure | `toBootstrapRuntimeError` | Recoverable overlay |

### Recovery actions

| Action | Behaviour |
|---|---|
| **Retry GPU** (in-app) | Re-runs `RendererOrchestrator.bootstrap`; preserves reducer settings, compare layout, kiosk flags, and current image index. `useImagePlayback` reloads the active texture when `gpuReady` becomes true again. Compare slots reattach via `useCompareSlotRenderer` / `useCompareQuadSlots`. |
| **Reload page** | Full navigation |

> **Switch to WebGL2** was removed: WebGL2 fallback is disabled for this
> development phase, so a failed WebGPU boot hard-fails instead of offering an
> escape hatch. See [webgl-fallback.md](webgl-fallback.md).

After a successful retry, automation breadcrumbs (`window.usingWebGPU`, `window.usingWebGL`, `window.rendererType`) are updated via `publishRendererBreadcrumbs`. On a **hard-failed** boot `publishRendererBootFailure` pins `usingWebGPU` and `usingWebGL` false and `rendererType` null, so a failure can never be misread as a successful fallback.

After canvas resize or DPR changes, `RendererOrchestrator.resizeAll()` reconfigures the primary session context and every additional slot context (replacing a direct `WebGpuSession.reconfigure()` call from React hooks).

## Minimum GPU / browser guidance

| Requirement | Notes |
|---|---|
| Browser | Chrome 113+, Edge 113+, or Chrome Canary with WebGPU enabled |
| GPU | Any adapter that exposes `rgba16float` render targets (WebGPU core); discrete GPUs recommended for 4K+ canvases |
| RAM | 8K intermediate textures need adapters with `maxTextureDimension2D ≥ 8192` |
| Flags | If WebGPU is missing: `chrome://flags/#enable-unsafe-webgpu` (older builds) |

WebGPU is **required** for this development phase — there is no WebGL2 fallback
to catch an unsupported browser. A missing adapter or a failed `requestDevice`
produces a blocking error screen naming the probe stage, browser, and adapter.
See [webgl-fallback.md](webgl-fallback.md).

## Testing

Pure helpers are covered by Vitest without a React tree:

```bash
npm test
```

Tests live in `src/engine/gpuBootstrap.test.ts` and `src/engine/RendererOrchestrator.test.ts`.
