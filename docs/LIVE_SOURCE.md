# Live Source (camera / screen share / video file)

Chromashift's 5-pass separation pipeline was built around decoding a still image once and
uploading it to a GPU texture. Live source support lets a **webcam feed, a shared screen, or
a looping local video file** drive the same pipeline instead — same rotating layers, same
tracer persistence, same audio-reactive/MIDI modulation — by re-uploading the current video
frame into a reused texture every render tick.

## Quick start

Click one of the buttons next to **Browse Images** at the bottom of the canvas:

| Button | Source | Requires |
|--------|--------|----------|
| 📷 Camera | `getUserMedia({ video: true })` | Camera permission prompt |
| 🖥️ Screen | `getDisplayMedia({ video: true })` | Screen/window picker |
| 🎬 Video File | A local video file, looped | File picker (no upload — decoded client-side) |

While a live source is active, the button row collapses to a single **⏹ Stop** button showing
the source kind and current frame resolution. Selecting a still image from the corpus browser,
or clicking Stop, releases the stream/file and returns to the normal image pipeline.

## How it works

- **`LiveSourceManager`** (`src/engine/LiveSource.ts`) owns one `HTMLVideoElement` fed by
  either a `MediaStream` (camera/screen) or a looping local file. Only one source is active at
  a time — starting a new one tears down whatever was running.
- **`TextureManager.updateVideoTexture()`** / **`WebGLTextureManager.updateVideoTexture()`**
  upload the current frame (`copyExternalImageToTexture` on WebGPU, `texImage2D` on WebGL) into
  a texture reused under a single cache key (`LIVE_SOURCE_CACHE_KEY` in
  `src/engine/liveSourceTexture.ts`), recreated only when the frame resolution changes — not
  every frame. No mip chain is generated (the frame is replaced every call, so trilinear
  filtering would be wasted GPU time). This keeps texture memory stable over long sessions
  instead of growing per frame.
- **`useLiveSource`** (`src/hooks/useLiveSource.ts`) owns the manager instance, the
  start/stop handlers, and a dedicated `requestAnimationFrame` loop (mirroring
  `useReactiveInput`'s own loop rather than piggybacking on the main render loop) that:
  1. Uploads the current frame every tick and routes the resulting texture handle through
     `applySourceTexture` — the same path used for still images, so it reaches the primary
     renderer and any active compare/quad slots.
  2. Resamples average luminance (via `computeVideoAverageLuminance`, a video-element variant
     of the existing `computeImageAverageLuminanceWith`) once per second rather than every
     frame — recomputing CR0P band thresholds at 30–60fps would be wasted work for a value
     that only needs to track slow lighting changes.
  3. Publishes `window.liveSourceActive` / `window.liveSourceKind` / `window.liveSourceFps`
     breadcrumbs for automation and diagnostics (`src/engine/liveSourceBreadcrumbs.ts`).
- **`media.liveSource`** (`src/state/types.ts`) is runtime-only reducer state — `active`,
  `kind`, `label`, `width`, `height`, `error`. It is **not** part of the serialized preset
  schema (`ChromashiftSettingsInput` already excludes the rest of `media` for the same
  reason): a `MediaStream`/`HTMLVideoElement` can't round-trip through JSON, so a shared
  preset URL never silently prompts a visitor for camera/screen access.
- While a live source is active, `useImagePlayback`'s corpus-driven effects (texture load on
  index change, autoplay rotation, mask refresh on luminance change) are skipped so they don't
  fight over the source texture.

## Compatible with existing features

- **Audio-reactive + MIDI** modulation applies independently of the texture source (it only
  touches tracer intensity / layer rotation / avg-luminance overrides in the render loop), so
  it works against a live source with no extra wiring.
- **Compare/quad layouts** receive the same live texture on every active slot (one stream
  shared across slots) via the existing `applySourceTexture` routing.
- **WebGL fallback** implements the same `updateVideoTexture` contract, so the video-file path
  works without WebGPU. Camera/screen-share also work on WebGL — there's no backend gate — but
  the video-file path is the one covered by E2E (see below), since CI has no real camera.

## Known limitations (by design, for now)

- Not serialized into presets — reopening a shared preset URL never re-requests camera access.
- One active source at a time; no PiP/multi-camera mixing.
- No `?camera=1` kiosk attract mode yet (tracked as a possible follow-up).

## Testing

- **Unit**: `src/engine/liveSourceTexture.test.ts` (recreate-on-resize decision, pure),
  `src/engine/LiveSource.test.ts` (`LiveSourceManager` source-kind routing — camera,
  screen-share, video-file, teardown-on-switch, `onEnded` — against a minimal stubbed
  `document`/`navigator`/`URL`, since this repo's Vitest config runs in the `node`
  environment without jsdom), `src/state/liveSourceActions.test.ts` (reducer + action).
- **E2E**: `e2e/live-source.spec.ts` drives the video-file path with a checked-in ~4KB VP8
  fixture (`e2e/fixtures/live-source-test.webm` — VP8/WebM rather than H.264/MP4 so it decodes
  on the open-source Chromium builds Playwright ships, which lack proprietary codec support).
  No real camera/screen-share coverage in CI, per the acceptance criteria — those paths are
  manually verified.
