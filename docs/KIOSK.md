# Kiosk & Gallery Installation Mode

Chromashift can run as a **full-viewport installation** on desktop Chrome today. WebXR / surround rendering remains research — kiosk mode is the supported path for unattended gallery demos.

## Quick start

Open with the kiosk URL flag:

```text
https://your-host/chromashift/?kiosk=1
```

Combine with a shared preset and WebGPU renderer:

```text
?kiosk=1&renderer=webgpu&preset=…
```

On load:

- NUNIF and peripheral previews are **hidden** for a clean canvas
- **Autoplay** cycles images every 10 seconds
- **Attract mode** slowly drifts tracer intensity, stamp boost, and average luminance
- **Pause is disabled** while chrome is hidden (rotation keeps running)
- Live thumbnail readback is off to save GPU budget

## Controls

| Input | Action |
|--------|--------|
| **Esc** | Restore NUNIF panels and exit fullscreen |
| **F** | Toggle fullscreen |
| **?** | Keyboard shortcuts cheat-sheet |
| **[ / ]** | Previous / next image |
| **R** | Random image |
| **Click canvas** | Enter fullscreen (first gesture; browsers require user activation) |

When UI is hidden, a **large bottom remote** provides prev / next / random / fullscreen for IR remotes and touch.

Press **Esc** again after restoring panels to use NUNIF normally. Remove `?kiosk=1` from the URL for a non-kiosk bookmark.

## Fullscreen & wake lock

- Fullscreen targets `#chromashift-container` via the Fullscreen API (`F` or canvas click).
- When fullscreen is active and the browser supports it, Chromashift requests a **Screen Wake Lock** so displays stay on during long installs.
- Wake lock is released when leaving fullscreen or when the tab is hidden.

## Recommended hardware & browser

| Component | Recommendation |
|-----------|----------------|
| **Browser** | Chrome 113+ or Edge 113+ with WebGPU enabled |
| **GPU** | Dedicated GPU (Intel Iris / Apple M-series / discrete) for 1080p–4K canvas |
| **Display** | 1080p minimum; 4K works with `performanceAutoDegrade` in Diagnostics if needed |
| **Input** | USB IR remote (keyboard arrow emulation) or touch screen |
| **Network** | Host `images.json` and corpus on fast LAN or local static server for offline installs |
| **Fallback** | `?renderer=webgl` if WebGPU init fails — visual parity is approximate |

Avoid Firefox/Safari for production installs until stable WebGPU is available; use `?renderer=webgl` only as emergency fallback.

### Automation breadcrumbs

```js
window.kioskMode        // true when ?kiosk=1 was applied
window.rendererType     // 'webgpu' | 'webgl'
window.usingWebGPU
window.xrAvailable      // immersive-vr supported (see docs/WebXR.md)
```

## 10-minute unattended demo checklist

1. Curate `public/images.json` (8–20 strong images).
2. Save a preset in NUNIF, copy share URL, append `&kiosk=1`.
3. Open on target machine, click once for fullscreen.
4. Confirm autoplay advances and attract drift is visible over ~2 minutes.
5. Hide OS cursor (OS setting) for a cleaner install look.
6. Set OS power / display sleep to **Never**; wake lock covers tab focus but not all OS policies.

## Future (not shipped)

- WebXR immersive viewing — Phase-0 spike in tree; see [WebXR.md](WebXR.md)
- Stereo or skybox surround
- MIDI / controller mapping to layer rates

Desktop kiosk (`?kiosk=1`) and XR are mutually exclusive until orchestration exists.
