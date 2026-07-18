# Chromashift Roadmap

This file is the **single source of truth** for shipped vs. planned work. README.md
summarises it in the [Roadmap](../README.md#roadmap) section; [AGENTS.md](../AGENTS.md)
links here instead of duplicating issue tables.

For live status, always check the [GitHub issue tracker](https://github.com/ford442/Chromashift/issues).

## Shipped (foundation through #92)

Closed issues **#16–#84** delivered the core engine: C++/WASM hybrid, WebGPU hardening,
WebGL2 fallback, reducer-backed state, shader modularisation with TS/WGSL/C++ parity
tests, CI, GPU compute analysis, shareable presets, and offline video export.

Recent closures (**#80–#92**) added the features below. All are **shipped** in `main`
unless noted.

| Area | Issue | Status | Where to look |
|------|-------|--------|---------------|
| Lazy upscaler workers | [#80](https://github.com/ford442/Chromashift/issues/80) | ✅ Shipped | `Upscaler.ts`, `upscaler.worker.ts`, `nunif.worker.ts` — workers load only on Upscale click |
| Local image library | [#88](https://github.com/ford442/Chromashift/issues/88) | ✅ Shipped | `LocalLibrary.ts`, `ImageStrip.tsx` — drag-drop, IndexedDB, LOCAL/REMOTE badges |
| Doc refresh | [#89](https://github.com/ford442/Chromashift/issues/89) | ✅ Shipped | README / AGENTS / this file |
| Deploy script hardening | [#90](https://github.com/ford442/Chromashift/issues/90) | ✅ Shipped | `deploy.py` — SSH key auth, `--dry-run`, `--no-clean`, `requirements-deploy.txt`, Deploy workflow |
| GPU perf HUD | [#91](https://github.com/ford442/Chromashift/issues/91) | ✅ Shipped | `GpuTimestampProfiler.ts`, Diagnostics panel **Perf HUD** toggle |
| Audio-reactive + MIDI | [#92](https://github.com/ford442/Chromashift/issues/92) | ✅ Shipped | `ReactivePanel.tsx`, `src/engine/reactive/` — layer rates, tracer intensity, MIDI learn |
| Kiosk / gallery mode | [#85](https://github.com/ford442/Chromashift/issues/85) (partial) | ✅ Desktop kiosk shipped | `?kiosk=1`, [KIOSK.md](KIOSK.md), `useKioskMode.ts` — fullscreen, attract drift, bottom remote |
| C++ WASM expansion | [#86](https://github.com/ford442/Chromashift/issues/86) | ✅ Closed (incremental) | Band LUT + host tests in `cpp/`; full offline composite still research |

**Open issues:** none as of the 2026-07 audit (#85–#92 all closed).

## Next up — features

| Target | Issue | Status | Notes |
|--------|-------|--------|-------|
| **Compare / multi-view** | [#87](https://github.com/ford442/Chromashift/issues/87) | 🔜 Planned | Dual 2-up, quad grid, swipe split — **not shipped**. Design: [COMPARE_VIEWS.md](COMPARE_VIEWS.md). Types/helpers: `src/engine/compareViews.ts` |
Compare views are the primary **feature** target: side-by-side preset A/B, quad layout,
and swipe split without screenshot juggling.

## Research

| Target | Issue | Status | Notes |
|--------|-------|--------|-------|
| **WebXR / immersive** | [#85](https://github.com/ford442/Chromashift/issues/85) | 🔬 Phase-0 spike | WebGL `XRWebGLLayer` at half res — [WebXR.md](WebXR.md); kiosk + XR mutually exclusive |
| C++ engine depth | [#86](https://github.com/ford442/Chromashift/issues/86) | 🔬 Research | Rotation matrices, band LUT in WASM, offline composite parity with WebGPU |

WebXR depends on browser WebGPU-XR interop maturing; kiosk mode covers gallery installs
on desktop Chrome today.

## How to propose work

1. Open a [GitHub issue](https://github.com/ford442/Chromashift/issues/new) with acceptance criteria.
2. Update this file when the issue closes (shipped row or move to research).
3. Keep README's roadmap section as a short pointer — not a second issue table.
