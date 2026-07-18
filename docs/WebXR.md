# WebXR immersive viewing (research)

Phase-0 **feasibility spike** for headset / surround viewing. Desktop gallery installs
remain on [KIOSK.md](KIOSK.md) (`?kiosk=1`); kiosk and XR are **mutually exclusive**
until orchestration matures.

## Phase 0 (shipped in tree)

- Feature-detect `navigator.xr` / `immersive-vr` on load
- Breadcrumbs: `window.xrAvailable`, `window.xrImmersive`, `window.xrImmersiveReason`
- **Enter immersive VR** in NUNIF → Renderer & Engine (WebGL backend only)
- Renders the colour-separated composite into `XRWebGLLayer` at **half resolution** per eye
  via a dedicated xr-compatible WebGL2 context (`src/engine/xr/WebXrPresenter.ts`)

### Requirements

| Requirement | Notes |
|-------------|--------|
| Browser | Chrome / Edge with WebXR + VR headset or emulator |
| Renderer | **WebGL** (`?renderer=webgl`) — WebGPU-XR interop is Phase 2 |
| Kiosk | Must be off — `?kiosk=1` blocks XR entry |
| Input | Browser / headset default exit gesture ends the session |

### Try it

```text
http://localhost:5173/?renderer=webgl
```

1. Open NUNIF → **Renderer & Engine**
2. Confirm **WebXR** panel shows immersive-vr available (or reason if not)
3. Click **Enter immersive VR**
4. Composite should fill each eye (half internal res, centered)
5. **Exit immersive VR** or use headset back / browser XR exit

### Automation

```js
window.xrAvailable    // true when immersive-vr is supported
window.xrImmersive    // true while session is active
window.xrImmersiveReason  // null or unsupported reason string
```

## Not shipped (future phases)

| Phase | Scope |
|-------|--------|
| **1 — Navigation** | XR input → prev/next image (reuse kiosk remote actions); exit restores flat UI |
| **2 — WebGPU-native** | WebGPU-XR swapchain when interop lands ([COMPARE_VIEWS.md](COMPARE_VIEWS.md) Phase 4) |
| **Research** | Passthrough AR, floating preset panels, stereo A/B compare per eye |

## Dependencies

- [Renderer orchestration](../src/engine/RendererOrchestrator.ts) — shared textures / multi-canvas (compare views)
- Performance: expect `layerScale` / `tracerScale` ×0.5 in XR, MSAA off, no live preview readback

## Related

- GitHub issue #85 (research track)
- [COMPARE_VIEWS.md](COMPARE_VIEWS.md) Phase 4 — WebGPU-XR
