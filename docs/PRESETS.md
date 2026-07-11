# Presets & Shareable URLs

Chromashift render settings (layers, tracers, blend/output modes, engine tuning) can be saved, shared, and restored as **presets**.

## Schema

`serializeSettings()` (`src/state/serializeSettings.ts`) produces a versioned document:

```json
{ "version": 1, "settings": { "layers": {…}, "tracers": {…}, "output": {…}, "engine": {…}, "ui": {…} } }
```

`SETTINGS_SCHEMA_VERSION` gates deserialization — documents with a different version are rejected (returning `null`) so future migrations have a hook. Runtime-only state (GPU handles, media corpus, export progress) is never serialized.

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

`src/state/presetUrl.test.ts` covers the acceptance criteria: URL round-trip restores identical layer rates/tracers/modes, the schema version field is enforced, invalid presets fall back to defaults with an error message, and every gallery preset applies cleanly and survives a URL round-trip.

## Future

Cloud preset library and a community share page on 1ink.us.
