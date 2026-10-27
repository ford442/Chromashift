# Chromashift Roadmap

This file is the **single source of truth** for shipped vs. planned work. README.md
summarises it in the [Roadmap](../README.md#roadmap) section; [AGENTS.md](../AGENTS.md)
links here instead of duplicating issue tables.

For live status, always check the [GitHub issue tracker](https://github.com/ford442/Chromashift/issues).

## Shipped (foundation through #133)

Closed issues **#16–#84** delivered the core engine: C++/WASM hybrid, WebGPU hardening,
WebGL2 fallback (now gated — see below), reducer-backed state, shader modularisation
with TS/WGSL/C++ parity tests, CI, GPU compute analysis, shareable presets, and
offline video export.

**#115–#124** (2026-07 strategic backlog) all shipped: typed texture handles, compare
swipe/quad, texture LRU, soft device-loss recovery, store slice split, compare E2E,
GLSL band codegen, WebCodecs export, WebXR Phase-1 navigation spike.

Recent closures (**#126–#133**) added the architecture below. All are **shipped** in
`main` unless noted.

| Area | Issue | Status | Where to look |
|------|-------|--------|---------------|
| Lazy upscaler workers | [#80](https://github.com/ford442/Chromashift/issues/80) | ✅ Shipped | `Upscaler.ts`, `upscaler.worker.ts`, `nunif.worker.ts` — workers load only on Upscale click |
| Local image library | [#88](https://github.com/ford442/Chromashift/issues/88) | ✅ Shipped | `LocalLibrary.ts`, `ImageStrip.tsx` — drag-drop, IndexedDB, LOCAL/REMOTE badges |
| Doc refresh | [#89](https://github.com/ford442/Chromashift/issues/89) | ✅ Shipped | README / AGENTS / this file |
| Deploy script hardening | [#90](https://github.com/ford442/Chromashift/issues/90) | ✅ Shipped | `deploy.py` — SSH key auth, `--dry-run`, `--no-clean`, `requirements-deploy.txt`, Deploy workflow |
| GPU perf HUD | [#91](https://github.com/ford442/Chromashift/issues/91) | ✅ Shipped | `GpuTimestampProfiler.ts`, Diagnostics panel **Perf HUD** toggle |
| Audio-reactive + MIDI | [#92](https://github.com/ford442/Chromashift/issues/92) | ✅ Shipped | `ReactivePanel.tsx`, `src/engine/reactive/` — layer rates, tracer intensity, MIDI learn |
| Kiosk / gallery mode | [#85](https://github.com/ford442/Chromashift/issues/85) (partial) | ✅ Desktop kiosk shipped | `?kiosk=1`, [KIOSK.md](KIOSK.md), `useKioskMode.ts` — fullscreen, attract drift, bottom remote |
| C++ WASM expansion | [#86](https://github.com/ford442/Chromashift/issues/86) | ✅ Closed (incremental) | Band LUT + host tests in `cpp/`; load-time analysis scope documented in [wasm-engine.md](wasm-engine.md) |
| Dual A/B compare | [#96](https://github.com/ford442/Chromashift/issues/96) | ✅ Shipped | Viewport Dual layout, sync play, slot B preset load — [COMPARE_VIEWS.md](COMPARE_VIEWS.md) |
| Renderer orchestration | [#99](https://github.com/ford442/Chromashift/issues/99) | ✅ Shipped | `RendererOrchestrator.ts` — shared `GPUDevice`, multi-canvas slots |
| Settings schema v2 | [#104](https://github.com/ford442/Chromashift/issues/104) | ✅ Shipped | `serializeSettings.ts` version 2 — compare / reactive / viewport / kiosk |
| Typed AppUI + shell split | [#103](https://github.com/ford442/Chromashift/issues/103) | ✅ Shipped | `AppUI.types.ts`, `MainViewport`, `PreviewStrip`, `ChromeShell` |
| Modular WebGL renderer | [#102](https://github.com/ford442/Chromashift/issues/102) | ✅ Shipped | `src/engine/webgl/*Pass.ts` |
| Stationary preview strip | — | ✅ Shipped | [PREVIEW_VIEWS.md](PREVIEW_VIEWS.md), `useStationaryPreviews.ts` |
| WebGPU bootstrap hardening | [#112](https://github.com/ford442/Chromashift/issues/112) / [#113](https://github.com/ford442/Chromashift/issues/113) | ✅ Shipped | Context resize + broader GPU/browser compatibility |
| Named colour profiles | [#130](https://github.com/ford442/Chromashift/issues/130) | ✅ Shipped | [COLOR_PROFILES.md](COLOR_PROFILES.md), LUT path, preset schema v3 |
| Live source (camera / screen / video file) | [#127](https://github.com/ford442/Chromashift/issues/127) | ✅ Shipped | [LIVE_SOURCE.md](LIVE_SOURCE.md), `LiveSource.ts` — not serialized into presets |
| Settings schema v5 (tracer motion) | [#155](https://github.com/ford442/Chromashift/issues/155) | ✅ Shipped | `serializeSettings.ts` version 5 — `motionMode` / `motionGain` / `motionDecayBias` / `motionThreshold`; v1–v4 migrate to `motionMode: 'off'` |
| Variable layer count (schema v7) | [#156](https://github.com/ford442/Chromashift/issues/156) | ✅ Shipped | `layers.count` (1–10) replaces the 3-tuples in state, the renderer contract and the C ABI; bind-group layouts and the coincidence compute kernel are generated from it. Colour profiles take 1–10 layers (LUT is 256 × max(count, 3), row `r` = profile layer `r % M`), and counts below three draw only the first `count` band passes instead of crashing. Executing `n` band passes is the graph-executor half — see [PASS_GRAPH.md](PASS_GRAPH.md#layer-counts) |
| gpu-chores facade | [#132](https://github.com/ford442/Chromashift/issues/132) | ✅ Shipped | `src/engine/compute/chores/` — WebGPU → WASM → TS |
| Tooling + chore-session hygiene | re-file of [#175](https://github.com/ford442/Chromashift/issues/175) | ✅ Shipped | clangd database + `cpp/.clangd`, `-Wall -Wextra` on emcc, `test-werror` in CI, pinned `cpp/emsdk.version`, tone-mapping capability bit, one `WebGpuChoreBackend` per device via `GpuChoreSession` (guarded by `choreBackendOwnership.test.ts`). See [gpu-bootstrap.md](gpu-bootstrap.md) and [wasm-engine.md](wasm-engine.md#editor-setup-clangd) |
| Optional GPU features consumed | [#142](https://github.com/ford442/Chromashift/issues/142) | ✅ Shipped | `timestamp-query` + `rg11b10ufloat-renderable`; `float32-filterable` dropped; [gpu-bootstrap.md](gpu-bootstrap.md) |
| Canvas HDR presentation | — | ✅ Shipped | Opt-in `hdr-extended` (`rgba16float` + `toneMapping: 'extended'`), schema v8 `viewport.canvasHdr`; LUTs stay sRGB; export stays SDR; [gpu-bootstrap.md](gpu-bootstrap.md) |
| WebGPU hard-fail (no silent WebGL) | [#133](https://github.com/ford442/Chromashift/issues/133) | ✅ Shipped | `WEBGL_BACKEND_ENABLED = false`; probe overlay, `usingWebGL` false on failure; [webgl-fallback.md](webgl-fallback.md) |
| Explicit WebGL diagnostic backend | [#141](https://github.com/ford442/Chromashift/issues/141) | ✅ Shipped | `?renderer=webgl` / panel; never automatic fallback; [webgl-fallback.md](webgl-fallback.md) |

## Next up — open backlog (2026-10 audit)

The open issues, in the order they unblock each other. **#225** (this audit's
correctness sweep) and the WebGL-graph foundation (**#221**, **#222**) come
first because #226 and #228 move or reuse exactly the paths they fix.

| Pri | Target | Issue | Type | Complexity | Notes |
|-----|--------|-------|------|------------|-------|
| P0 | Correctness sweep | [#225](https://github.com/ford442/Chromashift/issues/225) | Foundation | M | ✅ Shipped — the WASM engine loads (fixed SIMD probe, `window.wasmEngineState` on the page and both workers); exports read back RGBA from a `bgra8unorm` canvas; Retry GPU after device loss requests a fresh adapter; inspect-view pipelines compile async and their errors reach the overlay; XR advances the tracers once per frame at `framebufferScaleFactor` |
| P0 | WebGL draws the pass graph | [#221](https://github.com/ford442/Chromashift/issues/221) | Foundation | L | ✅ Shipped — `WebGLGraphExecutor` replaces the hand-written WebGL passes (diagnostic, XR, Playwright) |
| P0 | WebGL context policy | [#222](https://github.com/ford442/Chromashift/issues/222) | Foundation | M | ✅ Shipped — power-preference attempts, context loss/restore, MSAA matching the passes, half-float targets |
| P1 | Checked inputs, one parameter registry, one frame clock | [#226](https://github.com/ford442/Chromashift/issues/226) | Foundation | L | Validated settings schema, `ParamPath`, `FrameClock`. Depends on #225; unblocks #177, #178, #227 |
| P1 | One graph everywhere | [#228](https://github.com/ford442/Chromashift/issues/228) | Platform | XL | Safari/Firefox WebGPU, the WebGL executor, a headless Dawn renderer + CLI. Depends on #225 |
| P1 | Multi-output slots | [#178](https://github.com/ford442/Chromashift/issues/178) | Architecture | L | XR as an orchestrator peer, kiosk walls, one chore session |
| P2 | Performance timeline (schema v9) | [#224](https://github.com/ford442/Chromashift/issues/224) | Feature | L | Keyframe value params; drives export and kiosk. Re-files the closed #153 |
| P2 | Modulation matrix | [#227](https://github.com/ford442/Chromashift/issues/227) | Feature | L | Any source → any `ParamPath`, recorded takes. Depends on #226 |
| P2 | Previous-frame feedback | [#223](https://github.com/ford442/Chromashift/issues/223) | Architecture | M | A `history` edge the validator accepts; starter `?graph=recurse` |
| P2 | One ONNX Runtime WebGPU ML stack | [#206](https://github.com/ford442/Chromashift/issues/206) | Feature | L | Drop TF.js; depth + subject-matte sources for the pass graph |
| P2 | Pass-graph node editor | [#177](https://github.com/ford442/Chromashift/issues/177) | Feature | L | `@xyflow/react` + versioned graph JSON |

**Closed, not planned:** the colour profile designer ([#143](https://github.com/ford442/Chromashift/issues/143)),
kiosk camera attract ([#144](https://github.com/ford442/Chromashift/issues/144)) and the automation
timeline ([#153](https://github.com/ford442/Chromashift/issues/153); #224 re-files it).
[#145](https://github.com/ford442/Chromashift/issues/145) (compute persistence) shipped: a
`gpu-chores` `op: 'coincidence'` compute pass with the fragment path as fallback (see
[gpu-bootstrap.md](gpu-bootstrap.md#gpu-chores-compute-device-adoption)), and decay constants
codegen'd from `shared/decay.json` (see [wasm-engine.md](wasm-engine.md#shared-decay-table-shareddecayjson)).

## Strategic audit (2026-08, #149–#155)

Second audit after the WebGL-policy and optional-GPU-feature work closed. The
engine internals are in good shape — preallocated uniform buffers, a bind-group
cache, typed texture handles, real parity tests. The weak seams are all at the
**boundaries**: React ↔ engine, main thread ↔ workers, and the places where "3
layers" is a literal rather than a parameter. **Do the foundation rows before the
feature rows** — every feature below adds panels, per-frame state, and passes to
layers that do not currently scale.

### Foundation

| Pri | Target | Issue | Type | Complexity | Notes |
|-----|--------|-------|------|------------|-------|
| P0 | Stop whole-tree re-renders | [#149](https://github.com/ford442/Chromashift/issues/149) | Foundation | M–L | ✅ Shipped — Zero `React.memo` in the tree; the render loop dispatches at 5 Hz, re-reconciling 3137 thumbnails |
| P0 | Analysis off the main thread | [#150](https://github.com/ford442/Chromashift/issues/150) | Foundation | M | ✅ Shipped — `getImageDataAtNaturalSize` is a 268 MB synchronous alloc at 8K, on the CPU lanes that exist *because* the GPU lane is unavailable |
| P1 | Virtualize + index the image browser | [#151](https://github.com/ford442/Chromashift/issues/151) | Foundation | M | ✅ Shipped — 3137 unvirtualized entries, 360 kB manifest parsed at boot, no search |
| P1 | Real WASM SIMD, one ABI, perf gate | [#152](https://github.com/ford442/Chromashift/issues/152) | Foundation | L | ✅ Shipped — `-msimd128` with zero intrinsics; C exports *and* embind for the same 15 functions |

### Features

| Pri | Target | Issue | Type | Complexity | Notes |
|-----|--------|-------|------|------------|-------|
| P1 | Automation timeline (schema v6) | [#153](https://github.com/ford442/Chromashift/issues/153) | Feature | L | Closed, not planned (re-filed as #224). Presets are poses, not performances; unblocks authored exports and kiosk attract. Depends on #149. (Was planned as v5; #155's tracer motion took that version first.) |
| P2 | Pass-graph IR + compiler + executor | [#154](https://github.com/ford442/Chromashift/issues/154) | Architecture | XL | ✅ Shipped — Phases 1–3: the compiler (IR, validator, scheduler, transient pool, structural-hash cache, WGSL/GLSL templates pinned to the pre-refactor goldens) and a WebGPU `GraphExecutor` that is now the **only** WebGPU encode path (#203): every frame, view, export pass, stationary preview and compare slot, at any layer count (1–10), with motion modes, the `hdr-extended` present and N tracer timescales (`?graph=trails3`) as graph variants and nodes. The hand encoder is deleted; its frames are pinned in `e2e/__golden__/` and the default graph still draws them (the compute-fed stamp's ±1 was accepted rather than made a node). `?graph=blur` / `?graph=warp` draw new shapes with no renderer edit; pipelines the device rejects are refused by name and the default graph stands in, never a black canvas. Two temporal node kinds execute on WebGPU: `history` (an N-frame ring, 2–8 frames, bounded VRAM) and `displace` (UVs pushed by the motion field or colour-as-flow), with the JSON starters `?graph=smear` (body smear, the kiosk-camera look) and `?graph=feedback` (layer-0 self-displacing warp). The WebGL diagnostic / XR backend executes the same graphs (`WebGLGraphExecutor`, GLSL for every kind, default-graph frame pinned in `e2e/__golden__/webgl-default-composite.png`). Left: `history` feedback cycles. See [PASS_GRAPH.md](PASS_GRAPH.md) |
| P2 | Motion-aware tracers | [#155](https://github.com/ford442/Chromashift/issues/155) | Feature | L | ✅ Shipped — a `gpu-chores` `op: 'motion-field'` (quarter-res frame difference, GPU + WASM/TS lanes) feeding a `motionMode` / `motionGain` / `motionDecayBias` / `motionThreshold` term on both persistence backends, preset schema v5, and its own Perf HUD row. `off` is the default and binds the pre-motion shader variant unchanged. **Stage 2** adds coarse-to-fine Lucas–Kanade optical flow behind `direction`: two WGSL compute passes, a C++/SIMD128 `computeMotionFlow`, and the portable TS reference, all pinned to one fixture; the CPU solve runs in `motion.worker.ts`. Lifts naturally into #154 as a `motion` node. See [LIVE_SOURCE.md](LIVE_SOURCE.md#optical-flow-stage-2) |

**Reading the split:** #149 and #150 made everything else cheaper without changing
a pixel. #154 removed the ceiling: since Phase 3 the WebGPU executor draws every
frame and the hand encoder is gone, and since #221 the WebGL backend draws the
same compiled graph. #153 closed unbuilt; #224 carries the timeline forward.

## Research

| Target | Issue | Status | Notes |
|--------|-------|--------|-------|
| **WebXR / immersive** | [#85](https://github.com/ford442/Chromashift/issues/85); [#124](https://github.com/ford442/Chromashift/issues/124) | 🔬 Phase 0–1 in tree; **unblocked** via explicit WebGL ([#141](https://github.com/ford442/Chromashift/issues/141)) | Presenter is WebGL-only (`?renderer=webgl` + dedicated `xrCompatible` context). WebGPU-XR still deferred |
| C++ engine depth | [#86](https://github.com/ford442/Chromashift/issues/86) | 🔬 Research | Offline composite parity with WebGPU remains optional research |
| WebGPU-XR swapchain | — | 🔬 Deferred | Blocked on browser interop; see WebXR.md Phase 2 |

WebXR depends on browser WebGPU-XR interop maturing; kiosk mode covers gallery installs
on desktop Chrome today.

## How to propose work

1. Open a [GitHub issue](https://github.com/ford442/Chromashift/issues/new) with acceptance criteria.
2. Update this file when the issue closes (shipped row or move to research).
3. Keep README's roadmap section as a short pointer — not a second issue table.
