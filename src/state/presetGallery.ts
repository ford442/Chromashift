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
