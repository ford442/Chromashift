import type { ImageEntry } from '../engine/TextureManager';
import {
  DEFAULT_ANGLES,
  DEFAULT_EXTENSIONS,
  DEFAULT_FPS,
  createInitialState,
} from './defaults';
import type {
  ChromashiftState,
  EngineSlice,
  LayersSlice,
  LayerTriple,
  MediaSlice,
  OutputSlice,
  TracerInspectState,
  TracersSlice,
  UiSlice,
} from './types';

export type ChromashiftAction =
  | { type: 'reset/renderDefaults' }
  | { type: 'media/patch'; patch: Partial<MediaSlice> }
  | { type: 'media/selectIndex'; index: number; previous?: ImageEntry | null }
  | { type: 'layers/patch'; patch: Partial<LayersSlice> }
  | { type: 'layers/setTriple'; field: 'angles' | 'extensions' | 'opacities'; layer: 0 | 1 | 2; value: number }
  | { type: 'tracers/patch'; patch: Partial<TracersSlice> }
  | { type: 'output/patch'; patch: Partial<OutputSlice> }
  | { type: 'output/patchInspect'; patch: Partial<TracerInspectState> }
  | { type: 'output/resetInspectView' }
  | { type: 'engine/patch'; patch: Partial<EngineSlice> }
  | { type: 'ui/patch'; patch: Partial<UiSlice> }
  | { type: 'ui/patchVideoExport'; patch: Partial<import('./types').VideoExportSettings> }
  | { type: 'ui/togglePaused' }
  | { type: 'ui/toggleImageStrip' }
  | { type: 'ui/toggleTracerHeatmap' }
  | { type: 'settings/apply'; settings: ChromashiftSettingsInput };

/** Serializable preset payload (excludes runtime GPU/media corpus state). */
export interface ChromashiftSettingsInput {
  layers?: Partial<LayersSlice>;
  tracers?: Partial<TracersSlice>;
  output?: Partial<Omit<OutputSlice, 'tracerInspect'>> & { tracerInspect?: Partial<TracerInspectState> };
  engine?: Pick<EngineSlice, 'fps' | 'paused' | 'engineMode' | 'avgLuminance'>;
  ui?: Pick<UiSlice, 'isAutoPlayActive' | 'imageChangeInterval' | 'referenceBlendMode' | 'referenceOpacity' | 'upscaleModel'>;
}

export function chromashiftReducer(
  state: ChromashiftState,
  action: ChromashiftAction,
): ChromashiftState {
  switch (action.type) {
    case 'reset/renderDefaults':
      return {
        ...state,
        layers: {
          ...state.layers,
          angles: [...DEFAULT_ANGLES],
          extensions: [...DEFAULT_EXTENSIONS],
        },
        engine: { ...state.engine, fps: DEFAULT_FPS },
      };

    case 'media/patch':
      return { ...state, media: { ...state.media, ...action.patch } };

    case 'media/selectIndex':
      return {
        ...state,
        media: {
          ...state.media,
          currentIndex: action.index,
          previous: action.previous ?? state.media.previous,
        },
      };

    case 'layers/patch':
      return { ...state, layers: { ...state.layers, ...action.patch } };

    case 'layers/setTriple': {
      const next = [...state.layers[action.field]] as LayerTriple<number>;
      next[action.layer] = action.value;
      return { ...state, layers: { ...state.layers, [action.field]: next } };
    }

    case 'tracers/patch':
      return { ...state, tracers: { ...state.tracers, ...action.patch } };

    case 'output/patch':
      return { ...state, output: { ...state.output, ...action.patch } };

    case 'output/patchInspect':
      return {
        ...state,
        output: {
          ...state.output,
          tracerInspect: { ...state.output.tracerInspect, ...action.patch },
        },
      };

    case 'output/resetInspectView':
      return {
        ...state,
        output: {
          ...state.output,
          tracerInspect: { ...state.output.tracerInspect, zoom: 1, pan: { x: 0, y: 0 } },
        },
      };

    case 'engine/patch':
      return { ...state, engine: { ...state.engine, ...action.patch } };

    case 'ui/patch':
      return { ...state, ui: { ...state.ui, ...action.patch } };

    case 'ui/patchVideoExport':
      return {
        ...state,
        ui: {
          ...state.ui,
          videoExportSettings: { ...state.ui.videoExportSettings, ...action.patch },
        },
      };

    case 'ui/togglePaused':
      return { ...state, engine: { ...state.engine, paused: !state.engine.paused } };

    case 'ui/toggleImageStrip':
      return { ...state, ui: { ...state.ui, isImageStripOpen: !state.ui.isImageStripOpen } };

    case 'ui/toggleTracerHeatmap':
      return {
        ...state,
        output: {
          ...state.output,
          tracerInspect: {
            ...state.output.tracerInspect,
            heatmap: !state.output.tracerInspect.heatmap,
          },
        },
      };

    case 'settings/apply': {
      const { settings } = action;
      return {
        ...state,
        layers: settings.layers ? { ...state.layers, ...settings.layers } : state.layers,
        tracers: settings.tracers ? { ...state.tracers, ...settings.tracers } : state.tracers,
        output: settings.output
          ? {
              ...state.output,
              ...settings.output,
              tracerInspect: settings.output.tracerInspect
                ? { ...state.output.tracerInspect, ...settings.output.tracerInspect }
                : state.output.tracerInspect,
            }
          : state.output,
        engine: settings.engine ? { ...state.engine, ...settings.engine } : state.engine,
        ui: settings.ui ? { ...state.ui, ...settings.ui } : state.ui,
      };
    }

    default:
      return state;
  }
}

export { createInitialState };
