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

## Motion field (temporal tracers)

The tracer system was built around a **spatial** test: the persistence pass samples the three
layer textures at one UV, counts how many have visible colour, and stamps when 2+ overlap. It has
no notion of *what changed since the last frame* — feed it a still and a video and it treats them
identically. On a live feed that throws away the most interesting signal there is.

`tracers.motionMode` adds the missing axis.

### The `motion-field` chore

`runJob({ op: 'motion-field', … })` (`src/engine/compute/chores/`) turns the current source frame
into a **quarter-resolution magnitude field**: box-average BT.709 luminance over each 4×4 block,
difference it against the previous frame's luminance for the same cell, subtract a noise floor and
rescale the remainder. At 1080p that is a 480×270 field — about 1/16 of a full-resolution pass,
over a texture the GPU is already holding.

The lane owns the previous frame's luminance, so a caller only ever hands over the *current*
frame; there is no full-resolution history copy anywhere.

| Lane | Input | Output | Notes |
|---|---|---|---|
| `webgpu` | the source `GPUTexture` | an `rgba16float` `GPUTexture` | r = magnitude, gb = flow vector (zero at this stage), a = 1. **Never read back.** Summary statistics accumulate into a 16-byte buffer that is mapped on a slow cadence, not per frame. |
| `wasm` | decoded RGBA pixels | `Float32Array` | Only when the host supplies a WASM motion kernel; Chromashift's does not yet, so this lane declines with a recorded reason and `auto` slides to `ts`. |
| `ts` | decoded RGBA pixels | `Float32Array` | The portable reference (`chores/motionKernel.ts`) the WGSL kernel mirrors — and what the WebGL backend and headless CI actually run. |

Lane selection, the pinned-lane rule and the no-silent-skip contract are the facade's, unchanged:
a pinned `prefer` never slides, and a total failure returns `{ ok: false, reason, attempts }`.

Breadcrumbs follow the `gpuChoreBackend` convention one pair of globals down, because motion runs
on the render loop's cadence and must not stamp over the load-time analysis crumb:

- `window.motionFieldBackend` — `webgpu` / `ts-inline` / `wasm-inline` / `null`.
- `window.motionFieldReason` — why no lane took the job, or `null` on success.
- `window.motionFieldEnergy` — the field's mean magnitude, in `[0,1]`. **Zero on a still source**
  (a frame differenced against itself is zero everywhere), non-zero on a moving one. This is the
  only number that crosses back to the CPU on the WebGPU lane.

### Where it runs

- **WebGPU** — `MotionFieldPass` encodes the compute dispatch into the frame's own
  `GPUCommandEncoder`, right after the layer passes and before persistence, and hands
  `PersistencePass` the field texture. It shows in the Perf HUD as its own **Motion** row.
- **WebGL** — there is no compute lane, so `useLiveSource`'s tick loop samples the video element
  into a canvas *already at field resolution* (one `drawImage` the browser box-filters), runs the
  chore's CPU lane, and uploads the resulting `Float32Array` into a quarter-scale `R16F` texture
  via `WebGLRenderer.setMotionField()`. Throttled to ~15 Hz: a trail that holds for hundreds of
  milliseconds does not need a fresh difference every frame, and `getImageData` is the one part
  of that loop that is not free.

With `motionMode: 'off'` neither path runs at all — nothing is sampled, nothing is uploaded, and
no dispatch is encoded.

### The parameters

| Setting | Default | What it does |
|---|---|---|
| `motionMode` | `off` | `off` / `boost` / `gate` / `direction` (see below). |
| `motionGain` | `1` | How strongly motion boosts a fresh stamp: `1 + gain × magnitude`. |
| `motionDecayBias` | `0.5` | How much motion *slows* local decay: `decayMod × (1 − bias × magnitude)`. This is the term that reads as a comet tail rather than a global fade. |
| `motionThreshold` | `0.04` | Noise floor on the normalised luminance difference, applied when the field is produced — so sensor grain in a dark webcam frame does not light the whole field up. |

Modes:

- **`off`** — no temporal term. The default, and the regression bar: see below.
- **`boost`** — moving regions stamp brighter and hold their trail longer.
- **`gate`** — a stamp survives *only* where the frame changed. On a live feed that isolates the
  subject from the background with no segmentation model at all.
- **`direction`** — flow angle drives hue, magnitude drives intensity. The frame-difference stage
  writes a zero flow vector, so today this reads as a magnitude tint; the encoding is already in
  place for a block-matching / Lucas–Kanade stage to fill `gb` in.

### `off` is the old pipeline, not a reproduction of it

The motion term is emitted as a **separate shader variant** rather than a branch inside the
existing one (`emitCoincidenceDecayWgsl(n, { motion: true })`, and its GLSL twin
`emitCoincidenceDecayGlsl`). With `motionMode: 'off'` both renderers bind the original program,
the original bind-group layout, and no motion texture anywhere in the frame — so "off is pixel
identical" is a fact about which program is bound, not a claim about floating-point luck.

`src/engine/graph/__golden__/` still pins the non-motion emission against the pre-refactor
sources; `src/engine/shaders/motionPersistence.test.ts` pins the other half, that the variant is
opt-in and leaves the default emission byte-identical on both backends. A still source is a second
safety net: its field is uniformly zero, so even `boost` is a no-op there.

Presets are versioned: schema **v5** added these four fields, and a v1–v4 document migrates with
`motionMode: 'off'` — the mode that renders exactly what the preset was saved as.

## Known limitations (by design, for now)

- Not serialized into presets — reopening a shared preset URL never re-requests camera access.
  (The *tracer motion* settings are serialized; the source itself is not.)
- One active source at a time; no PiP/multi-camera mixing.
- No `?camera=1` kiosk attract mode yet (tracked as a possible follow-up).
- The motion field is a frame **difference**, not optical flow: it knows how much a region
  changed, not which way it moved. `direction` mode is wired end to end against a zero flow
  vector, waiting on a block-matching / Lucas–Kanade stage.
- No WASM motion kernel yet — the `wasm` lane declines and `auto` lands on `ts`.

## Testing

- **Unit**: `src/engine/liveSourceTexture.test.ts` (recreate-on-resize decision, pure),
  `src/engine/LiveSource.test.ts` (`LiveSourceManager` source-kind routing — camera,
  screen-share, video-file, teardown-on-switch, `onEnded` — against a minimal stubbed
  `document`/`navigator`/`URL`, since this repo's Vitest config runs in the `node`
  environment without jsdom), `src/state/liveSourceActions.test.ts` (reducer + action).
- **Unit (motion)**: `src/engine/compute/chores/motionKernel.test.ts` (the portable kernel:
  box-averaging, the noise floor, history drops), `src/engine/compute/chores/runtime.test.ts`
  (`motion-field` lane selection, the pinned-lane and no-silent-skip contracts, per-op
  breadcrumbs), `src/engine/motionModes.test.ts`, `src/engine/shaders/motionPersistence.test.ts`
  (the `off`-is-unchanged guarantee), `src/state/serializeSettings.test.ts` (schema v5 migration).
- **E2E**: `e2e/live-source.spec.ts` drives the video-file path with a checked-in ~4KB VP8
  fixture (`e2e/fixtures/live-source-test.webm` — VP8/WebM rather than H.264/MP4 so it decodes
  on the open-source Chromium builds Playwright ships, which lack proprietary codec support).
  No real camera/screen-share coverage in CI, per the acceptance criteria — those paths are
  manually verified. Two more fixtures cover the motion field: `live-source-motion.webm` (a disc
  tracking across a static checkerboard) must produce a non-zero `window.motionFieldEnergy`, and
  `live-source-still.webm` (the same scene with the disc parked) must stay at zero. Both were
  generated from deterministic canvas frames; regenerate them the same way if the scene ever
  needs to change.
