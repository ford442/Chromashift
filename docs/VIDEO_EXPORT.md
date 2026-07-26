# Video Export

Chromashift can export deterministic offline video from the GPU compositor. Export pauses live autoplay and the animation loop, renders every frame at a fixed FPS with fixed angle stepping, then encodes the result.

## Usage

1. Open **NUNIF Controls → Video Export**.
2. Set duration, FPS, resolution scale, pass mode, and filename.
3. Choose **Preset Angles** (panel knob values as frame 0) or **Live Angles** (current animation position).
4. When WebCodecs is available, optionally set **Container** (Auto / WebM / MP4) and **Quality** (High / Medium / Low).
5. Click **Export Video**. Progress is shown in-panel; **Cancel** aborts mid-render.

Exported files download as WebM (VP9/VP8) or MP4 (H.264) depending on the active encoding path and browser support.

## Pass modes

| Mode | Output |
|------|--------|
| **Composite** | Full compositor (layers + tracers + blend modes) |
| **Tracers only** | Tracer inspect view (dual ping-pong buffers) |
| **Layers only** | Colour-separated layers without tracer contribution |

Disable **Tracers On** to force a layers-only composite regardless of pass mode.

Side previews ([PREVIEW_VIEWS.md](./PREVIEW_VIEWS.md)) should use the same pass modes at
**preset angles** (`layers.angles`): Separated → `layers`, Tracer → `tracers`.

## Determinism

Given the same:

- source image and renderer settings (layers, tracers, blend modes, luminance),
- **Preset Angles** starting position (`layers.angles` in the panel),
- layer spin rates (`layers.extensions`; FPS-independent — see `extensionStepsForFps`),
- export FPS (tracer decay timing + per-frame angle scaling),
- duration and resolution scale,

…the angle sequence and tracer accumulation are reproducible. Over a fixed duration, total rotation is the same at 20 or 60 FPS; higher FPS only densifies samples. The export path uses `extensionStepsForFps()` then `advanceAnglesBy()` (WASM when enabled, TypeScript fallback otherwise), matching the live loop.

## Encoding paths

Chromashift prefers **WebCodecs** when `VideoEncoder.isConfigSupported()` succeeds at the export resolution. Otherwise it falls back to **MediaRecorder** + manual `requestFrame()` on a hidden canvas.

| Path | When used | Muxer / encoder | Quality controls |
|------|-----------|-----------------|------------------|
| **WebCodecs** (primary) | VP9, VP8, or H.264 encodable at export size | [mediabunny](https://mediabunny.dev/) (`CanvasSource` + `Output`) | Container + Quality (panel) |
| **MediaRecorder** (fallback) | WebCodecs unavailable | Browser-internal mux | Fixed bitrate heuristic |

**mediabunny** (MPL-2.0) is lazy-loaded on first export click — it is not in the initial bundle. `npm run check:dist` asserts the main `index-*.js` chunk contains no `mediabunny` reference.

## Browser codec support matrix

Detection runs via `detectVideoCodecSupport()` (sync, panel bootstrap) and `probeVideoExportCapabilities()` (async, at export resolution) in `src/engine/videoExport/videoCodecs.ts`.

| Browser | WebCodecs (preferred) | MediaRecorder fallback | Typical output | WebGPU export | WebGL export |
|---------|----------------------|------------------------|----------------|---------------|--------------|
| Chrome 113+ | VP9 WebM | VP9 WebM | `video/webm;codecs=vp9` | Yes (primary) | Yes (fallback) |
| Edge 113+ | VP9 WebM | VP9 WebM | `video/webm;codecs=vp9` | Yes | Yes |
| Firefox 128+ | VP8 WebM (when supported) | VP8 WebM | `video/webm` | No stable WebGPU | Yes |
| Safari 17+ | H.264 MP4 | H.264 MP4 | `video/mp4;codecs=avc1` | Limited | Yes |

Notes:

- Export requires **WebCodecs or MediaRecorder**. If neither is available, the Export panel shows an error.
- **WebGL** is supported for CI/demo machines without WebGPU (`?renderer=webgl`).
- Dimensions are rounded to **even** width/height for codec compatibility.

## Architecture

```
ExportPanel → useVideoExport → dynamic import(VideoExporter)
                                    ↓
              probeVideoExportCapabilities(width, height)
                                    ↓
         ┌──────────────────────────┴──────────────────────────┐
         ↓                                                      ↓
exportVideoWebCodecs()                              exportVideoMediaRecorder()
  lazy import('mediabunny')                           hidden canvas + MediaRecorder
         ↓                                                      ↓
         └──────────── exportVideoFrameLoop() ─────────────────┘
                                    ↓
              for each frame: advanceAnglesBy → buildRendererState
                                    ↓
              renderer.exportFrame()  (WebGPU or WebGL)
```

`renderer.exportFrame()` generalizes the existing `exportTracerView` readback pattern: run the full GPU pipeline at export resolution, read RGBA8 pixels, without presenting to the main canvas. After export, `restoreRenderSize()` rebuilds targets at the live canvas size.

## Tests

- `src/engine/videoExport/videoExport.test.ts` — codec helpers, `probeVideoExportCapabilities`, container resolution, and `advanceAnglesBy` determinism.
- `src/engine/videoExport/videoExporter.test.ts` — offline loop harness with fake renderer:
  - **MediaRecorder path** (probe stubbed to fallback): frame count (5s @ 30fps → 150 frames), progress reporting, preset-vs-live start angles, identical angle sequences across runs, cancel via `AbortSignal` (render size restored), tracer exclusion forcing the layers pass.
  - **WebCodecs path** (fake `VideoEncoder` probe + stubbed mediabunny `CanvasSource`/`Output`): frame count, quality option passthrough, cancel restores render size.

## Future work

- PNG frame sequence zip for external ffmpeg workflows
- Optional audio track muxing
