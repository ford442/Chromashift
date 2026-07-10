# Archived one-shot scripts

**Do not run these.** They are non-idempotent string-replace patches that were applied
manually during development and kept only for historical reference.

| Script | Target | Era |
|---|---|---|
| `patch.cjs` | `WebGPURenderer.ts` | MSAA `sampleCount` / compositor pass fix |
| `patch2.cjs` | `WebGPURenderer.ts` | Force `layerTextures` to `sampleCount: 1` |
| `patch3.cjs` | `App.tsx` | Preview canvas update-once-per-image guard |

The live sources already contain these changes. Re-running any script will corrupt files.
