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
| `webgpu` | the source `GPUTexture` | an `rgba16float` `GPUTexture` | r = magnitude, gb = flow vector, a = 1. **Never read back.** Summary statistics accumulate into a 16-byte buffer that is mapped on a slow cadence, not per frame. |
| `wasm` | decoded RGBA pixels | `Float32Array` (+ a flow `Float32Array`) | `computeMotionFlow` in `cpp/chromashift_engine.cpp`, called through `wasm/dispatch/motion.ts`. Declines when the module is not loaded, and `auto` slides to `ts`. |
| `ts` | decoded RGBA pixels | `Float32Array` (+ a flow `Float32Array`) | The portable reference (`chores/motionKernel.ts`) the WGSL kernel and the C++ kernel both mirror — and what the WebGL backend and headless CI actually run. |

Lane selection, the pinned-lane rule and the no-silent-skip contract are the facade's, unchanged:
a pinned `prefer` never slides, and a total failure returns `{ ok: false, reason, attempts }`.

Breadcrumbs follow the `gpuChoreBackend` convention one pair of globals down, because motion runs
on the render loop's cadence and must not stamp over the load-time analysis crumb:

- `window.motionFieldBackend` — `webgpu` / `ts-worker` / `ts-inline` / `wasm-worker` / `wasm-inline` /
  `null`. The `-worker` suffix means the kernel ran in `motion.worker.ts`; `-inline` means it ran on
  the calling thread (Vitest, the parity tests, or the fallback after a worker failure).
- `window.motionFieldReason` — why no lane took the job, or `null` on success.
- `window.motionFieldEnergy` — the field's mean magnitude, in `[0,1]`. **Zero on a still source**
  (a frame differenced against itself is zero everywhere), non-zero on a moving one. This is the
  only number that crosses back to the CPU on the WebGPU lane.
- `window.motionFieldHasFlow` — `true` when `gb` carries a solved velocity rather than the zero
  vector. This is how automation tells Stage 1 from Stage 2 without inspecting pixels: `direction`
  renders a magnitude tint on a Stage 1 field and a real hue sweep on a Stage 2 one.
- `window.motionFieldFlow` — `{ meanVx, meanVy, meanSpeed, movingCells }` over the cells that
  cleared the minimum speed, in cells per frame. **CPU lanes only** — on the WebGPU lane the field
  never leaves the GPU, and `motionFieldHasFlow` is the whole story there.

### Where it runs

- **WebGPU** — `MotionFieldPass` encodes the compute dispatch into the frame's own
  `GPUCommandEncoder`, right after the layer passes and before persistence, and hands
  `PersistencePass` the field texture. It shows in the Perf HUD as its own **Motion** row.
- **WebGL** — there is no compute lane, so `useLiveSource`'s tick loop samples the video element
  into a canvas *already at field resolution* (one `drawImage` the browser box-filters), hands the
  pixels to the chore's CPU lane, and uploads the result into a quarter-scale texture via
  `WebGLRenderer.setMotionField()` — `R16F` for magnitude alone, `RGB16F` while `direction` needs
  the velocity too. Throttled to ~15 Hz: a trail that holds for hundreds of milliseconds does not
  need a fresh difference every frame, and `getImageData` is the one part of that loop that is not
  free. The kernel itself runs in `motion.worker.ts`, so the tick loop pays for the downsample and
  nothing else.

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
- **`direction`** — flow angle drives hue, magnitude drives intensity. This is the mode the optical
  flow below exists for, and the only one that pays for it.

### Optical flow (Stage 2)

`direction` needs a velocity, not a magnitude, so the same `motion-field` op grows a second stage
behind the `flow` flag on the job. `off`, `boost` and `gate` never set it, never allocate its
textures, and never compile its shaders.

**The algorithm is coarse-to-fine Lucas–Kanade** over the low-resolution luminance planes the frame
difference already builds: a half-resolution level with no displacement guess, then a
field-resolution level seeded by that level's answer doubled. Each level solves a 2×2 system over a
3×3 window from central-difference spatial gradients and a warped temporal difference.

It was chosen over block matching because it is a fixed, branch-free arithmetic sequence. Three
implementations have to agree — WGSL, C++/SIMD128 and portable TypeScript — and a closed-form solve
issued in the same operation order in all three is something a fixture can actually pin. A
block-matching search would have been an argmin with tie-breaking, which is far harder to keep
identical across a shader, a vector kernel and a scalar reference.

Two tuning decisions are worth knowing:

- **A Tikhonov ridge replaces the singular-system branch.** A straight edge gives a singular 2×2
  system (the aperture problem). Adding `0.05 × (Ixx + Iyy)` to the diagonal makes it positive
  definite unconditionally — `det ≥ ridge × (Ixx + Iyy) + ridge²` — so there is no branch to take,
  every GPU lane runs one instruction stream, and an edge degrades to *normal flow* rather than to
  zero. Normal flow is the component a hue can honestly show anyway.
- **`MOTION_FLOW_MIN_SPEED` gates the hue, not the solve.** Below it the shaders pin the hue to
  zero, which is exactly what a Stage 1 field (a zero vector everywhere, so `atan2(0, 0)`) rendered.
  A preset saved against the frame-difference-only build therefore keeps its magnitude tint.

Where the extra work lands:

- **WebGPU** — two more compute dispatches in the same frame encoder, writing a second
  `rgba16float` texture whose `r` is the Stage 1 magnitude copied through unchanged and whose `gb`
  is the velocity. `PersistencePass` binds that texture instead; the binding layout does not move.
  Both are `rgba16float` rather than the narrower `rg16float`, which is not a core storage format.
  The Perf HUD splits them out as their own **Flow** row so a `direction`-mode jump is attributable.
- **CPU** — in `motion.worker.ts`. At 4K the field is 960×540 cells and the solve is millions of
  multiply-adds; the main thread keeps only the `drawImage` into a field-resolution canvas and the
  `getImageData` that reads it back (the #150 lesson — never `getImageData` on rAF). Inside the
  worker the kernel is `computeMotionFlow` from the C++ engine when the WASM module loaded, and the
  portable TypeScript otherwise. Lane selection stays on the main thread, so the breadcrumbs above
  still say which lane served the frame and why the other declined.
- **WebGL** — the field texture becomes `RGB16F` (magnitude, vx, vy) instead of `R16F` while
  `direction` is selected, and goes back to `R16F` for every other mode. Both are
  texture-filterable in WebGL2 core.

One fixture, four lanes: a translating triangular-ridge "bar" whose every constant is exactly
representable in binary floating point. `motionKernel.test.ts` pins the golden vectors,
`cpp/tests/test_engine.cpp` checks the C++ scalar bodies against the same numbers,
`npm run bench:wasm` runs them through the shipped SIMD128 build — the only place the vector
coarse level is executed at all, since the host `g++` build compiles the scalar bodies — and
`e2e/motion-flow-parity.spec.ts` runs the WGSL passes on a real device against their own textures,
which is also the only thing in CI that *compiles* them.

The tolerance is `2e-3` between the CPU lanes, and it is not zero because the TypeScript reference
accumulates in JavaScript doubles while the shader and the C++ kernel accumulate in float32. The
WGSL lane is checked at `5e-3` because its output is read back through an `rgba16float` texture,
and one half-precision ulp near 2.0 is already about `0.001`.

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
- Flow is solved at *field* resolution (quarter scale) and clamped to ±4 cells per frame. A subject
  crossing the frame faster than that reads as moving at the clamp, not at its true speed — the
  angle stays right, which is what hue uses.
- A region with structure in only one direction (a straight edge) reports **normal flow**, the
  component along its gradient. That is the aperture problem, not a bug: an edge sliding along
  itself genuinely carries no observable direction.
- The flow is per-frame and memoryless. There is no track, no smoothing, and no subject identity —
  a comet tail follows the *local* velocity, not a person.

## Testing

- **Unit**: `src/engine/liveSourceTexture.test.ts` (recreate-on-resize decision, pure),
  `src/engine/LiveSource.test.ts` (`LiveSourceManager` source-kind routing — camera,
  screen-share, video-file, teardown-on-switch, `onEnded` — against a minimal stubbed
  `document`/`navigator`/`URL`, since this repo's Vitest config runs in the `node`
  environment without jsdom), `src/state/liveSourceActions.test.ts` (reducer + action).
- **Unit (motion)**: `src/engine/compute/chores/motionKernel.test.ts` (the portable kernel:
  box-averaging, the noise floor, history drops, and the Lucas–Kanade golden vectors),
  `src/engine/compute/chores/motionFlowShader.test.ts` (the WGSL passes spell the shared LK
  constants rather than a second hand-copied set), `src/engine/compute/chores/runtime.test.ts`
  (`motion-field` lane selection, the pinned-lane and no-silent-skip contracts, per-op
  breadcrumbs, and that flow is solved only when asked for),
  `src/engine/motionModes.test.ts`, `src/engine/shaders/motionPersistence.test.ts`
  (the `off`-is-unchanged guarantee and the hue gate), `src/state/serializeSettings.test.ts`
  (schema v5 migration).
- **Unit (motion, C++)**: `cpp/tests/test_engine.cpp` covers `computeMotionFlow` against the same
  golden vectors — zero on identical planes, the right sign on a translating bar, a sign flip when
  the frames swap, and an odd-sized plane so the half-resolution level's clipped trailing row is
  exercised. `npm run bench:wasm` re-runs the fixture through the SIMD128 build and gates its
  throughput.
- **E2E**: `e2e/live-source.spec.ts` drives the video-file path with a checked-in ~4KB VP8
  fixture (`e2e/fixtures/live-source-test.webm` — VP8/WebM rather than H.264/MP4 so it decodes
  on the open-source Chromium builds Playwright ships, which lack proprietary codec support).
  No real camera/screen-share coverage in CI, per the acceptance criteria — those paths are
  manually verified. Two more fixtures cover the motion field: `live-source-motion.webm` (a disc
  tracking across a static checkerboard) must produce a non-zero `window.motionFieldEnergy`, and
  `live-source-still.webm` (the same scene with the disc parked) must stay at zero. Both were
  generated from deterministic canvas frames; regenerate them the same way if the scene ever
  needs to change. The same moving fixture also covers Stage 2: `direction` must report
  `window.motionFieldHasFlow === true` and a non-zero mean velocity, and `boost` must report
  `false` — which is the "flow is opt-in per mode" claim, checked in a browser rather than asserted.
- **E2E (motion, WebGPU)**: `e2e/motion-flow-parity.spec.ts` runs in the `chromium-webgpu` project
  and compiles the two flow passes against a real device, comparing them to the portable kernel on
  the shared fixture. Nothing else in CI compiles that WGSL.
