import { createInitialState } from './defaults';
import type { ChromashiftSettingsInput } from './chromashiftReducer';
import type { ChromashiftState } from './types';
import type { CompareViewState } from '../engine/compareViews';

export const SETTINGS_SCHEMA_VERSION = 2 as const;
export const SUPPORTED_SETTINGS_VERSIONS = [1, 2] as const;

export interface ChromashiftSettingsDocument {
  version: typeof SETTINGS_SCHEMA_VERSION;
  settings: ChromashiftSettingsInput;
}

interface RawSettingsDocument {
  version: number;
  settings: ChromashiftSettingsInput;
}

function cloneCompareView(compareView: CompareViewState): CompareViewState {
  return {
    layout: compareView.layout,
    syncPlay: compareView.syncPlay,
    swipePosition: compareView.swipePosition,
    slotA: {
      ...compareView.slotA,
      settings: { ...compareView.slotA.settings },
    },
    slotB: {
      ...compareView.slotB,
      settings: { ...compareView.slotB.settings },
    },
  };
}

function defaultCompareView(): CompareViewState {
  return cloneCompareView(createInitialState().ui.compareView);
}

/** Normalize a v1 or v2 raw document to the current v2 shape. */
export function migrateV1ToV2(doc: RawSettingsDocument): ChromashiftSettingsDocument {
  const { settings } = doc;
  const output = settings.output ? { ...settings.output } : undefined;

  const viewportQuarterZoom = settings.viewport?.quarterZoom
    ?? output?.viewportQuarterZoom
    ?? false;
  const viewportHalfOverlay = settings.viewport?.halfOverlay
    ?? output?.viewportHalfOverlay
    ?? false;

  if (output) {
    delete output.viewportQuarterZoom;
    delete output.viewportHalfOverlay;
  }

  const reactive = settings.reactive
    ? {
        enabled: settings.reactive.enabled ?? false,
        audioEnabled: settings.reactive.audioEnabled ?? false,
        midiEnabled: settings.reactive.midiEnabled ?? false,
        audioSensitivity: settings.reactive.audioSensitivity ?? 1,
        midiBindings: settings.reactive.midiBindings?.map((b) => ({ ...b })) ?? [],
      }
    : undefined;

  return {
    version: SETTINGS_SCHEMA_VERSION,
    settings: {
      ...settings,
      output,
      reactive,
      viewport: {
        quarterZoom: viewportQuarterZoom,
        halfOverlay: viewportHalfOverlay,
      },
      compare: settings.compare
        ? cloneCompareView(settings.compare)
        : defaultCompareView(),
      kiosk: {
        kioskEnabled: settings.kiosk?.kioskEnabled ?? false,
        kioskUiHidden: settings.kiosk?.kioskUiHidden ?? false,
        kioskAttractMode: settings.kiosk?.kioskAttractMode ?? false,
      },
    },
  };
}

export function serializeSettings(state: ChromashiftState): ChromashiftSettingsDocument {
  const { layers, tracers, output, engine, ui, reactive } = state;
  const {
    tracerInspect,
    tracerPreviewFrozen: _tracerPreviewFrozen,
    livePreviewEnabled: _livePreviewEnabled,
    viewportQuarterZoom,
    viewportHalfOverlay,
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
        overlayImageSource: ui.overlayImageSource,
        referenceOpacity: ui.referenceOpacity,
        upscaleModel: ui.upscaleModel,
      },
      reactive: {
        enabled: reactive.enabled,
        audioEnabled: reactive.audioEnabled,
        midiEnabled: reactive.midiEnabled,
        audioSensitivity: reactive.audioSensitivity,
        midiBindings: reactive.midiBindings.map((b) => ({ ...b })),
      },
      viewport: {
        quarterZoom: viewportQuarterZoom,
        halfOverlay: viewportHalfOverlay,
      },
      compare: cloneCompareView(ui.compareView),
      kiosk: {
        kioskEnabled: ui.kioskEnabled,
        kioskUiHidden: ui.kioskUiHidden,
        kioskAttractMode: ui.kioskAttractMode,
      },
    },
  };
}

export function deserializeSettings(
  json: string,
): ChromashiftSettingsDocument | null {
  try {
    const parsed = JSON.parse(json) as RawSettingsDocument;
    if (
      !parsed?.settings
      || !SUPPORTED_SETTINGS_VERSIONS.includes(parsed.version as (typeof SUPPORTED_SETTINGS_VERSIONS)[number])
    ) {
      return null;
    }
    return migrateV1ToV2(parsed);
  } catch {
    return null;
  }
}

export function settingsToJson(state: ChromashiftState, pretty = true): string {
  return JSON.stringify(serializeSettings(state), null, pretty ? 2 : undefined);
}
