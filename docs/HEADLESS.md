# Headless renderer

The pass graph, rendered in Node: no browser, no canvas, no GPU required.
`bin/chromashift` renders a settings document over an image (or a folder of
them) to a clip, a still or a PNG sequence, and the `gpu` Vitest project pins
the graph's frames as pixel goldens. Issue #228, part C.

It is not a second renderer. A headless session is the page's own bootstrap —
`RendererOrchestrator`, the adapter gate, `TextureManager`, the chore lanes,
`WebGPURenderer` and `WebGpuGraphExecutor` — on Dawn's `navigator.gpu`, with an
offscreen surface where the canvas context was. A clip is the browser's video
export loop, unchanged. On the rasterizer the E2E suite draws with, the frames
are the browser's byte for byte (see [Parity](#parity-with-the-browser)).

## Quick start

Needs a Vulkan driver. A machine with a GPU has one. On a GPU-less Linux box,
Mesa's lavapipe works (`sudo apt-get install mesa-vulkan-drivers`). `ffmpeg`
is optional. Without it, `render` writes PNGs.

```bash
npm install                       # webgpu (Dawn), sharp, pixelmatch, pngjs: devDependencies
npx chromashift render examples/cr0p.json --image examples/sweep.png --frames 90 --out out/cr0p.mp4
npx chromashift still  examples/cr0p.json --image photo.jpg --out out/photo.png
npx chromashift render '?preset=eyJ2ZXJza…' --image gallery/ --frames 150 --out out/gallery.webm
npx chromashift golden            # compare against src/headless/__golden__ (SwiftShader)
npm run test:gpu                  # the gpu Vitest project: goldens + browser parity
```

The CLI runs inside a checkout. `bin/chromashift.mjs` loads `src/headless/cli.ts`
through Vite's SSR module loader, the same transform the dev server applies,
so what renders is the code in the tree. There is no build step and no
published package. That costs about 4–5 s of startup, before the first frame.

## Commands

| Command | Does |
|---|---|
| `render [settings] --image <file\|folder> --out <clip.mp4\|clip.webm\|frames/>` | A clip: `--frames` frames per image, images in name order, one encoder for the lot |
| `still [settings] --image <file> --out <still.png>` | Renders `--frames` frames (default 30, so tracers build up) and writes the last |
| `golden [--update]` | Renders every [golden case](#goldens) and compares it, or rewrites the PNGs |

`[settings]` is a settings document (the JSON the Presets panel exports, any
schema version the app reads) or a `?preset=` share: the whole URL, the query,
or the bare value. It goes through the page's own decoder and `settings/apply`,
so a preset means here what it means in a tab, and any field the decoder
clamped or dropped is printed. Without one, the session defaults.

| Option | |
|---|---|
| `-i, --image <path>` | Source image or folder (`.png .jpg .jpeg .webp .avif .gif .tif .tiff`) |
| `-g, --graph <name>` | `default`, `blur`, `warp`, `smear`, `feedback`, `trails3` (the `?graph=` presets) |
| `-n, --frames <n>` | `render`: per image (default 90). `still`: frames rendered (default 30) |
| `--fps <n>` | Default: the settings' export fps |
| `--size <WxH>` | Default: the first image's size, rounded to even |
| `--pass <mode>` | `composite` (default), `tracers` or `layers`: the export panel's pass modes |
| `--no-tracers` | The export panel's tracer toggle |
| `--msaa` | 4× MSAA on the band layers (the Viewport toggle) |
| `--no-wasm` | Analyse with the TypeScript kernels instead of the C++ engine |
| `--swiftshader` | Draw on [SwiftShader](#which-rasterizer). The default for `golden` |
| `-o, --out <path>` | `.mp4 .mov .mkv` (H.264), `.webm` (VP9), or a path ending in `/` (PNGs) |

The exit code is 0, 1 when the device reported an error during the render,
or 2 for a usage error. `CHROMASHIFT_DAWN_FLAGS` passes Dawn options
(`backend=vulkan`, `adapter=…`, space-separated). `CHROMASHIFT_FFMPEG` names
the ffmpeg binary. `CHROMASHIFT_VK_ICD` names a SwiftShader manifest other
than Playwright's.

## How a frame is made

```
webgpu (Dawn) ── create() ──► navigator.gpu
                                 │
RendererOrchestrator.bootstrap({ primaryTarget: HeadlessSurface, primaryFormat: 'rgba8unorm' })
  ├─ the page's adapter gate: power-preference attempts, requestDevice strategies
  ├─ configureWebGpuCanvas(surface, …)        ← the canvas configure path, unchanged
  ├─ TextureManager, the gpu-chores lease
  └─ slot "primary" → WebGPURenderer → WebGpuGraphExecutor
                                 │
sharp decode ─► TextureManager.uploadPixels ─► rgba8unorm-srgb + mips
                                 │
analysis lanes ─► classification mask + average luminance
                                 │
exportVideoFrameLoop ─► renderer.exportFrame ─► RGBA8 ─► ffmpeg | PNGs
```

**`PresentationTarget`** (`src/engine/webgpu/presentationTarget.ts`) is the
part of `GPUCanvasContext` the renderer uses: `configure`, `unconfigure`,
`getCurrentTexture`, and `getConfiguration` when present. The session, the
orchestrator's slots and `WebGPURenderer` hold one instead of a canvas
context. `HeadlessSurface` implements it with an offscreen texture that keeps
a canvas context's contract. It refuses the formats a canvas refuses, fills in
`getConfiguration()` the way Chrome does, and stays one texture until a resize
or a reconfigure. So `configureWebGpuCanvas` and the HDR probe drive it
unchanged, with no fourth configure path (#244). `COPY_SRC` is added to its
usage so `read()` can copy a live frame back. Exports render offscreen and
never need that.

**Images** decode with sharp (libvips) the way a browser hands a file to
`copyExternalImageToTexture`: EXIF orientation applied, converted to sRGB,
alpha added, 8 bits. The bytes go up through `TextureManager.uploadPixels`
into the same `rgba8unorm-srgb` mip chain a page builds.

**Analysis** follows the page's lane order. First the device's compute lane.
Neither lavapipe nor SwiftShader grants `texture-formats-tier1`, so it declines
there, as it does in the E2E browser. Next comes the committed C++ engine
(`public/chromashift_engine.wasm`, loaded with `wasmBinary` as `bench:wasm`
does). TypeScript is last. The CPU lanes read the decoded bytes through the
same kernels the page runs on canvas pixels (`computePixelsAverageLuminanceWith`,
`classifyPixelsMaskWith`). The mask goes up as `r8uint`. The CLI prints which
lane ran.

**Clips** are `exportVideoFrameLoop` over `renderer.exportFrame`: the in-app
export's frame clock, angle stepping, persistence reset and SDR export variant.
The clip starts from the settings' own angles (the panel's "use preset angles"),
since there is no live animation to start from. `--frames` is exact. The
panel's half-second floor is a UI limit.

## Which rasterizer

| `--swiftshader`? | Driver | Use |
|---|---|---|
| no (default) | The machine's Vulkan: a GPU, or Mesa lavapipe | Clips and stills |
| yes | The Vulkan SwiftShader beside Playwright's Chromium (`npx playwright install chromium`) | Goldens, parity |

SwiftShader is what `chromium-webgpu` draws with in CI, so a frame rendered
on it here is the browser's frame, byte for byte. Lavapipe is a correct
Vulkan, but it samples and rounds differently. Across the E2E scene,
about 23% of pixels differ by more than 1/255, and band edges, where a magnified
texel moves by a step, differ by up to 159. Nothing is wrong there, it is just
not the same rasterizer. Lavapipe is about 12× faster at 720p, so it stays the
default for real renders, and the goldens are pinned on SwiftShader.

## Encoding

ffmpeg is the default encoder: raw RGBA frames go to its stdin with
backpressure, so a slow encoder throttles the render instead of buffering the
clip. Frames are tagged BT.709 limited range, like a WebCodecs encode of an
sRGB canvas. H.264 is `libx264 -preset medium -crf 18`. VP9 is
`libvpx-vp9 -crf 30 -row-mt 1`. If ffmpeg exits mid-clip, for example when it
cannot write the output, the next write fails with ffmpeg's own message.

Without ffmpeg, `render` writes a PNG sequence through sharp, the decoder it
already has. The issue asked whether the fallback should be the app's
`mediabunny` muxer, fed by an encoder that runs in Node. Node has no
WebCodecs, so that would mean adding an encoder dependency, a WASM or native
codec build. The measurements below say it would not pay for itself.

These numbers come from 90 frames of `examples/cr0p.json` over
`examples/sweep.png`, on an 8-core box with no GPU, loaded with other work.
Expect ±20%. "Render" is `exportFrame` plus readback, with nothing written.
Each encoder figure is that encoder alone, fed the same frames.

| fps | lavapipe 720p | lavapipe 1080p | SwiftShader 720p |
|---|---|---|---|
| Render | **3.8** | **1.6** | **0.3** |
| ffmpeg H.264 | 11.3 | 6.2 | 13.5 |
| ffmpeg VP9 | 1.7 | 1.1 | 1.8 |
| PNG sequence (sharp) | 8.4 | 4.2 | 7.1 |

End to end on lavapipe at 720p, `render` took 31.5 s to `.mp4` (2.9 fps),
36.3 s to PNGs (2.5 fps) and 71.5 s to `.webm` (1.3 fps). At 192×192 a 90-frame
`.mp4` takes about 3 s (24–30 fps).

On a software rasterizer the render is the bottleneck. H.264 runs at about 3×
the render rate, in its own process, so it adds almost nothing. Even the PNG
fallback keeps up with the render. An in-process encoder would buy nothing
measurable, at the cost of a dependency. VP9 is the exception: it is
encode-bound, so prefer `.mp4` when throughput matters. Revisit the decision
if a GPU runner makes the render outpace the PNG fallback (about 8 fps at 720p).

## Goldens

`src/headless/__golden__/` holds the canonical pixel goldens: 192×192, frame
12 of a 30 fps clip of `examples/sweep.png` (the E2E structured fixture), at
layer opacity 0.66, so that tracers blended under a layer show. Without that,
the `trails3` echo never reaches a pixel.

| Case | Graph | Layers |
|---|---|---|
| `default-1`, `default-3`, `default-7`, `default-10` | default | 1, 3, 7, 10 |
| `smear`, `feedback`, `trails3`, `blur`, `warp` | the starter and shape presets | 3 |

They are compared with pixelmatch (threshold 0) plus a per-channel delta, at
the E2E tolerance: max channel delta ≤ 1 and ≤ 0.05% of pixels differing.
Renders are deterministic across processes, with a delta of 0. After an
intended change, run `npx chromashift golden --update` and review the PNG diff.

The `gpu` Vitest project (`*.gpu.test.ts`, `npm run test:gpu`) is opt-in
locally. `npm test` needs no Vulkan driver. It has two suites:

- `goldens.gpu.test.ts`, on SwiftShader. It runs the nine goldens, then the
  browser's own pinned frames (`e2e/__golden__/default-composite`,
  `tracer-view`, `quarter-zoom`) drawn live into the surface, asserted
  **byte-identical**, then an export of the live frame, asserted identical to
  the live frame. It skips without Playwright's Chromium.
- `session.gpu.test.ts`, on the system driver. It checks that the session
  boots through the gate, that analysis lands on a device or C++ lane with the
  fixture's luminance, and that every golden case draws content with no device
  error.

CI's `headless` job installs lavapipe, ffmpeg and Playwright's Chromium (for
its SwiftShader). It runs `npm run test:gpu`, then the CLI smoke: a 90-frame
`.mp4` (frame count checked with ffprobe) and a still, both uploaded as the
`headless-out` artifact.

## Parity with the browser

Three facts chain together:

1. The headless live frame equals the browser's canvas frame, byte for byte,
   on SwiftShader (the three `e2e/__golden__` frames).
2. A headless export equals its live frame.
3. A clip is the browser's export loop over that export call.

So a CLI clip's frames are the in-app export's frames. The encoded file is
not byte-comparable: H.264 is lossy and encoders differ (WebCodecs in a tab,
libx264 here). Compare frames, not files.

## Not in the bundle

`scripts/check-dist-assets.mjs` (`check:dist`, part of `npm run build`) fails
the build if any `dist/` script imports `webgpu`, `sharp`, `pngjs`,
`pixelmatch` or a `node:` module, or mentions `dawn.node`, `@img/sharp`,
`HeadlessSurface` or `src/headless/`. `src/headless/` has its own
`tsconfig.headless.json` (Node types), and `tsconfig.app.json` excludes it.

## Not done yet

- **A graph document.** `--graph` takes a preset name. A JSON graph needs
  `PassGraphSource` to carry an arbitrary graph rather than a `GraphPresetName`,
  which is the node editor's work (#177).
- **A modulation take** as an input, once #227 lands.
- **HDR output.** Exports are SDR, as in the app. An `rgba16float` surface is
  not readable through `read()`.
- **A render service**, the CLI behind a queue, and a native C++ reference
  renderer over `exec/plan.ts` (#228's "Later").

## Files

```
bin/chromashift.mjs          # Vite SSR loader → src/headless/cli.ts
src/engine/webgpu/presentationTarget.ts   # the canvas-context subset the renderer uses
src/headless/
├── cli.ts                   # parseArgs; render / still / golden
├── dawn.ts                  # navigator.gpu from Dawn; the SwiftShader ICD
├── HeadlessSurface.ts       # the offscreen PresentationTarget
├── session.ts               # openHeadlessSession: the page's bootstrap, analysis
├── settings.ts              # settings document / ?preset= → state
├── image.ts                 # sharp decode and PNG write
├── render.ts                # renderClip / renderStill over exportVideoFrameLoop
├── encode.ts                # ffmpeg pipe, PNG sequence
├── goldens.ts               # the golden cases, compare, read/write
├── *.gpu.test.ts            # the gpu project
└── __golden__/              # the pinned frames
examples/cr0p.json, sweep.png
```
