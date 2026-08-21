# Presets & Shareable URLs

Chromashift render settings (layers, tracers, blend/output modes, engine tuning, reactive toggles, compare layout, viewport transforms, kiosk flags) can be saved, shared, and restored as **presets**.

## Schema

`serializeSettings()` (`src/state/serializeSettings.ts`) produces a versioned document:

```json
{
  "version": 4,
  "settings": {
    "layers": { "colorProfileId": "cr0p-classic", "colorProfile": null, "…": "…" },
    "tracers": { "…": "…" },
    "output": { "…": "…" },
    "engine": { "fps": 30, "paused": false, "engineMode": "ts", "avgLuminance": 128 },
    "ui": { "isAutoPlayActive": true, "imageChangeInterval": 5, "…": "…" },
    "reactive": {
      "enabled": false,
      "audioEnabled": false,
      "midiEnabled": false,
      "audioSensitivity": 1,
      "midiBindings": []
    },
    "viewport": { "quarterZoom": false, "halfOverlay": false, "colorSpace": "srgb" },
    "compare": {
      "layout": "single",
      "syncPlay": true,
      "swipePosition": 0.5,
      "slotA": { "id": "a", "label": "Live", "settings": {} },
      "slotB": { "id": "b", "label": "Preset B", "settings": {} }
    },
    "kiosk": {
      "kioskEnabled": false,
      "kioskUiHidden": false,
      "kioskAttractMode": false
    }
  }
}
```

`SETTINGS_SCHEMA_VERSION` is **4**. Runtime-only state (GPU handles, media corpus, export progress, mic/MIDI runtime errors, GPU timing sparklines) is never serialized.

### v3 field groups

| Key | Purpose |
|-----|---------|
| `layers` / `tracers` / `output` / `engine` / `ui` | Core render + playback settings (same as v1) |
| `output.performanceHudEnabled` / `performanceAutoDegrade` | Diagnostics perf HUD toggles |
| `reactive` | Master toggles (`enabled`, `audioEnabled`, `midiEnabled`) plus sensitivity and MIDI bindings |
| `viewport` | Quarter-zoom, half-overlay, and canvas `colorSpace` (`srgb` / `display-p3`, v4) |
| `compare` | Multi-view layout, sync play, swipe position, and slot A/B `ChromashiftSettingsInput` bags |
| `kiosk` | Installation-mode flags (`kioskEnabled`, `kioskUiHidden`, `kioskAttractMode`) |
| `layers.colorProfileId` | Active named colour profile (v3) — see [COLOR_PROFILES.md](COLOR_PROFILES.md) |
| `layers.colorProfile` | Full profile table, embedded for user profiles in file exports; `null` for built-ins and in share URLs |

## Migration from v1 / v2

- **Reading:** `deserializeSettings()` accepts `version: 1`–`4` documents and normalizes them to v4 (`migrateToLatest`). Older URLs and saved files continue to work.
- **Writing:** All new exports (share URL, JSON file, localStorage save) emit `version: 4`.
- **v3 → v4 canvas colour space:** missing `viewport.colorSpace` defaults to `srgb`. Display P3 is opt-in.
- **v2 → v3 colour profiles:** documents that predate profiles migrate to `cr0p-classic`, the look they were saved with. An embedded profile table is re-validated on read and dropped when invalid or when its `id` doesn't match `colorProfileId`. Share URLs omit the table and carry the id alone to stay short.
- **v1 → v2 defaults:** Missing reactive toggles default to `false`. Missing `viewport` is hoisted from legacy `output.viewportQuarterZoom` / `viewportHalfOverlay` when present. Missing `compare` and `kiosk` default to the app's initial single-view / non-kiosk state.
- **Kiosk precedence:** When both a preset and `?kiosk=1` are present, the URL installation bootstrap wins (hides chrome, forces autoplay, etc.).

Built-in gallery entries in `src/state/presetGallery.ts` remain partial `ChromashiftSettingsInput` patches (no document version) and work with both schema versions.

## URL sharing

`src/state/presetUrl.ts` encodes the document as base64url in a `?preset=` parameter:

- **Copy URL** in the Presets panel writes the share link to the clipboard and mirrors it into the address bar (`history.replaceState`), so a plain reload keeps the look.
- On startup, `createInitialStateFromUrl()` runs inside the store's `useReducer` lazy initializer — the preset is applied **before the first render commit**, so there is no flash of default settings.
- An invalid/corrupted/wrong-version preset falls back to defaults and sets `ui.presetLoadError`, shown as a friendly message in the Presets panel.

## Presets panel (NUNIF Controls → 💾 Presets)

- **Gallery** — built-in looks from `src/state/presetGallery.ts`: Classic CR0P, Soft Glow, Diagnostic Overlap, Tracer Focus. Each is a partial settings patch applied via the `settings/apply` reducer action.
- **My Presets** — named presets persisted in `localStorage` (`chromashift.presets`, via `src/state/presetLibrary.ts`). Save / load / delete. Stored documents are re-validated on read so a stale schema can't be applied.
- **Share** — Copy URL, Export (downloads `chromashift-preset.json`), Import (applies a preset file, with a friendly error for invalid files).

## Tests

`src/state/serializeSettings.test.ts` and `src/state/presetUrl.test.ts` cover v2 round-trip for all new field groups, v1 backward compatibility, schema version enforcement, invalid-preset fallback, kiosk URL precedence, and gallery preset URL round-trip.

## Future

Cloud preset library and a community share page on 1ink.us.
