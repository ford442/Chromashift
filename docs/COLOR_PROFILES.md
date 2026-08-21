# Named Colour Profiles

Chromashift's colour separation used to be one hard-coded look: the classic CR0P band
table (orange/red, violet/blue, green/yellow) baked into `shared/band.json` and codegen'd
into TS / WGSL / GLSL / C++. **Colour profiles** turn that single look into a selectable,
shareable document — built-in alternates, artist palettes, or a monochrome diagnostic
wedge — without forking a shader per palette.

- Selector: **NUNIF → Layers → Colour profile**
- Data: `shared/colorProfiles.json` (built-ins), localStorage `chromashift.colorProfiles` (yours)
- Code: `src/engine/color/colorProfile.ts`, `colorProfileLibrary.ts`, `ProfileLutTexture.ts`
- State: `layers.colorProfileId` + `layers.colorProfile` (preset schema v3+)
- Working space: LUTs are **sRGB**. The Viewport Display P3 control only changes WebGPU canvas `colorSpace`, not the baked table.

## Built-in profiles

| Id | Name | What it is |
|----|------|-----------|
| `cr0p-classic` | CR0P Classic | The original fixed-colour scale — grey highlight, orange/red, violet/blue, green/yellow, avgLuminance-driven desaturation and grey shadows. **Default.** |
| `cr0p-soft-gradient` | Soft Gradient Revival | The archived HSL gradient scale ([archive/new_color_scale.md](archive/new_color_scale.md)) — smooth per-band ramps on raw luminance, transparent shadows, no border bands. |
| `diagnostic-grey` | Diagnostic Grey | Monochrome step wedge, one flat grey per band. Band boundaries read as hard edges, which makes threshold placement and rotation alignment easy to inspect. |

Switching is live — no reload, no pipeline recreation.

## Rendering strategy — hybrid (option C)

Three strategies were considered:

| Approach | Pros | Cons |
|----------|------|------|
| A. Uniform LUT texture for every profile | One shader path; TS and C++ build the same LUT | Classic's sub-unit soft-threshold blends quantize to integer buckets |
| B. Codegen a WGSL/GLSL snippet per profile | Maximum parity with today's branchy shaders | Pipeline recreation on every switch; larger bundle |
| **C. Hybrid (shipped)** | Classic keeps its exact branchy shader — zero risk to the default look; every other profile is one LUT sample | Two code paths to test |

**Shipped: C.** `cr0p-classic` renders through the existing branchy WGSL/GLSL, so classic
pixel output is unchanged from before profiles existed (`buildRendererState` emits
`colorProfileMode: 0` and no LUT). Any other profile bakes a **256 × 3 RGBA8 LUT** —
column = preprocessed luminance bucket, row = layer index — that both renderers sample:

- WebGPU: layer bind group binding 5, `textureLoad(profileLut, vec2<i32>(col, layer), 0)`
- WebGL2: `u_profileLut` (NEAREST, no mips), `texelFetch(u_profileLut, ivec2(col, layer), 0)`

The LUT texture is always resident, so the bind group layout never changes; only the
texture contents are re-uploaded, and only when the baked array identity changes
(`getColorProfileLut` memoizes per profile + quantized average luminance).

Because the LUT covers the whole band decision, the `r8uint` GPU/WASM classification mask
is bypassed while a non-classic profile is active — the mask encodes classic band indices
only. The classic path continues to use it exactly as before.

## Profile document

```json
{
  "id": "artist-neon",
  "name": "Artist Neon",
  "version": 1,
  "preprocess": { "diffScale": 32, "lightDarkMode": "classic" },
  "layers": [
    { "name": "warm", "bands": [ { "name": "hot", "min": 190, "max": 255, "rgb": [255, 0, 128] } ] },
    { "name": "cool", "bands": [ … ] },
    { "name": "leaf", "bands": [ … ] }
  ]
}
```

- `id` — 1–64 chars of letters, digits, `.`, `-`, `_`. Cannot collide with a built-in id.
- `layers` — exactly three, one per colour-separation pass, in warm / cool / leaf order.

### `preprocess`

| Field | Meaning |
|-------|---------|
| `lightDarkMode` | `classic` lifts luminance by `(128 + \|avgLum − 128\| / 2) / 2` before band lookup (original cr0p behaviour). `raw` looks up unmodified BT.709 luminance. |
| `diffScale` | Scales the desaturation term `diff = (avgLum / 255) × diffScale`, applied through `diffTint`. |

### Bands

Bounds are **`min` exclusive, `max` inclusive** — `value > min && value <= max` — matching
the `rgb > threshold` rule of the original band table. Bands within a layer must not
overlap; the first match wins. A value covered by no band of that layer is transparent,
which is how a layer "ignores" luminance ranges owned by the other two.

| Field | Meaning |
|-------|---------|
| `rgb` | Band colour, 0–255 per channel |
| `rgbTo` | Optional — ramps linearly from `rgb` at `min` to `rgbTo` at `max` |
| `alpha` | Optional band opacity, 0–1 (default 1) |
| `diffTint` | Optional per-channel multiplier for `diff`, subtracted from `rgb` (this is how classic's `128 − diff` orange is expressed) |
| `grey` | `highlight` → `(avgLum + (value − min)) / 255`; `shadow` → `(avgLum − (value − greyPivot)) / 255` |
| `greyPivot` | Pivot for `grey: "shadow"` (default 128) |

`cr0p-classic`'s band bounds must stay identical to `shared/band.json` —
`src/engine/color/colorProfile.test.ts` fails if they drift.

## Import / export

The Layers panel has **Import** (JSON file → validated → stored in your local library and
selected) and **Export** (downloads the active profile as `<id>.json`). Invalid documents
are rejected with a specific message ("layers[0].bands[2]: max must be greater than min")
and the current profile stays active — a bad file never reaches the renderer.

Profiles are validated on every read path: file import, localStorage load, and preset
deserialization. A stored entry that no longer validates is dropped silently.

## Presets (schema v3)

`serializeSettings` version 3 adds:

- `layers.colorProfileId` — always present
- `layers.colorProfile` — the full table, embedded for user profiles so an exported preset
  file is self-contained

v1/v2 documents predate profiles and migrate to `cr0p-classic`, the look they were saved
with. An embedded table that fails validation, or whose `id` doesn't match
`colorProfileId`, is dropped (the id alone then resolves).

**Share URLs carry the id only.** `encodeSettingsParam` serializes with
`embedColorProfile: false` so a `?preset=` parameter stays short. Recipients resolve
built-ins directly and user profiles from their own library; an id they don't have falls
back to Classic with a message in the Layers panel. Send the profile JSON alongside the
URL, or share a preset **file**, when the recipient needs a custom table.

## Resolution order

`resolveColorProfile(id, embedded)`:

1. the embedded document, when its `id` matches
2. a built-in
3. the local profile library
4. Classic (flagged `missing: true`, surfaced as a Layers-panel error)

## Testing

| Spec | Covers |
|------|--------|
| `src/engine/color/colorProfile.test.ts` | Built-in table validity, classic ↔ `shared/band.json` parity, validation errors, LUT geometry / band boundaries / gradient ramps, classic colour equations, LUT memoization, shader lookup rule |
| `src/engine/color/colorProfileLibrary.test.ts` | Import / list / delete, malformed and colliding documents, resolution order |
| `src/engine/buildRendererState.test.ts` | Classic stays on the branchy path; alternates emit a LUT; unknown ids fall back |
| `src/state/serializeSettings.test.ts` | Schema v3 round-trip, v1→v3 migration, URL vs file embedding |

## Non-goals

No node-based material editor, and no ML palette extraction — both remain research.
