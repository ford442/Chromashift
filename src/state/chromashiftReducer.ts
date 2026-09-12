import type { ImageEntry } from '../engine/TextureManager';
import { parseDisplayColorSpace } from '../engine/gpuOptions';
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
import type { CompareViewState } from '../engine/compareViews';
import type { MidiBinding, ReactiveSettings } from '../engine/reactive/types';

export type ChromashiftAction =
  | { type: 'reset/renderDefaults' }
  | { type: 'media/patch'; patch: Partial<MediaSlice> }
  | { type: 'media/patchLiveSource'; patch: Partial<import('./types').LiveSourceState> }
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
  | { type: 'ui/applyPerformanceDegrade' }
  | { type: 'reactive/patch'; patch: Partial<import('../engine/reactive/types').ReactiveSlice> }
  | { type: 'reactive/setMidiBindings'; bindings: MidiBinding[] }
  | { type: 'reactive/addMidiBinding'; binding: MidiBinding }
  | { type: 'reactive/removeMidiBinding'; param: import('../engine/reactive/types').MidiParamId }
  | { type: 'settings/apply'; settings: ChromashiftSettingsInput }
  | { type: 'compare/setLayout'; layout: import('../engine/compareViews').CompareLayoutMode }
  | { type: 'compare/setSyncPlay'; syncPlay: boolean }
  | { type: 'compare/setSlotB'; label: string; settings: ChromashiftSettingsInput }
  | { type: 'compare/setSwipePosition'; swipePosition: number }
  | { type: 'compare/setQuadLayerIndex'; quadLayerIndex: import('../engine/compareViews').QuadLayerIndex }
  | { type: 'compare/cycleQuadLayer' };

/** Serializable preset payload (excludes runtime GPU/media corpus state). */
export interface ChromashiftSettingsInput {
  layers?: Partial<LayersSlice>;
  tracers?: Partial<TracersSlice>;
  output?: Partial<Omit<OutputSlice, 'tracerInspect'>> & { tracerInspect?: Partial<TracerInspectState> };
  engine?: Pick<EngineSlice, 'fps' | 'paused' | 'engineMode' | 'avgLuminance'>;
  ui?: Pick<UiSlice, 'isAutoPlayActive' | 'imageChangeInterval' | 'referenceBlendMode' | 'overlayImageSource' | 'referenceOpacity' | 'upscaleModel'>;
  reactive?: Partial<ReactiveSettings>;
  compare?: CompareViewState;
  viewport?: { quarterZoom?: boolean; halfOverlay?: boolean; colorSpace?: import('../engine/gpuOptions').DisplayColorSpace };
  kiosk?: Pick<UiSlice, 'kioskEnabled' | 'kioskUiHidden' | 'kioskAttractMode'>;
}

/**
 * Merge `patch` into `slice`, returning `slice` itself when nothing moved.
 *
 * Several writers re-publish a value they recompute rather than one they know
 * changed — the luminance sampler re-reports the same rounded average a couple
 * of times a second, image loads re-report the same aspect ratio. Allocating a
 * new slice for those makes `useReducer` hand React a new root state, which
 * re-renders the whole UI tree for a change of nothing at all. Bailing out on a
 * no-op patch lets React skip the render entirely (`useReducer` compares the
 * returned state by identity), which is what keeps an idle session still.
 *
 * The comparison is shallow by design: a patch carrying a fresh array or object
 * (a new image list, a rebuilt opacity triple) is always treated as a change,
 * so this can never swallow a real update.
 */
function patchSlice<T extends object>(slice: T, patch: Partial<T>): T {
  let changed = false;
  for (const key of Object.keys(patch) as (keyof T)[]) {
    if (!Object.is(slice[key], patch[key])) {
      changed = true;
      break;
    }
  }
  return changed ? { ...slice, ...patch } : slice;
}

/** Re-wrap `state` with a replaced slice, keeping `state` itself when the slice did not move. */
function withSlice<K extends keyof ChromashiftState>(
  state: ChromashiftState,
  key: K,
  next: ChromashiftState[K],
): ChromashiftState {
  return Object.is(state[key], next) ? state : { ...state, [key]: next };
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
      return withSlice(state, 'media', patchSlice(state.media, action.patch));

    case 'media/patchLiveSource':
      return withSlice(state, 'media', patchSlice(state.media, {
        liveSource: patchSlice(state.media.liveSource, action.patch),
      }));

    case 'media/selectIndex':
      return withSlice(state, 'media', patchSlice(state.media, {
        currentIndex: action.index,
        previous: action.previous ?? state.media.previous,
      }));

    case 'layers/patch':
      return withSlice(state, 'layers', patchSlice(state.layers, action.patch));

    case 'layers/setTriple': {
      if (Object.is(state.layers[action.field][action.layer], action.value)) return state;
      const next = [...state.layers[action.field]] as LayerTriple<number>;
      next[action.layer] = action.value;
      return withSlice(state, 'layers', { ...state.layers, [action.field]: next });
    }

    case 'tracers/patch':
      return withSlice(state, 'tracers', patchSlice(state.tracers, action.patch));

    case 'output/patch':
      return withSlice(state, 'output', patchSlice(state.output, action.patch));

    case 'output/patchInspect':
      return withSlice(state, 'output', patchSlice(state.output, {
        tracerInspect: patchSlice(state.output.tracerInspect, action.patch),
      }));

    case 'output/resetInspectView':
      return {
        ...state,
        output: {
          ...state.output,
          tracerInspect: { ...state.output.tracerInspect, zoom: 1, pan: { x: 0, y: 0 } },
        },
      };

    case 'engine/patch':
      return withSlice(state, 'engine', patchSlice(state.engine, action.patch));

    case 'ui/patch':
      return withSlice(state, 'ui', patchSlice(state.ui, action.patch));

    case 'ui/patchVideoExport':
      return withSlice(state, 'ui', patchSlice(state.ui, {
        videoExportSettings: patchSlice(state.ui.videoExportSettings, action.patch),
      }));

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

    case 'ui/applyPerformanceDegrade': {
      const nextTracerScale = Math.max(0.5, Math.round(state.tracers.scale * 0.75 * 100) / 100);
      return {
        ...state,
        output: {
          ...state.output,
          antialiasEnabled: false,
          livePreviewEnabled: false,
        },
        tracers: {
          ...state.tracers,
          scale: nextTracerScale,
        },
      };
    }

    case 'reactive/patch':
      return { ...state, reactive: { ...state.reactive, ...action.patch } };

    case 'reactive/setMidiBindings':
      return {
        ...state,
        reactive: { ...state.reactive, midiBindings: [...action.bindings] },
      };

    case 'reactive/addMidiBinding':
      return {
        ...state,
        reactive: {
          ...state.reactive,
          midiBindings: [
            ...state.reactive.midiBindings.filter((b) => b.param !== action.binding.param),
            action.binding,
          ],
        },
      };

    case 'reactive/removeMidiBinding':
      return {
        ...state,
        reactive: {
          ...state.reactive,
          midiBindings: state.reactive.midiBindings.filter((b) => b.param !== action.param),
        },
      };

    case 'settings/apply':
      return applySettingsToState(state, action.settings);

    case 'compare/setLayout':
      // Kiosk mode owns the full viewport; multi-view layouts are incompatible.
      if (action.layout !== 'single' && state.ui.kioskEnabled) return state;
      return {
        ...state,
        ui: { ...state.ui, compareView: { ...state.ui.compareView, layout: action.layout } },
      };

    case 'compare/setSyncPlay':
      return {
        ...state,
        ui: { ...state.ui, compareView: { ...state.ui.compareView, syncPlay: action.syncPlay } },
      };

    case 'compare/setSlotB':
      return {
        ...state,
        ui: {
          ...state.ui,
          compareView: {
            ...state.ui.compareView,
            slotB: { id: 'b', label: action.label, settings: action.settings },
          },
        },
      };

    case 'compare/setSwipePosition':
      return {
        ...state,
        ui: {
          ...state.ui,
          compareView: {
            ...state.ui.compareView,
            swipePosition: Math.max(0, Math.min(1, action.swipePosition)),
          },
        },
      };

    case 'compare/setQuadLayerIndex':
      return {
        ...state,
        ui: {
          ...state.ui,
          compareView: {
            ...state.ui.compareView,
            quadLayerIndex: action.quadLayerIndex,
          },
        },
      };

    case 'compare/cycleQuadLayer': {
      const next = ((state.ui.compareView.quadLayerIndex + 1) % 3) as import('../engine/compareViews').QuadLayerIndex;
      return {
        ...state,
        ui: {
          ...state.ui,
          compareView: { ...state.ui.compareView, quadLayerIndex: next },
        },
      };
    }

    default:
      return state;
  }
}

/**
 * Pure merge of a serializable settings snapshot over full app state.
 * Used both by the `settings/apply` reducer case and by the render loop to
 * build compare-slot states, so both paths share identical merge semantics.
 */
export function applySettingsToState(
  state: ChromashiftState,
  settings: ChromashiftSettingsInput,
): ChromashiftState {
  let next: ChromashiftState = {
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
    reactive: settings.reactive
      ? {
          ...state.reactive,
          ...settings.reactive,
          midiBindings: settings.reactive.midiBindings
            ? [...settings.reactive.midiBindings]
            : state.reactive.midiBindings,
        }
      : state.reactive,
  };

  if (settings.viewport) {
    next = {
      ...next,
      output: {
        ...next.output,
        viewportQuarterZoom: settings.viewport.quarterZoom ?? next.output.viewportQuarterZoom,
        viewportHalfOverlay: settings.viewport.halfOverlay ?? next.output.viewportHalfOverlay,
        displayColorSpace: settings.viewport.colorSpace
          ? parseDisplayColorSpace(settings.viewport.colorSpace)
          : next.output.displayColorSpace,
      },
    };
  }

  if (settings.kiosk) {
    next = {
      ...next,
      ui: {
        ...next.ui,
        kioskEnabled: settings.kiosk.kioskEnabled ?? next.ui.kioskEnabled,
        kioskUiHidden: settings.kiosk.kioskUiHidden ?? next.ui.kioskUiHidden,
        kioskAttractMode: settings.kiosk.kioskAttractMode ?? next.ui.kioskAttractMode,
      },
    };
  }

  if (settings.compare) {
    const compare = settings.compare;
    next = {
      ...next,
      ui: {
        ...next.ui,
        compareView: {
          ...next.ui.compareView,
          ...compare,
          quadLayerIndex: compare.quadLayerIndex ?? next.ui.compareView.quadLayerIndex,
          slotA: compare.slotA
            ? {
                ...next.ui.compareView.slotA,
                ...compare.slotA,
                settings: compare.slotA.settings
                  ? { ...next.ui.compareView.slotA.settings, ...compare.slotA.settings }
                  : next.ui.compareView.slotA.settings,
              }
            : next.ui.compareView.slotA,
          slotB: compare.slotB
            ? {
                ...next.ui.compareView.slotB,
                ...compare.slotB,
                settings: compare.slotB.settings
                  ? { ...next.ui.compareView.slotB.settings, ...compare.slotB.settings }
                  : next.ui.compareView.slotB.settings,
              }
            : next.ui.compareView.slotB,
        },
      },
    };
  }

  return next;
}

export { createInitialState };
