import { MAIN_VIEW_MODES } from '../engine/viewModes';
import { defaultCompareSlot } from '../engine/compareViews';
import { getRendererPreference } from '../engine/rendererMode';
import { CLASSIC_PROFILE_ID } from '../engine/color/colorProfile';
import {
  DEFAULT_MOTION_DECAY_BIAS,
  DEFAULT_MOTION_GAIN,
  DEFAULT_MOTION_MODE,
  DEFAULT_MOTION_THRESHOLD,
} from '../engine/motionModes';
import { CANONICAL_LAYER_COUNT } from '../engine/graph/layerSpecs';
import type { ExportPassMode } from '../engine/types/RendererContracts';
import type { RendererState } from '../engine/types/RendererState';
import type { ChromashiftState, PerLayer } from './types';
import type { CompareViewState } from '../engine/compareViews';

/** Session defaults that are also what a renderer assumes when the field is absent. */
export const DEFAULT_TRACER_ABOVE_INTENSITY = 0.85;
export const DEFAULT_TRACER_BELOW_INTENSITY = 0.30;
export const DEFAULT_STAMP_BOOST = 1.8;
export const DEFAULT_DIAGNOSTICS_OPACITY = 0.55;
export const DEFAULT_TRACER_INSPECT_EXPOSURE = 1.04;

/**
 * What an absent optional {@link RendererState} field means — to every
 * renderer, every encode path, and both backends.
 *
 * These used to be spelled at each read (`state.stampBoost ?? 1.8`) in the
 * hand encoder, the graph executor, the stationary previews and the WebGL
 * passes, and they had already drifted: WebGL read an absent tracer duration
 * as 500 / 2000 ms where WebGPU read 1000 / 0. Nothing reads one of these
 * fields with its own fallback any more; `rendererStateValue()` in
 * `engine/graph/exec/uniforms.ts` is the one reader.
 *
 * App frames never hit most of them — `buildRendererState` sets every field —
 * but tests, offline export and the one-off states a renderer builds for
 * itself do. Where a session default exists the value is that default; the
 * tracer durations are the WebGPU renderer's historical fallbacks, kept so no
 * existing frame changes.
 */
export const RENDERER_STATE_DEFAULTS = {
  layerOpacity: 1,
  layerScale: 1,
  tracerScale: 1,
  tracerAboveIntensity: DEFAULT_TRACER_ABOVE_INTENSITY,
  tracerBelowIntensity: DEFAULT_TRACER_BELOW_INTENSITY,
  tracerAboveDuration: 1000,
  tracerBelowDuration: 0,
  tracerThreshold: 0.05,
  tracerMode: 0,
  motionMode: 0,
  motionGain: DEFAULT_MOTION_GAIN,
  motionDecayBias: DEFAULT_MOTION_DECAY_BIAS,
  motionThreshold: DEFAULT_MOTION_THRESHOLD,
  colorMode: 1,
  colorProfileMode: 0,
  colorProfileLightDark: 1,
  sobelEnabled: false,
  softCropEnabled: false,
  layerBlendMode: 0,
  tracerBlendMode: 0,
  outputMode: 0,
  paused: false,
  mainViewMode: MAIN_VIEW_MODES.PROCESSED_COMPOSITE,
  tracerInspectZoom: 1,
  tracerInspectPanX: 0,
  tracerInspectPanY: 0,
  tracerInspectHeatmap: false,
  tracerInspectExposure: DEFAULT_TRACER_INSPECT_EXPOSURE,
  tracerInspectTonemap: true,
  tracerInspectShowLayers: false,
  diagnosticsMode: false,
  diagnosticsOpacity: DEFAULT_DIAGNOSTICS_OPACITY,
  stampBoost: DEFAULT_STAMP_BOOST,
  peakCollisionsOnly: false,
  viewportQuarterZoom: false,
  viewportHalfOverlay: false,
  halfOverlayAlpha: 0.5,
} as const satisfies { [K in keyof RendererState]?: NonNullable<RendererState[K]> };

/** Fallback for one entry of `RendererState.layerOpacities`. */
export const DEFAULT_PER_LAYER_OPACITY = 1;

const DEFAULT_AUDIO_LEVELS = {
  bass: 0,
  mid: 0,
  high: 0,
  energy: 0,
} as const;

/** How many band layers a fresh session renders. */
export const DEFAULT_LAYER_COUNT = CANONICAL_LAYER_COUNT;

/**
 * First spin rate and the step between consecutive layers, in degrees.
 *
 * The shipped three-layer session uses 130 / 230 / 330, so a fourth layer
 * continues the same ladder wrapped back into `[0, 360)` rather than inventing
 * a new spacing. gcd(100, 360) = 20 gives a period of 18, so all ten possible
 * layers get distinct rates.
 */
const EXTENSION_BASE = 130;
const EXTENSION_STEP = 100;

/** Spin rate (°) for layer `index`, normalized to 30 FPS — wall-clock °/s = value × 30. */
export function defaultExtensionForLayer(index: number): number {
  return (EXTENSION_BASE + EXTENSION_STEP * index) % 360;
}

/** Starting angles (all zero) for a `count`-layer session. */
export function defaultAngles(count: number = DEFAULT_LAYER_COUNT): PerLayer<number> {
  return Array.from({ length: count }, () => 0);
}

/** Spin rates for a `count`-layer session; `count === 3` is exactly [130, 230, 330]. */
export function defaultExtensions(count: number = DEFAULT_LAYER_COUNT): PerLayer<number> {
  return Array.from({ length: count }, (_, i) => defaultExtensionForLayer(i));
}

/** Per-layer opacity multipliers (all opaque) for a `count`-layer session. */
function defaultOpacities(count: number = DEFAULT_LAYER_COUNT): PerLayer<number> {
  return Array.from({ length: count }, () => 1);
}

export const DEFAULT_ANGLES: PerLayer<number> = defaultAngles();
export const DEFAULT_FPS = 30;

export const DEFAULT_COLLISION_STATS = {
  sampledPixels: 0,
  twoOverlapPixels: 0,
  threeOverlapPixels: 0,
  dominantLayerWins: defaultAngles(),
  averageCollision: 0,
};

const DEFAULT_VIDEO_EXPORT_SETTINGS = {
  durationSec: 5,
  fps: DEFAULT_FPS,
  resolutionScale: 1,
  includeTracers: true,
  passMode: 'composite' as ExportPassMode,
  filename: 'chromashift-export',
  usePresetAngles: true,
  container: 'auto' as const,
  quality: 'high' as const,
};

const DEFAULT_LIVE_SOURCE: import('./types').LiveSourceState = {
  active: false,
  kind: null,
  label: null,
  width: 0,
  height: 0,
  error: null,
};

/** The single-view layout a fresh session (and a preset without one) starts in. */
export function createDefaultCompareView(): CompareViewState {
  return {
    layout: 'single',
    syncPlay: true,
    swipePosition: 0.5,
    quadLayerIndex: 0,
    slotA: defaultCompareSlot('a', 'Live'),
    slotB: defaultCompareSlot('b', 'Preset B'),
  };
}

export function createInitialState(): ChromashiftState {
  return {
    media: {
      imageList: [],
      localCount: 0,
      currentIndex: 0,
      reference: null,
      previous: null,
      aspect: 1,
      specificError: null,
      liveSource: { ...DEFAULT_LIVE_SOURCE },
    },
    layers: {
      count: DEFAULT_LAYER_COUNT,
      angles: defaultAngles(),
      extensions: defaultExtensions(),
      opacity: 1,
      opacities: defaultOpacities(),
      scale: 1,
      colorMode: 1,
      sobelEnabled: false,
      softCropEnabled: false,
      colorProfileId: CLASSIC_PROFILE_ID,
      colorProfile: null,
    },
    tracers: {
      aboveIntensity: DEFAULT_TRACER_ABOVE_INTENSITY,
      belowIntensity: DEFAULT_TRACER_BELOW_INTENSITY,
      aboveDuration: 500,
      belowDuration: 2000,
      mode: 0,
      scale: 1,
      layerBlendMode: 0,
      tracerBlendMode: 0,
      motionMode: DEFAULT_MOTION_MODE,
      motionGain: DEFAULT_MOTION_GAIN,
      motionDecayBias: DEFAULT_MOTION_DECAY_BIAS,
      motionThreshold: DEFAULT_MOTION_THRESHOLD,
    },
    output: {
      mainViewMode: MAIN_VIEW_MODES.PROCESSED_COMPOSITE,
      outputMode: 0,
      diagnosticsMode: false,
      diagnosticsOpacity: DEFAULT_DIAGNOSTICS_OPACITY,
      stampBoost: DEFAULT_STAMP_BOOST,
      peakCollisionsOnly: false,
      webglDebugMode: 0,
      viewportQuarterZoom: false,
      viewportHalfOverlay: false,
      squareCanvas: true,
      antialiasEnabled: false,
      displayColorSpace: 'srgb',
      canvasHdr: false,
      tracerInspect: {
        zoom: 1,
        pan: { x: 0, y: 0 },
        heatmap: false,
        exposure: DEFAULT_TRACER_INSPECT_EXPOSURE,
        tonemap: true,
        showLayers: false,
      },
      tracerPreviewFrozen: false,
      livePreviewEnabled: true,
      performanceHudEnabled: false,
      performanceAutoDegrade: false,
    },
    engine: {
      backend: typeof window !== 'undefined' ? getRendererPreference() : 'webgpu',
      fallbackReason: null,
      engineMode: 'ts',
      wasmAvailable: false,
      fps: DEFAULT_FPS,
      paused: false,
      gpuReady: false,
      gpuError: null,
      avgLuminance: 128,
    },
    ui: {
      isAutoPlayActive: true,
      imageChangeInterval: 5,
      isImageStripOpen: false,
      referenceBlendMode: 'hidden',
      overlayImageSource: 'reference',
      referenceOpacity: 0.22,
      exportingTracer: false,
      exportingVideo: false,
      videoExportProgress: 0,
      videoExportSettings: { ...DEFAULT_VIDEO_EXPORT_SETTINGS },
      upscaleModel: 'realesrgan:general_plus',
      upscaleBusy: false,
      upscaleProgress: 0,
      upscaleInfo: '',
      presetLoadError: null,
      activePresetId: null,
      kioskEnabled: false,
      kioskUiHidden: false,
      kioskAttractMode: false,
      shortcutsOverlayVisible: false,
      compareView: createDefaultCompareView(),
    },
    reactive: {
      enabled: false,
      audioEnabled: false,
      midiEnabled: false,
      micActive: false,
      micError: null,
      midiAvailable: typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator,
      midiError: null,
      midiLearnTarget: null,
      midiBindings: [],
      audioSensitivity: 1,
      audioLevels: { ...DEFAULT_AUDIO_LEVELS },
    },
  };
}
