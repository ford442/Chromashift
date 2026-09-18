import type { ImageEntry } from '../engine/TextureManager';
import { countLocalEntries } from '../engine/corpusIndex';
import { parseDisplayColorSpace } from '../engine/gpuOptions';
import { clampLayerCount } from '../engine/graph/layerSpecs';
import {
  DEFAULT_FPS,
  defaultAngles,
  defaultExtensionForLayer,
  defaultExtensions,
  createInitialState,
} from './defaults';
import type {
  ChromashiftState,
  EngineSlice,
  LayersSlice,
  MediaSlice,
  OutputSlice,
  TracerInspectState,
  TracersSlice,
  UiSlice,
} from './types';
import type { CompareViewState } from '../engine/compareViews';
import type { MidiBinding, ReactiveSettings } from '../engine/reactive/types';

/** The `LayersSlice` fields that carry one value per layer. */
export type PerLayerField = 'angles' | 'extensions' | 'opacities';

const PER_LAYER_FIELDS: readonly PerLayerField[] = ['angles', 'extensions', 'opacities'];

/** Value a newly added layer gets for each per-layer field. */
const PER_LAYER_FILL: Record<PerLayerField, (index: number) => number> = {
  angles: () => 0,
  extensions: defaultExtensionForLayer,
  opacities: () => 1,
};

/**
 * Resize one per-layer array to `count`, keeping the values already there.
 *
 * Returns the original array when it is already the right length, so
 * {@link patchSlice}'s identity bail-out still works and a no-op count change
 * never re-renders the tree.
 */
function resizePerLayer(
  values: readonly number[],
  count: number,
  fill: (index: number) => number,
): number[] {
  if (values.length === count) return values as number[];
  return Array.from({ length: count }, (_, i) => (i < values.length ? values[i] : fill(i)));
}

/**
 * Bring a `LayersSlice` into the shape its `count` claims.
 *
 * The count and the three per-layer arrays are one invariant, but they arrive
 * from several directions — a preset file, a `?preset=` URL, a compare slot, the
 * layer-count control — so every writer funnels through here rather than each
 * one remembering to resize all three arrays.
 */
export function normalizeLayersSlice(layers: LayersSlice): LayersSlice {
  const count = clampLayerCount(layers.count);
  const resized = {} as Record<PerLayerField, number[]>;
  let moved = count !== layers.count;

  for (const field of PER_LAYER_FIELDS) {
    const next = resizePerLayer(layers[field] ?? [], count, PER_LAYER_FILL[field]);
    if (next !== layers[field]) moved = true;
    resized[field] = next;
  }

  return moved ? { ...layers, count, ...resized } : layers;
}

export type ChromashiftAction =
  | { type: 'reset/renderDefaults' }
  | { type: 'media/patch'; patch: Partial<MediaSlice> }
  | { type: 'media/patchLiveSource'; patch: Partial<import('./types').LiveSourceState> }
  | { type: 'media/selectIndex'; index: number; previous?: ImageEntry | null }
  | { type: 'layers/patch'; patch: Partial<LayersSlice> }
  | { type: 'layers/setCount'; count: number }
  | { type: 'layers/setPerLayer'; field: PerLayerField; layer: number; value: number }
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
          angles: defaultAngles(state.layers.count),
          extensions: defaultExtensions(state.layers.count),
        },
        engine: { ...state.engine, fps: DEFAULT_FPS },
      };

    case 'media/patch': {
      // `localCount` is derived, never dispatched: recompute it here (once per
      // corpus change) so `ImageStrip` never scans the list on a render.
      const { imageList } = action.patch;
      const patch = imageList && imageList !== state.media.imageList
        ? { ...action.patch, localCount: countLocalEntries(imageList) }
        : action.patch;
      return withSlice(state, 'media', patchSlice(state.media, patch));
    }

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
      // A patch may carry a new `count`, new arrays, or both; normalizing after
      // the merge is what keeps the two consistent however it arrived.
      return withSlice(state, 'layers', normalizeLayersSlice(patchSlice(state.layers, action.patch)));

    case 'layers/setCount': {
      const count = clampLayerCount(action.count);
      if (count === state.layers.count) return state;
      return withSlice(state, 'layers', normalizeLayersSlice({ ...state.layers, count }));
    }

    case 'layers/setPerLayer': {
      // Out-of-range writes are dropped rather than growing the array behind
      // `count`'s back — a stale MIDI binding for layer 5 in a 3-layer session
      // must not resize the session.
      if (action.layer < 0 || action.layer >= state.layers.count) return state;
      if (Object.is(state.layers[action.field][action.layer], action.value)) return state;
      const next = [...state.layers[action.field]];
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
    // A preset may carry any layer count (or, from a v1–v6 document, none at
    // all); normalizing here is what lets a 5-band preset load into a 3-band
    // session — and a legacy one load as three — without either side checking.
    layers: settings.layers
      ? normalizeLayersSlice({ ...state.layers, ...settings.layers })
      : state.layers,
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
