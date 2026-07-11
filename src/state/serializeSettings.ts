import type { ChromashiftState } from './types';
import type { ChromashiftSettingsInput } from './chromashiftReducer';

export const SETTINGS_SCHEMA_VERSION = 1 as const;

export interface ChromashiftSettingsDocument {
  version: typeof SETTINGS_SCHEMA_VERSION;
  settings: ChromashiftSettingsInput;
}

export function serializeSettings(state: ChromashiftState): ChromashiftSettingsDocument {
  const { layers, tracers, output, engine, ui, reactive } = state;
  const {
    tracerInspect,
    tracerPreviewFrozen: _tracerPreviewFrozen,
    livePreviewEnabled: _livePreviewEnabled,
    ...outputPreset
  } = output;
  void _tracerPreviewFrozen;
  void _livePreviewEnabled;

  return {
    version: SETTINGS_SCHEMA_VERSION,
    settings: {
      layers: { ...layers },
      tracers: { ...tracers },
      output: {
        ...outputPreset,
        tracerInspect: { ...tracerInspect },
      },
      engine: {
        fps: engine.fps,
        paused: engine.paused,
        engineMode: engine.engineMode,
        avgLuminance: engine.avgLuminance,
      },
      ui: {
        isAutoPlayActive: ui.isAutoPlayActive,
        imageChangeInterval: ui.imageChangeInterval,
        referenceBlendMode: ui.referenceBlendMode,
        referenceOpacity: ui.referenceOpacity,
        upscaleModel: ui.upscaleModel,
      },
      reactive: {
        audioSensitivity: reactive.audioSensitivity,
        midiBindings: reactive.midiBindings.map((b) => ({ ...b })),
      },
    },
  };
}

export function deserializeSettings(
  json: string,
): ChromashiftSettingsDocument | null {
  try {
    const parsed = JSON.parse(json) as ChromashiftSettingsDocument;
    if (parsed?.version !== SETTINGS_SCHEMA_VERSION || !parsed.settings) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function settingsToJson(state: ChromashiftState, pretty = true): string {
  return JSON.stringify(serializeSettings(state), null, pretty ? 2 : undefined);
}
