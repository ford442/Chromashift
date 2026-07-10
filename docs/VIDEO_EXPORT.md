# Video Export

Chromashift can export deterministic offline video from the GPU compositor. Export pauses live autoplay and the animation loop, renders every frame at a fixed FPS with fixed angle stepping, then encodes via **MediaRecorder** and manual `requestFrame()` on a hidden canvas.

## Usage

1. Open **NUNIF Controls → Video Export**.
2. Set duration, FPS, resolution scale, pass mode, and filename.
3. Choose **Preset Angles** (panel knob values as frame 0) or **Live Angles** (current animation position).
4. Click **Export Video**. Progress is shown in-panel; **Cancel** aborts mid-render.

Exported files download as WebM (VP9/VP8) or MP4 (H.264) depending on browser support.

## Pass modes

| Mode | Output |
|------|--------|
| **Composite** | Full compositor (layers + tracers + blend modes) |
| **Tracers only** | Tracer inspect view (dual ping-pong buffers) |
| **Layers only** | Colour-separated layers without tracer contribution |

Disable **Tracers On** to force a layers-only composite regardless of pass mode.

## Determinism

Given the same:

- source image and renderer settings (layers, tracers, blend modes, luminance),
- **Preset Angles** starting position (`layers.angles` in the panel),
- per-frame extensions (`layers.extensions`),
- export FPS (used for tracer decay timing),
- duration and resolution scale,

…the angle sequence and tracer accumulation are reproducible. The export path uses `advanceAnglesBy()` (WASM when enabled, TypeScript fallback otherwise), matching the live loop’s stepping semantics.

## Browser codec support matrix

Detection runs via `detectVideoCodecSupport()` in `src/engine/videoExport/videoCodecs.ts`.

| Browser | MediaRecorder | Typical MIME | WebCodecs `VideoEncoder` | WebGPU export | WebGL export |
|---------|---------------|--------------|--------------------------|---------------|--------------|
| Chrome 113+ | Yes | `video/webm;codecs=vp9` | Yes | Yes (primary) | Yes (fallback) |
| Edge 113+ | Yes | `video/webm;codecs=vp9` | Yes | Yes | Yes |
| Firefox 128+ | Partial | `video/webm` (VP8) | Limited | No stable WebGPU | Yes |
| Safari 17+ | Yes | `video/mp4;codecs=avc1` | Yes (recent) | Limited | Yes |

Notes:

- **MediaRecorder** is required for export today. If no MIME type is supported, the Export panel shows an error.
- **WebCodecs** is detected but not yet used for muxing; future work can add an offline `VideoEncoder` path for higher quality.
- **WebGL** is supported for CI/demo machines without WebGPU (`?renderer=webgl`).
- Dimensions are rounded to **even** width/height for codec compatibility.

## Architecture

```
ExportPanel → useVideoExport → VideoExporter.exportVideo()
                                    ↓
              for each frame: advanceAnglesBy → buildRendererState
                                    ↓
              renderer.exportFrame()  (WebGPU or WebGL)
                                    ↓
              hidden canvas + captureStream(0) + MediaRecorder
```

`renderer.exportFrame()` generalizes the existing `exportTracerView` readback pattern: run the full GPU pipeline at export resolution, read RGBA8 pixels, without presenting to the main canvas. After export, `restoreRenderSize()` rebuilds targets at the live canvas size.

## Future work

- WebCodecs `VideoEncoder` + WebM/MP4 muxer for frame-accurate offline encoding
- PNG frame sequence zip for external ffmpeg workflows
- Optional audio track muxing
