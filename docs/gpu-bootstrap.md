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

Tests live in `src/engine/gpuBootstrap.test.ts`.
