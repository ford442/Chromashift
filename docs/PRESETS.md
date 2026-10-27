# Presets & Shareable URLs

Chromashift render settings (layers, tracers, blend/output modes, engine tuning, reactive toggles, compare layout, viewport transforms, kiosk flags) can be saved, shared, and restored as **presets**.

## Schema

`serializeSettings()` (`src/state/serializeSettings.ts`) produces a versioned document:

```json
{
  "version": 7,
  "settings": {
    "layers": { "count": 3, "colorProfileId": "cr0p-classic", "colorProfile": null, "…": "…" },
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

`SETTINGS_SCHEMA_VERSION` is **8**. Runtime-only state (GPU handles, media corpus, export progress, mic/MIDI runtime errors, GPU timing sparklines) is never serialized.

### v8 field group

| Key | Purpose |
|-----|---------|
| `viewport.canvasHdr` | Opt-in Canvas HDR (`hdr-extended` presentation, see [gpu-bootstrap.md](gpu-bootstrap.md)). Browsers without extended canvas tone mapping stay SDR. Exports are SDR regardless. |

v1–v7 documents load with `canvasHdr: false`. A v8 document enables HDR only
with an explicit `true`, so a preset URL that omits the flag never turns it on.

### v7 field group

| Key | Purpose |
|-----|---------|
| `layers.count` | Band layers in the session, 1–10 (one per canonical threshold in `shared/band.json`). `layers.angles`, `layers.extensions` and `layers.opacities` are exactly this long. |

A v1–v6 document predates the field and loads as three layers with its existing
triples in place. An absent or out-of-range count clamps rather than failing the
load, so a hand-edited preset degrades to the default look instead of nothing.
`?preset=` URLs omit the count at the default three — it is recoverable from
`layers.angles.length` — so a default share link is the length it always was.

### v3 field groups

| Key | Purpose |
|-----|---------|
| `layers` / `tracers` / `output` / `engine` / `ui` | Core render + playback settings (same as v1) |
| `output.performanceHudEnabled` / `performanceAutoDegrade` | Diagnostics perf HUD toggles |
| `reactive` | Master toggles (`enabled`, `audioEnabled`, `midiEnabled`) plus sensitivity and MIDI bindings. A binding's `param` is any automatable `ParamPath` (`layers.extensions.7`, `output.stampBoost`, …); one naming anything else is dropped on load |
| `viewport` | Quarter-zoom, half-overlay, and canvas `colorSpace` (`srgb` / `display-p3`, v4) |
| `compare` | Multi-view layout, sync play, swipe position, and slot A/B `ChromashiftSettingsInput` bags |
| `kiosk` | Installation-mode flags (`kioskEnabled`, `kioskUiHidden`, `kioskAttractMode`) |
| `layers.colorProfileId` | Active named colour profile (v3) — see [COLOR_PROFILES.md](COLOR_PROFILES.md) |
| `layers.colorProfile` | Full profile table, embedded for user profiles in file exports; `null` for built-ins and in share URLs |

## Validation

Every untrusted document — `?preset=` URL, imported file, localStorage entry —
is decoded through one declarative schema, `src/state/settingsSchema.ts`.
`ChromashiftSettingsInput` is *inferred* from that schema, so the type a preset
claims and the check it gets cannot drift apart.

- **Clamp and drop, never reject.** An out-of-range number is clamped to the
  range its control offers (`engine.fps: 0` → `1`); an integer field is rounded;
  an angle wraps into `[0, 360)`; a mistyped leaf or an unknown key (runtime
  state such as `ui.exportingVideo` or `engine.gpuReady`) is dropped. A bad
  entry in a per-layer array is replaced by that layer's default rather than
  removed, so later layers keep their index.
- **One warning.** `deserializeSettings()` logs a single `console.warn` listing
  every corrected path. `decodeSettingsDocument()` returns the same list as
  `issues` for callers that want to show it.
- **Only the envelope is all-or-nothing:** unparseable JSON, a missing
  `settings` object, or an unsupported `version` still reject the document and
  set `ui.presetLoadError`.
- Every numeric leaf carries `min` / `max` / `step` / `default` / `unit` /
  `label`. `settingsSchema.test.ts` checks each default against
  `createInitialState()` and checks that everything the serializer writes
  decodes with zero corrections. `deserializeSettings.fuzz.test.ts` runs 10 000
  `fast-check` documents and asserts that decoding never throws and that its
  output re-decodes to itself with no issues.

The schema combinators (`src/state/schemaFields.ts`) are in-house, not a
validation library: clamp-and-continue with a full path list is the point, and a
pass/fail library would need a custom action on every leaf to get it.

## Migration from older versions

- **Reading:** `deserializeSettings()` accepts `version: 1`–`8` documents, decodes them against `rawSettingsSchema` (the v8 schema plus the legacy keys older versions wrote), and normalizes them to v8 (`migrateToLatest`). The migrations only move and default fields; validation has already happened. Older URLs and saved files continue to work. v6 is reserved for the automation timeline (#153) and is read as a pre-count document.
- **Writing:** All new exports (share URL, JSON file, localStorage save) emit `version: 8`.
- **v7 and earlier → v8 Canvas HDR:** `viewport.canvasHdr` is `false`.
- **v6 and earlier → v7 layer count:** documents hydrate as `layers.count: 3` with their angles / rates / opacities unchanged (see the v7 section above).
- **v3 → v4 canvas colour space:** missing `viewport.colorSpace` defaults to `srgb`. Display P3 is opt-in.
- **v2 → v3 colour profiles:** documents that predate profiles migrate to `cr0p-classic`, the look they were saved with. An embedded profile table is re-validated on read and dropped when invalid or when its `id` doesn't match `colorProfileId`. Share URLs omit the table and carry the id alone to stay short.
- **v1 → v2 defaults:** Missing reactive toggles default to `false`. Missing `viewport` is hoisted from legacy `output.viewportQuarterZoom` / `viewportHalfOverlay` when present. Missing `compare` and `kiosk` default to the app's initial single-view / non-kiosk state; a partial `compare` fills in from the same default.
- **Kiosk precedence:** When both a preset and `?kiosk=1` are present, the URL installation bootstrap wins (hides chrome, forces autoplay, etc.).

Built-in gallery entries in `src/state/presetGallery.ts` remain partial `ChromashiftSettingsInput` patches (no document version) and work with every schema version.

## URL sharing

`src/state/presetUrl.ts` encodes the document as base64url in a `?preset=` parameter:

- **Copy URL** in the Presets panel writes the share link to the clipboard and mirrors it into the address bar (`history.replaceState`), so a plain reload keeps the look.
- On startup, `createInitialStateFromUrl()` runs inside the store's `useReducer` lazy initializer — the preset is applied **before the first render commit**, so there is no flash of default settings.
- An invalid/corrupted/wrong-version preset falls back to defaults and sets `ui.presetLoadError`, shown as a friendly message in the Presets panel.

## Presets panel (NUNIF Controls → 💾 Presets)

- **Gallery** — built-in looks from `src/state/presetGallery.ts`: Classic CR0P, Soft Glow, Diagnostic Overlap, Tracer Focus. Each is a partial settings patch applied via the `settings/apply` reducer action.
- **My Presets** — named presets persisted in `localStorage` (`chromashift.presets`, via `src/state/presetLibrary.ts`). Save / load / delete. Stored documents are decoded on read, and the *decoded* document is what gets applied, so a stale or hand-edited entry can't reach the reducer.
- **Share** — Copy URL, Export (downloads `chromashift-preset.json`), Import (applies a preset file, with a friendly error for invalid files).

## Tests

`src/state/settingsSchema.test.ts` and `src/state/deserializeSettings.fuzz.test.ts` cover the validation boundary (see above). `src/state/serializeSettings.test.ts` and `src/state/presetUrl.test.ts` cover round-trip for every field group (including the v7 layer count), v1–v6 backward compatibility, schema version enforcement, invalid-preset fallback, kiosk URL precedence, and gallery preset URL round-trip.

## Future

Cloud preset library and a community share page on 1ink.us.
