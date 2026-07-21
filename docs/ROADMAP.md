# Chromashift Roadmap

This file is the **single source of truth** for shipped vs. planned work. README.md
summarises it in the [Roadmap](../README.md#roadmap) section; [AGENTS.md](../AGENTS.md)
links here instead of duplicating issue tables.

For live status, always check the [GitHub issue tracker](https://github.com/ford442/Chromashift/issues).

## Shipped (foundation through #113)

Closed issues **#16–#84** delivered the core engine: C++/WASM hybrid, WebGPU hardening,
WebGL2 fallback, reducer-backed state, shader modularisation with TS/WGSL/C++ parity
tests, CI, GPU compute analysis, shareable presets, and offline video export.

Recent closures (**#80–#113**) added the features and architecture below. All are
**shipped** in `main` unless noted.

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

## Next up — prioritized backlog (#115–#124)

Strategic audit backlog (2026-07). Order is priority; earlier items compound into later ones.

| Pri | Target | Issue | Type | Complexity | Notes |
|-----|--------|-------|------|------------|-------|
| P0 | Typed renderer texture handles | [#115](https://github.com/ford442/Chromashift/issues/115) | Foundation | M | Replace `unknown` texture contracts before more multi-view work |
| P0 | Compare Phase 2 — swipe split | [#116](https://github.com/ford442/Chromashift/issues/116) | Feature | M | Draggable A/B divider; `swipePosition` already in schema v2 |
| P1 | Compare Phase 3 — quad grid | [#117](https://github.com/ford442/Chromashift/issues/117) | Feature | L | `QUAD_VIEW_CELLS`; stationary refs + live composite |
| P1 | Remote GPU texture LRU / budget | [#118](https://github.com/ford442/Chromashift/issues/118) | Performance | M | Remote `http(s)` textures currently cached forever |
| P1 | Soft GPU device-loss recovery | [#119](https://github.com/ford442/Chromashift/issues/119) | Foundation | L | Re-bootstrap without full page reload (kiosk resilience) |
| P1 | Decompose store refs/actions | [#120](https://github.com/ford442/Chromashift/issues/120) | Refactor | L | Split `useChromashiftStore` / `ChromashiftRefs` god-bundle |
| P1 | E2E dual compare + preset layout | [#121](https://github.com/ford442/Chromashift/issues/121) | DX / Test | M | Beyond bootstrap smoke |
| P1 | GLSL band threshold codegen | [#122](https://github.com/ford442/Chromashift/issues/122) | Foundation | M | Match WGSL `BAND_WGSL` for WebGL reference path |
| P2 | WebCodecs offline export | [#123](https://github.com/ford442/Chromashift/issues/123) | Feature | L | Prefer `VideoEncoder` when available; MediaRecorder fallback |
| P2 | WebXR Phase 1 navigation | [#124](https://github.com/ford442/Chromashift/issues/124) | Feature / Research | L | Controller → prev/next/pause; WebGPU-XR still deferred |

**Foundation vs features:** the core pipeline, presets, dual compare, orchestrator, and schema v2 are solid enough to ship features. Land #115 (and ideally #120 / #122) alongside compare Phase 2–3 so multi-view stays type-safe and maintainable.

## Research

| Target | Issue | Status | Notes |
|--------|-------|--------|-------|
| **WebXR / immersive** | [#85](https://github.com/ford442/Chromashift/issues/85) plan; [#124](https://github.com/ford442/Chromashift/issues/124) Phase 1 | 🔬 Phase-0 shipped; Phase 1 open | WebGL `XRWebGLLayer` at half res — [WebXR.md](WebXR.md); kiosk + XR mutually exclusive |
| C++ engine depth | [#86](https://github.com/ford442/Chromashift/issues/86) | 🔬 Research | Offline composite parity with WebGPU remains optional research |
| WebGPU-XR swapchain | — | 🔬 Deferred | Blocked on browser interop; see WebXR.md Phase 2 |

WebXR depends on browser WebGPU-XR interop maturing; kiosk mode covers gallery installs
on desktop Chrome today.

## How to propose work

1. Open a [GitHub issue](https://github.com/ford442/Chromashift/issues/new) with acceptance criteria.
2. Update this file when the issue closes (shipped row or move to research).
3. Keep README's roadmap section as a short pointer — not a second issue table.
