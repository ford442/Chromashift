import type { ChromashiftSettingsInput } from './chromashiftReducer';

export interface BuiltinPreset {
  id: string;
  name: string;
  description: string;
  settings: ChromashiftSettingsInput;
}

/**
 * Built-in preset gallery. Each entry is a partial settings patch applied on
 * top of the current state via the settings/apply reducer action, so presets
 * only need to name the fields they care about.
 */
export const BUILTIN_PRESETS: readonly BuiltinPreset[] = [
  {
    id: 'classic-cr0p',
    name: 'Classic CR0P',
    description: 'Original CR0P fixed palette, hard bands, mixed output',
    settings: {
      layers: { colorMode: 0, sobelEnabled: false, softCropEnabled: false, opacity: 1, opacities: [1, 1, 1] },
      tracers: { aboveIntensity: 0.85, belowIntensity: 0.3, mode: 0, layerBlendMode: 0, tracerBlendMode: 0 },
      output: { outputMode: 0, diagnosticsMode: false, stampBoost: 1.8 },
    },
  },
  {
    // A full patch, not a tweak: presets merge partially, so every field that
    // differs from the cr0p.1ink.us look is named here or the session default
    // leaks through. cr0p's middle spin rate is unconfirmed (its knob is
    // partly hidden); 230 is assumed until it is read off the reference.
    // Layer 0's reverse spin is fixed in the engine and has no setting.
    id: 'cr0p-reference',
    name: 'cr0p Defaults',
    description: 'cr0p.1ink.us look: CROP palette, hard bands, one thin tracer',
    settings: {
      layers: {
        count: 3,
        angles: [0, 0, 0],
        extensions: [130, 230, 330],
        colorMode: 2,
        sobelEnabled: false,
        softCropEnabled: false,
        opacity: 1,
        opacities: [1, 1, 1],
        scale: 1,
      },
      tracers: {
        aboveIntensity: 0.85,
        aboveDuration: 500,
        belowIntensity: 0,
        belowDuration: 2000,
        mode: 0,
        scale: 1,
        layerBlendMode: 0,
        tracerBlendMode: 0,
        motionMode: 'off',
      },
      output: { outputMode: 0, diagnosticsMode: false, stampBoost: 1.8 },
    },
  },
  {
    id: 'soft-glow',
    name: 'Soft Glow',
    description: 'Gradient bands, soft crop, screen-blended layers',
    settings: {
      layers: { colorMode: 1, softCropEnabled: true, sobelEnabled: false, opacity: 0.9 },
      tracers: { aboveIntensity: 0.6, belowIntensity: 0.25, layerBlendMode: 4, tracerBlendMode: 4 },
      output: { outputMode: 0, diagnosticsMode: false, stampBoost: 1.2 },
    },
  },
  {
    id: 'diagnostic-overlap',
    name: 'Diagnostic Overlap',
    description: 'Collision diagnostics overlay for tuning band overlap',
    settings: {
      layers: { colorMode: 0 },
      output: { outputMode: 0, diagnosticsMode: true, diagnosticsOpacity: 0.85, peakCollisionsOnly: false },
    },
  },
  {
    id: 'tracer-focus',
    name: 'Tracer Focus',
    description: 'Long-lived tracers layered above the live output',
    settings: {
      tracers: { aboveIntensity: 1, belowIntensity: 0.6, aboveDuration: 1500, belowDuration: 4000 },
      output: { outputMode: 1, diagnosticsMode: false, stampBoost: 2.2 },
    },
  },
];

export function findBuiltinPreset(id: string): BuiltinPreset | null {
  return BUILTIN_PRESETS.find((preset) => preset.id === id) ?? null;
}
