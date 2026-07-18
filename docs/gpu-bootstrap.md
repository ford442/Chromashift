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

- **Limits**: `deriveRequiredLimits()` requests the larger of the current canvas backing-store size and Chromashift's 8K target (`8192`), capped by the adapter.
- **Features**: `timestamp-query` and other optional features are probed and logged but **not** required — device creation stays compatible with more GPUs.
- **Pipeline errors**: `withErrorScope('validation', …)` wraps WebGPU renderer construction so shader/pipeline failures surface with a label.

## Device loss and errors

| Event | Handler | UI |
|---|---|---|
| `device.lost` (non-destroyed) | `deviceLostRuntimeError` | Recoverable overlay: reload or `?renderer=webgl` |
| `device.onuncapturederror` | Logged + `uncapturedRuntimeError` | Console + non-recoverable notice |
| Bootstrap failure | `toBootstrapRuntimeError` | Recoverable overlay |

`WebGpuSession.reconfigure()` re-applies `context.configure()` after canvas resize / DPR changes.

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
