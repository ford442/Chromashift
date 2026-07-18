# Compare & Multi-View Layouts

Researchers comparing CR0P bands, tracer modes, and blend modes need **side-by-side** views without screenshot juggling. This document defines the planned layout modes, how they map to today's codebase, and the implementation order.

**Status:** planned (after renderer pass modularization and preset plumbing are stable). Foundation types live in `src/engine/compareViews.ts`.

## Layout concepts

| Mode | Description | Primary use |
|------|-------------|-------------|
| **Single** | Current default — one main canvas + optional reference overlay | Production / kiosk |
| **Dual (2-up)** | Same source image, two independent `RendererState`s (preset A vs B) | A/B tracer or blend comparison |
| **Quad** | Original \| Layers \| Tracer \| Composite in one grid | Promote today's preview strip to first-class layout |
| **Swipe / split** | Generalize reference `split` blend to preset A \| preset B | Quick swipe between two full composites |

### Animation clocks

| Toggle | Behaviour |
|--------|-----------|
| **Sync play on** (default in dual) | One shared angle clock — layers rotate in lockstep; only tracer/layer/colour settings differ |
| **Sync play off** | Independent `animAnglesRef` per slot — compare different rotation rates |

Image selection and autoplay remain **shared** (one corpus index); only render parameters differ per slot.

## What exists today

| Building block | Location | Reuse for multi-view |
|----------------|----------|----------------------|
| Reference split overlay | `AppUI.tsx` + `ui.referenceBlendMode === 'split'` | Pattern for 50/50 viewport clip |
| Compare composite pass | `TracerInspectPass` + `compareFragmentSource` | `MAIN_VIEW_MODES.COMPARE_*` — source vs composite in **one** renderer |
| Preview strip (Original / Separated / Composite) | `previewOriginalRef`, `previewSeparatedRef`, `canvasRef` + throttled readback | Quad layout replaces floating previews with equal grid cells |
| Preset snapshots | `serializeSettings` / `ChromashiftSettingsInput` | Slot A/B settings bags |
| `buildRendererState()` | `src/engine/buildRendererState.ts` | Call once per slot with different `ChromashiftState` overlays |

**Gap:** all of the above share **one** `ChromashiftRenderer` and one animation loop. Dual/quad requires **N render targets per frame** (or N renderer instances on one `GPUDevice`).

## Technical design

### One device, many canvases (WebGPU)

```
GPUDevice (single bootstrap)
├── TextureManager (shared source texture per image URL)
├── RendererInstance[slot A] → canvas A → WebGPUCanvasContext A
├── RendererInstance[slot B] → canvas B → WebGPUCanvasContext B
└── …
```

- **Do not** create multiple adapters/devices.
- Each `WebGPURenderer` owns its own layer/tracer ping-pong textures sized to **its** canvas.
- **Share** `GPUTexture` for the decoded source image (and classification mask when enabled) across slots.
- Configure each context with the same `GPUDevice` from `WebGpuSession`.

WebGL fallback: dual mode may be WebGPU-only initially (memory + duplicate FBO cost).

### GPU memory budget

When `activeViewCount > 1`, automatically scale internal targets:

```ts
import { effectiveLayerScaleForMultiView, multiViewPerformanceNote } from './compareViews';

const { scale, reduced } = effectiveLayerScaleForMultiView(layers.scale, layout);
// Pass `scale` as layerScale override per renderer; show multiViewPerformanceNote(layout) in UI when reduced
```

Default factors (tunable):

| Layout | Layer scale factor | Active GPU views |
|--------|-------------------|------------------|
| single | 1.0 | 1 |
| dual | 0.75 | 2 |
| swipe | 0.85 | 2 |
| quad | 0.60 | 4 |

Tracer scale should use the same factor. Show an amber banner in the Viewport panel when `reduced === true`.

### State model (planned)

```ts
// ui.compareView: CompareViewState from compareViews.ts
{
  layout: 'dual',
  syncPlay: true,
  swipePosition: 0.5,
  slotA: { id: 'a', label: 'Preset A', settings: { tracers: { … } } },
  slotB: { id: 'b', label: 'Preset B', settings: { tracers: { … } } },
}
```

Apply slot settings by merging `ChromashiftSettingsInput` over base state before `buildRendererState()` for each canvas.

### Render loop (planned)

```ts
for (const slot of activeSlots) {
  const angles = syncPlay ? sharedAngles : slotAngles[slot.id];
  const state = buildRendererState(mergeSlot(state, slot), angles, {
    layerScale: effectiveLayerScaleForMultiView(baseScale, layout).scale,
    mainViewMode: slot.mainViewMode ?? MAIN_VIEW_MODES.PROCESSED_COMPOSITE,
  });
  renderers[slot.id].render(state, fps);
}
```

Readback / collision stats: **slot A only** (or disable in multi-view).

## Phased rollout

### Phase 1 — Dual 2-up (acceptance target)

- [x] Viewport panel: layout `Dual` toggle
- [x] Second main canvas, 50/50 grid in `AppUI`
- [x] Second `WebGPURenderer` on same device; shared `TextureManager`
- [x] Load preset into slot B from Presets panel ("Compare with…")
- [x] **Sync play** toggle in Viewport panel
- [x] Performance note when layer scale auto-reduced

### Phase 2 — Swipe split

- [ ] Drag handle between A/B composites (generalize reference split)
- [ ] `swipePosition` uniform or CSS clip on two full canvases

### Phase 3 — Quad grid

- [ ] Replace floating previews when quad active
- [ ] Fixed cells: Original, Layer 0 (or cycle), Tracer, Composite
- [ ] Optional: per-cell diagnostic mode

### Phase 4 — Research

- WebXR: composite to `XRWebGLLayer` / WebGPU-XR when interop matures (see issue #85)
- MIDI / controller → layer extension rates

## Recommended hardware (multi-view)

| Layout | Minimum | Notes |
|--------|---------|-------|
| Dual 1080p | Chrome 113+, 4 GB VRAM | Auto layer scale ×0.75 |
| Dual 4K | 8 GB VRAM discrete GPU | Consider `tracerScale` 0.75 manually |
| Quad 1080p | 6 GB+ VRAM | layer scale ×0.6; disable live readback |

Same browser guidance as [gpu-bootstrap.md](./gpu-bootstrap.md). Use Diagnostics **Perf HUD** to confirm frame budget.

## Related docs

- [PRESETS.md](./PRESETS.md) — slot A/B preset payloads
- [webgl-fallback.md](./webgl-fallback.md) — WebGL may not support dual GPU path
- [KIOSK.md](./KIOSK.md) — incompatible with multi-view until explicitly supported
