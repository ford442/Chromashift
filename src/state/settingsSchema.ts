/**
 * The preset / share-URL settings format, as one declarative schema.
 *
 * `ChromashiftSettingsInput` (what `settings/apply` merges into state) is
 * inferred from {@link settingsSchema}, and `deserializeSettings` decodes every
 * untrusted document through {@link rawSettingsSchema} — so the type a preset
 * claims and the check it gets are the same object and cannot drift apart.
 *
 * Every numeric leaf carries its range, default, step, unit and label. The
 * ranges are the UI's: a value a slider cannot reach is clamped on load, so a
 * hand-edited or crafted preset can never put the session somewhere the
 * controls cannot get it back from. `settingsSchema.test.ts` checks each
 * default against `createInitialState()`.
 *
 * Only fields a preset may set are here. Runtime state (`engine.gpuReady`,
 * `ui.exportingVideo`, …) has no key, so the decoder drops it with a warning.
 */

import { MOTION_MODES } from '../engine/motionModes';
import {
  DEFAULT_MOTION_DECAY_BIAS,
  DEFAULT_MOTION_GAIN,
  DEFAULT_MOTION_THRESHOLD,
} from '../engine/motionModes';
import { MAX_LAYER_COUNT } from '../engine/graph/layerSpecs';
import { MAIN_VIEW_MODES } from '../engine/viewModes';
import { parseColorProfile, type ColorProfile } from '../engine/color/colorProfile';
import { MIDI_PARAM_LABELS, type MidiParamId } from '../engine/reactive/types';
import type { MainViewMode } from '../engine/viewModes';
import type { OverlayImageSource, ReferenceBlendMode } from '../components/overlay/types';
import type { CompareLayoutMode, QuadLayerIndex } from '../engine/compareViews';
import type { DisplayColorSpace } from '../engine/gpuOptions';
import {
  DEFAULT_DIAGNOSTICS_OPACITY,
  DEFAULT_FPS,
  DEFAULT_LAYER_COUNT,
  DEFAULT_STAMP_BOOST,
  DEFAULT_TRACER_ABOVE_INTENSITY,
  DEFAULT_TRACER_BELOW_INTENSITY,
  DEFAULT_TRACER_INSPECT_EXPOSURE,
  defaultExtensionForLayer,
} from './defaults';
import {
  array,
  bool,
  custom,
  ignored,
  nullable,
  num,
  object,
  oneOf,
  str,
  struct,
  type Infer,
} from './schemaFields';

/** Number of composite blend modes (`engine/blendModes.ts`, ids 0–12). */
const BLEND_MODE_MAX = 12;
/** Longest free-text id or label a preset may carry. */
const MAX_ID_LENGTH = 64;
const MAX_LABEL_LENGTH = 200;
/** More bindings than any controller surface has knobs. */
const MAX_MIDI_BINDINGS = 128;

const MAIN_VIEW_MODE_VALUES = Object.values(MAIN_VIEW_MODES) as MainViewMode[];
const REFERENCE_BLEND_MODES = [
  'hidden', 'overlay', 'split', 'checker', 'difference', 'edge',
] as const satisfies readonly ReferenceBlendMode[];
const OVERLAY_IMAGE_SOURCES = [
  'source', 'reference', 'previous', 'separated',
] as const satisfies readonly OverlayImageSource[];
const DISPLAY_COLOR_SPACES = ['srgb', 'display-p3'] as const satisfies readonly DisplayColorSpace[];
const COMPARE_LAYOUTS = ['single', 'dual', 'quad', 'swipe'] as const satisfies readonly CompareLayoutMode[];
const QUAD_LAYER_INDICES = [0, 1, 2] as const satisfies readonly QuadLayerIndex[];
const MIDI_PARAM_IDS = Object.keys(MIDI_PARAM_LABELS) as MidiParamId[];

const unitInterval = (label: string, defaultValue: number) =>
  num({ min: 0, max: 1, step: 0.01, default: defaultValue, label });

const colorProfileSchema = custom<ColorProfile>((input) => {
  const { profile, error } = parseColorProfile(input);
  return profile ? { value: profile } : { error: error ?? 'invalid colour profile' };
});

export const layersSchema = object({
  count: num({
    min: 1, max: MAX_LAYER_COUNT, step: 1, default: DEFAULT_LAYER_COUNT,
    integer: true, automatable: false, label: 'Layer count',
  }),
  angles: array(
    num({ min: 0, max: 360, step: 1, default: 0, curve: 'angle', unit: '°', label: 'Layer angle' }),
    { maxLength: MAX_LAYER_COUNT, fill: () => 0 },
  ),
  extensions: array(
    // Per-frame spin at 30 FPS; wall-clock °/s = value × 30. Not modular —
    // 360 at 60 FPS is a half turn a frame, 0 is still — so it clamps.
    num({ min: 0, max: 360, step: 1, default: defaultExtensionForLayer(0), unit: '°', label: 'Layer rate' }),
    { maxLength: MAX_LAYER_COUNT, fill: defaultExtensionForLayer },
  ),
  opacity: unitInterval('Layer opacity', 1),
  opacities: array(unitInterval('Layer opacity', 1), { maxLength: MAX_LAYER_COUNT, fill: () => 1 }),
  scale: num({ min: 0.1, max: 2, step: 0.1, default: 1, unit: '×', label: 'Layer scale' }),
  colorMode: num({
    min: 0, max: 3, step: 1, default: 1, integer: true, automatable: false, label: 'Spectrum',
  }),
  sobelEnabled: bool(),
  softCropEnabled: bool(),
  colorProfileId: str({ maxLength: MAX_ID_LENGTH }),
  colorProfile: nullable(colorProfileSchema),
});

export const tracersSchema = object({
  aboveIntensity: unitInterval('Tracer above intensity', DEFAULT_TRACER_ABOVE_INTENSITY),
  belowIntensity: unitInterval('Tracer below intensity', DEFAULT_TRACER_BELOW_INTENSITY),
  aboveDuration: num({ min: 0, max: 5000, step: 100, default: 500, unit: 'ms', label: 'Tracer above duration' }),
  belowDuration: num({ min: 0, max: 10000, step: 100, default: 2000, unit: 'ms', label: 'Tracer below duration' }),
  mode: num({ min: 0, max: 1, step: 1, default: 0, integer: true, automatable: false, label: 'Tracer mode' }),
  scale: num({ min: 0.1, max: 2, step: 0.1, default: 1, unit: '×', label: 'Tracer scale' }),
  layerBlendMode: num({
    min: 0, max: BLEND_MODE_MAX, step: 1, default: 0, integer: true, automatable: false, label: 'Layer blend',
  }),
  tracerBlendMode: num({
    min: 0, max: BLEND_MODE_MAX, step: 1, default: 0, integer: true, automatable: false, label: 'Tracer blend',
  }),
  motionMode: oneOf(MOTION_MODES),
  motionGain: num({ min: 0, max: 4, step: 0.05, default: DEFAULT_MOTION_GAIN, unit: '×', label: 'Motion gain' }),
  motionDecayBias: unitInterval('Motion hold', DEFAULT_MOTION_DECAY_BIAS),
  motionThreshold: num({
    min: 0, max: 0.3, step: 0.005, default: DEFAULT_MOTION_THRESHOLD, label: 'Motion floor',
  }),
});

const tracerInspectSchema = object({
  zoom: num({ min: 1, max: 12, step: 0.1, default: 1, curve: 'log', unit: '×', label: 'Inspect zoom' }),
  // `useTracerInspectInteraction` keeps |pan| ≤ (zoom − 1) / 2·zoom, which is < ½.
  pan: struct({
    x: num({ min: -0.5, max: 0.5, default: 0, automatable: false, label: 'Inspect pan X' }),
    y: num({ min: -0.5, max: 0.5, default: 0, automatable: false, label: 'Inspect pan Y' }),
  }),
  heatmap: bool(),
  exposure: num({
    min: 0.5, max: 2, step: 0.01, default: DEFAULT_TRACER_INSPECT_EXPOSURE, unit: '×', label: 'Inspect exposure',
  }),
  tonemap: bool(),
  showLayers: bool(),
});

const outputShape = {
  mainViewMode: oneOf(MAIN_VIEW_MODE_VALUES),
  outputMode: num({
    min: 0, max: 3, step: 1, default: 0, integer: true, automatable: false, label: 'Composite stack',
  }),
  diagnosticsMode: bool(),
  diagnosticsOpacity: unitInterval('Diagnostics opacity', DEFAULT_DIAGNOSTICS_OPACITY),
  stampBoost: num({ min: 1, max: 4, step: 0.1, default: DEFAULT_STAMP_BOOST, unit: '×', label: 'Stamp boost' }),
  peakCollisionsOnly: bool(),
  webglDebugMode: num({
    min: 0, max: 3, step: 1, default: 0, integer: true, automatable: false, label: 'WebGL debug view',
  }),
  squareCanvas: bool(),
  antialiasEnabled: bool(),
  tracerInspect: tracerInspectSchema,
  performanceHudEnabled: bool(),
  performanceAutoDegrade: bool(),
};

export const outputSchema = object(outputShape);

export const engineSchema = object({
  fps: num({
    min: 1, max: 60, step: 1, default: DEFAULT_FPS, integer: true, automatable: false, unit: 'fps', label: 'Frame rate',
  }),
  paused: bool(),
  engineMode: oneOf(['ts', 'wasm']),
  avgLuminance: num({ min: 0, max: 255, step: 1, default: 128, label: 'Avg luminance' }),
});

export const uiSchema = object({
  isAutoPlayActive: bool(),
  imageChangeInterval: num({
    min: 2, max: 30, step: 1, default: 5, integer: true, automatable: false, unit: 's', label: 'Image interval',
  }),
  referenceBlendMode: oneOf(REFERENCE_BLEND_MODES),
  overlayImageSource: oneOf(OVERLAY_IMAGE_SOURCES),
  referenceOpacity: num({ min: 0.05, max: 1, step: 0.01, default: 0.22, label: 'Overlay opacity' }),
  upscaleModel: str({ maxLength: MAX_ID_LENGTH }),
});

const midiBindingSchema = struct({
  channel: num({ min: -1, max: 15, default: -1, integer: true, automatable: false, label: 'MIDI channel' }),
  controller: num({ min: 0, max: 127, default: 0, integer: true, automatable: false, label: 'MIDI controller' }),
  param: oneOf(MIDI_PARAM_IDS),
});

export const reactiveSchema = object({
  enabled: bool(),
  audioEnabled: bool(),
  midiEnabled: bool(),
  audioSensitivity: num({ min: 0.2, max: 2, step: 0.05, default: 1, unit: '×', label: 'Audio sensitivity' }),
  midiBindings: array(midiBindingSchema, { maxLength: MAX_MIDI_BINDINGS }),
});

export const viewportSchema = object({
  quarterZoom: bool(),
  halfOverlay: bool(),
  colorSpace: oneOf(DISPLAY_COLOR_SPACES),
  canvasHdr: bool(),
});

export const kioskSchema = object({
  kioskEnabled: bool(),
  kioskUiHidden: bool(),
  kioskAttractMode: bool(),
});

/** Everything a compare slot can carry: a preset minus the compare view itself. */
const slotSettingsShape = {
  layers: layersSchema,
  tracers: tracersSchema,
  output: outputSchema,
  engine: engineSchema,
  ui: uiSchema,
  reactive: reactiveSchema,
  viewport: viewportSchema,
  kiosk: kioskSchema,
};

const compareSlotSchema = object({
  id: oneOf(['a', 'b', 'c', 'd']),
  label: str({ maxLength: MAX_LABEL_LENGTH }),
  settings: object(slotSettingsShape),
  mainViewMode: oneOf(MAIN_VIEW_MODE_VALUES),
});

export const compareSchema = object({
  layout: oneOf(COMPARE_LAYOUTS),
  syncPlay: bool(),
  swipePosition: num({ min: 0, max: 1, step: 0.01, default: 0.5, label: 'Swipe position' }),
  quadLayerIndex: oneOf(QUAD_LAYER_INDICES),
  slotA: compareSlotSchema,
  slotB: compareSlotSchema,
});

/** The current (v8) settings payload. */
export const settingsSchema = object({
  ...slotSettingsShape,
  compare: compareSchema,
});

/**
 * What any supported version (v1–v8) may contain: the current payload plus the
 * keys older versions wrote and the migrations in `serializeSettings.ts` move.
 */
export const rawSettingsSchema = object({
  ...slotSettingsShape,
  output: object({
    ...outputShape,
    // v1–v3 kept these on `output`; v4 moved them to `viewport`.
    viewportQuarterZoom: bool(),
    viewportHalfOverlay: bool(),
    displayColorSpace: oneOf(DISPLAY_COLOR_SPACES),
    // Runtime toggles some early exports carried; never applied from a file.
    tracerPreviewFrozen: ignored(),
    livePreviewEnabled: ignored(),
  }),
  compare: compareSchema,
});

/** Serializable preset payload (excludes runtime GPU/media corpus state). */
export type ChromashiftSettingsInput = Infer<typeof settingsSchema>;
export type RawSettings = Infer<typeof rawSettingsSchema>;
