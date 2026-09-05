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
| gpu-chores facade | [#132](https://github.com/ford442/Chromashift/issues/132) | ✅ Shipped | `src/engine/compute/chores/` — WebGPU → WASM → TS |
| Optional GPU features consumed | [#142](https://github.com/ford442/Chromashift/issues/142) | ✅ Shipped | `timestamp-query` + `rg11b10ufloat-renderable`; `float32-filterable` dropped; [gpu-bootstrap.md](gpu-bootstrap.md) |
| WebGPU hard-fail (no silent WebGL) | [#133](https://github.com/ford442/Chromashift/issues/133) | ✅ Shipped | `WEBGL_BACKEND_ENABLED = false`; probe overlay, `usingWebGL` false on failure; [webgl-fallback.md](webgl-fallback.md) |
| Explicit WebGL diagnostic backend | [#141](https://github.com/ford442/Chromashift/issues/141) | ✅ Shipped | `?renderer=webgl` / panel; never automatic fallback; [webgl-fallback.md](webgl-fallback.md) |

## Next up — prioritized backlog (#143–#145)

Strategic audit (2026-08). **Build these before another still-image effect.** Compare, presets v3, live source, gpu-chores, optional GPU features, and explicit WebGL already shipped; the gaps are artist workflow, installation capture, and hot-path WASM.

| Pri | Target | Issue | Type | Complexity | Notes |
|-----|--------|-------|------|------------|-------|
| P1 | Colour profile designer + live LUT | [#143](https://github.com/ford442/Chromashift/issues/143) | Feature | L | JSON import is the current ceiling of the profile system |
| P1 | Kiosk camera attract + live export | [#144](https://github.com/ford442/Chromashift/issues/144) | Feature | L | Consent splash; never `getUserMedia` from `?preset=` |
| P1 | Compute persistence | [#145](https://github.com/ford442/Chromashift/issues/145) | Architecture | L–XL | ✅ Shipped — WASM hot-path cut, plus a `gpu-chores` `op: 'coincidence'` compute pass replacing the fragment shader's duplicated 3-layer overlap math; fragment path remains the fallback (see [gpu-bootstrap.md](gpu-bootstrap.md#gpu-chores-compute-device-adoption)) |

**Foundation vs features:** **#143** is the right next *content* tool (palettes), not a fourth layer shader. **#144** is the installation product on top of live source. **#145** has landed in full.

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
| P0 | Stop whole-tree re-renders | [#149](https://github.com/ford442/Chromashift/issues/149) | Foundation | M–L | Zero `React.memo` in the tree; the render loop dispatches at 5 Hz, re-reconciling 3137 thumbnails |
| P0 | Analysis off the main thread | [#150](https://github.com/ford442/Chromashift/issues/150) | Foundation | M | `getImageDataAtNaturalSize` is a 268 MB synchronous alloc at 8K, on the CPU lanes that exist *because* the GPU lane is unavailable |
| P1 | Virtualize + index the image browser | [#151](https://github.com/ford442/Chromashift/issues/151) | Foundation | M | 3137 unvirtualized entries, 360 kB manifest parsed at boot, no search |
| P1 | Real WASM SIMD, one ABI, perf gate | [#152](https://github.com/ford442/Chromashift/issues/152) | Foundation | L | `-msimd128` with zero intrinsics; C exports *and* embind for the same 15 functions |

### Features

| Pri | Target | Issue | Type | Complexity | Notes |
|-----|--------|-------|------|------------|-------|
| P1 | Automation timeline (schema v5) | [#153](https://github.com/ford442/Chromashift/issues/153) | Feature | L | Presets are poses, not performances; unblocks authored exports and kiosk attract. Depends on #149 |
| P2 | Pass-graph IR + compiler | [#154](https://github.com/ford442/Chromashift/issues/154) | Architecture | XL | "3 layers" is welded across WGSL, GLSL, TS and C++; default graph must be pixel-identical |
| P2 | Motion-aware tracers | [#155](https://github.com/ford442/Chromashift/issues/155) | Feature | L | Persistence is spatial-only — live source's most interesting signal is discarded. Composes with #154 and #145 |

**Reading the split:** #149 and #150 are the two that make everything else cheaper,
and neither changes a pixel. #153 is the highest-value *product* addition — it is
what makes video export and kiosk mode worth using. #154 is the one that removes
the ceiling, and it is deliberately gated (`?graph=1`) so it can ship dark.

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
