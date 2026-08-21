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
| WebGPU hard-fail (no silent WebGL) | [#133](https://github.com/ford442/Chromashift/issues/133) | ✅ Shipped | `WEBGL_BACKEND_ENABLED = false`; [webgl-fallback.md](webgl-fallback.md) |
| WebGPU hard-fail (no silent WebGL) | [#133](https://github.com/ford442/Chromashift/issues/133) | ✅ Shipped | Probe overlay; `usingWebGL` false on failure |
| Explicit WebGL diagnostic backend | [#141](https://github.com/ford442/Chromashift/issues/141) | ✅ Shipped | `?renderer=webgl` / panel; never automatic fallback; [webgl-fallback.md](webgl-fallback.md) |

## Next up — prioritized backlog (#142–#145)

Strategic audit (2026-08). **Build these before another still-image effect.** Compare, presets v3, live source, gpu-chores, and optional GPU feature consumption already shipped; remaining gaps are WebGL diagnostic policy, artist workflow, installation capture, and hot-path WASM.

| Pri | Target | Issue | Type | Complexity | Notes |
|-----|--------|-------|------|------------|-------|
| P0 | Explicit WebGL diagnostic backend | [#141](https://github.com/ford442/Chromashift/issues/141) | Foundation | L | Never silent fallback; unlocks XR + Playwright chromium |
Strategic audit (2026-08). **Build these before another still-image effect.** Compare, presets v3, live source, gpu-chores, and explicit WebGL already shipped; the gaps are unused GPU features, artist workflow, installation capture, and hot-path WASM.

| Pri | Target | Issue | Type | Complexity | Notes |
|-----|--------|-------|------|------------|-------|
| P0 | Consume or drop optional GPU features | [#142](https://github.com/ford442/Chromashift/issues/142) | Foundation | L | `float32-filterable` / `rg11b10ufloat` requested but unused; docs vs 8K retry order |
| P1 | Colour profile designer + live LUT | [#143](https://github.com/ford442/Chromashift/issues/143) | Feature | L | JSON import is the current ceiling of the profile system |
| P1 | Kiosk camera attract + live export | [#144](https://github.com/ford442/Chromashift/issues/144) | Feature | L | Consent splash; never `getUserMedia` from `?preset=` |
| P1 | Compute persistence; no per-frame WASM | [#145](https://github.com/ford442/Chromashift/issues/145) | Architecture | L–XL | `durationToDecayWith` on the hot path is the wrong lane |

**Foundation vs features:** do **#141** before treating WebXR as usable (presenter requires WebGL). **#143** is the right next *content* tool (palettes), not a fourth layer shader. **#144** is the installation product on top of live source. **#145** should land the small WASM-hot-path cut even if compute persistence slips.

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
