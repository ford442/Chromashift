# GPU Bootstrap

Chromashift centralizes renderer initialization in `src/engine/gpuBootstrap.ts` and documents shared canvas options in `src/engine/gpuOptions.ts`.

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

- **Limits**: `deriveRequiredLimits()` requests the larger of the current canvas backing-store size and Chromashift's 8K target (`8192`), capped by the adapter.
- **Features**: `timestamp-query` and other optional features are probed and logged but **not** required — device creation stays compatible with more GPUs.
- **Pipeline errors**: `withErrorScope('validation', …)` wraps WebGPU renderer construction so shader/pipeline failures surface with a label.

## Renderer orchestration

Multi-canvas layouts (compare dual/quad, kiosk monitors, future WebXR layers) share **one** `GPUDevice` and `TextureManager` while binding separate `WebGPURenderer` instances to independent canvases. `RendererOrchestrator` (`src/engine/RendererOrchestrator.ts`) owns that lifecycle:

```
RendererOrchestrator.bootstrap(primaryCanvas)
├── WebGpuSession (device + primary context)  OR  WebGL2 context
├── shared TextureManager + GpuImageAnalysis (WebGPU only)
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
| `device.lost` | Session callback → `teardownAllSlots()`; recoverable overlay unchanged |

`useAppWebGPUInit` delegates bootstrap and primary-slot creation to the orchestrator; image corpus loading stays in the hook. Secondary slots must be created **after** bootstrap and destroyed **before** `orchestrator.destroy()` (compare hook runs between init and unmount for this ordering).

Unit tests in `src/engine/RendererOrchestrator.test.ts` mock GPU factories so CI does not require WebGPU.

## Device loss and errors

| Event | Handler | UI |
|---|---|---|
| `device.lost` (non-destroyed) | `deviceLostRuntimeError` | Recoverable overlay: reload or `?renderer=webgl` |
| `device.onuncapturederror` | Logged + `uncapturedRuntimeError` | Console + non-recoverable notice |
| Bootstrap failure | `toBootstrapRuntimeError` | Recoverable overlay |

After canvas resize or DPR changes, `RendererOrchestrator.resizeAll()` reconfigures the primary session context and every additional slot context (replacing a direct `WebGpuSession.reconfigure()` call from React hooks).

## Minimum GPU / browser guidance

| Requirement | Notes |
|---|---|
| Browser | Chrome 113+, Edge 113+, or Chrome Canary with WebGPU enabled |
| GPU | Any adapter that exposes `rgba16float` render targets (WebGPU core); discrete GPUs recommended for 4K+ canvases |
| RAM | 8K intermediate textures need adapters with `maxTextureDimension2D ≥ 8192` |
| Flags | If WebGPU is missing: `chrome://flags/#enable-unsafe-webgpu` (older builds) |

WebGL2 fallback works on any browser with WebGL2 for debugging and screenshots.

## Testing

Pure helpers are covered by Vitest without a React tree:

```bash
npm test
```

Tests live in `src/engine/gpuBootstrap.test.ts` and `src/engine/RendererOrchestrator.test.ts`.
