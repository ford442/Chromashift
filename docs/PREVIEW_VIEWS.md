# Preview & View Hierarchy

Chromashift exposes several simultaneous views of the same source image. They serve
different analytical roles. **Only the main viewport canvas animates layer rotation**;
side previews are **stationary reference frames** in source-image orientation so users
can read colour bands and coincidence geography without the image spinning.

This document is the canonical definition of each view's objective. Multi-view layout
plans in [COMPARE_VIEWS.md](./COMPARE_VIEWS.md) and quad cell definitions in
`src/engine/compareViews.ts` (`QUAD_VIEW_CELLS`) must follow these rules.

## Design principle

| Concern | Main viewport | Side previews (strip / quad reference cells) |
|---------|---------------|-----------------------------------------------|
| Layer rotation | Live — driven by `animAnglesRef` + `layers.extensions` | **Fixed** — render at panel **preset angles** (`layers.angles`, default `[0, 0, 0]`) |
| Purpose | Performance / exploration | Read colour mapping and spatial alignment |
| Update rate | Every frame | On image or settings change only (not every animation tick) |
| Tracers | Live accumulation from rotating layers | Separate stationary render (or frozen snapshot), not a downscale of the live rotating composite |

Video export's **Preset Angles** toggle (`usePresetAngles` in [VIDEO_EXPORT.md](./VIDEO_EXPORT.md))
uses the same preset-angle concept for offline frames. Side previews should behave like
a single still frame exported with preset angles, not like **Live Angles**.

## View catalog

| View | UI label (target) | Objective | Stationary? | Pass / source |
|------|-------------------|-----------|-------------|---------------|
| **Original** | Original | Unmodified source pixels for before/after comparison | Yes | 2D `drawImage` of decoded URL (`previewOriginalRef`) |
| **Separated** | Separated | CR0P colour-band output — which luminance ranges map to which layer colours | Yes | GPU **layers** pass at preset angles, no tracers (`ExportPassMode: 'layers'`) |
| **Tracer** | Tracer | Where 2+ layer bands coincide in **image space** — alignment / persistence geography | Yes | GPU **tracers** inspect view at preset angles (`ExportPassMode: 'tracers'` or `MAIN_VIEW_MODES.FULL_RES_TRACER` without live rotation) |
| **Main composite** | *(main canvas)* | Full live show — rotating layers, live tracer decay, blend modes | **No** | Full 5-pass pipeline to swapchain (`mainCanvasRef`) |

The floating preview strip (`PreviewStrip.tsx`) implements Original, Separated, and Tracer thumbnails (`previewTracerRef`).

## Preview strip (floating panels)

Hidden in kiosk mode ([KIOSK.md](./KIOSK.md)). Three 300×300 canvases on the right edge.

### Original (`previewOriginalRef`)

- **Objective:** Show the loaded image exactly as decoded — no colour separation, no rotation.
- **Updates when:** Current image changes, upscale/replace source, drag-drop load.
- **Implementation:** CPU 2D canvas in `useImagePlayback` / `useMediaHandlers` / `useAppWebGPUInit`.

### Separated (`previewSeparatedRef`)

- **Objective:** Answer "what colour did this pixel get?" without motion. Displays the
  three colour-band layers composited at **preset angles**, with tracer contribution off.
- **Updates when:** Image changes, `avgLuminance`, colour mode, band/Sobel/soft-crop toggles,
  layer opacity/blend — **not** on every animation frame.
- **Must not:** Mirror the live main canvas or follow `animAnglesRef`.

### Tracer (`previewTracerRef`)

- **Objective:** Answer "where do the bands line up?" — a stationary map of coincidence
  / persistence in source orientation. Users compare this geography against the rotating
  main canvas to understand what the live tracer is recording.
- **Updates when:** Image changes, tracer mode/intensity/duration/threshold settings change,
  or an explicit refresh — optionally throttled. `tracerPreviewFrozen` pauses updates; it
  does **not** by itself fix orientation (that requires a separate preset-angle render).
- **Must not:** Be a throttled downscale of the live rotating compositor (current bug).

### Strip controls

| Control | Intended behaviour |
|---------|-------------------|
| **Preview On / Off** | Enable/disable throttled tracer preview refresh (GPU budget) |
| **Live / Frozen** | Pause tracer thumbnail updates while keeping the last stationary frame |

## Main viewport

The large centre canvas (`mainCanvasRef` in `MainViewport.tsx`) is the **only** view
that should rotate and flip layers in real time.

- Default mode: `MAIN_VIEW_MODES.PROCESSED_COMPOSITE` — full compositor + live tracers.
- **Pause** stops angle advancement; tracers continue to decay (`RendererState.paused`).
- **Viewport panel** modes (full-res tracer inspect, source image, per-layer isolation,
  heatmap, compare splits, etc.) replace the main canvas output temporarily — see
  `src/engine/viewModes.ts`. These are inspector tools on the main canvas, not side previews.

### Dual compare layout (exception)

When `ui.compareView.layout === 'dual'`, **both** main canvases (slot A and slot B) animate
rotation. That mode compares two **presets** in motion, not reference stills. Side preview
strip rules above still apply to the floating thumbnails.

### Quad layout (planned)

`QUAD_VIEW_CELLS` in `compareViews.ts` maps four equal cells:

| Cell | Mode | Rotation |
|------|------|----------|
| Original | `SOURCE_IMAGE` | Stationary |
| Layers | `LAYER_0` (or cycle) | Stationary at preset angles |
| Tracer | `FULL_RES_TRACER` | Stationary at preset angles |
| Composite | `PROCESSED_COMPOSITE` | **Live** (only this cell) |

## Implementation status

| View | Spec | Current behaviour | Gap |
|------|------|-------------------|-----|
| Original | Stationary source | Stationary 2D decode | ✅ Aligned |
| Separated | Stationary layers at preset angles | Isolated GPU `layers` pass via `StationaryPreviewRenderer` | ✅ Aligned |
| Tracer | Stationary tracer map at preset angles | Isolated warmup + tracers pass; UI label **Tracer** | ✅ Aligned |
| Main canvas | Live rotating composite | Live swapchain render (`mainCanvasRef`) | ✅ Aligned |

### Implementation notes

- `useStationaryPreviews` refreshes Separated + Tracer on image/settings fingerprint changes.
- Tracer thumbnail optionally refreshes every 2s when **Preview On** and not **Frozen**.
- Isolated preview GPU resources do not disturb live main-canvas persistence.

## Related docs

- [COMPARE_VIEWS.md](./COMPARE_VIEWS.md) — dual / quad / swipe layouts
- [VIDEO_EXPORT.md](./VIDEO_EXPORT.md) — pass modes and preset vs live angles
- [KIOSK.md](./KIOSK.md) — previews hidden in installation mode
