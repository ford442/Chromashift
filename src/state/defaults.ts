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
import type { ChromashiftState, PerLayer } from './types';

export const DEFAULT_AUDIO_LEVELS = {
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
export function defaultOpacities(count: number = DEFAULT_LAYER_COUNT): PerLayer<number> {
  return Array.from({ length: count }, () => 1);
}

export const DEFAULT_ANGLES: PerLayer<number> = defaultAngles();
/** Spin rates (°), normalized to 30 FPS — wall-clock °/s = value × 30. */
export const DEFAULT_EXTENSIONS: PerLayer<number> = defaultExtensions();
export const DEFAULT_FPS = 30;

export const DEFAULT_COLLISION_STATS = {
  sampledPixels: 0,
  twoOverlapPixels: 0,
  threeOverlapPixels: 0,
  dominantLayerWins: defaultAngles(),
  averageCollision: 0,
};

export const DEFAULT_VIDEO_EXPORT_SETTINGS = {
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

export const DEFAULT_LIVE_SOURCE: import('./types').LiveSourceState = {
  active: false,
  kind: null,
  label: null,
  width: 0,
  height: 0,
  error: null,
};

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
      aboveIntensity: 0.85,
      belowIntensity: 0.30,
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
      diagnosticsOpacity: 0.55,
      stampBoost: 1.8,
      peakCollisionsOnly: false,
      webglDebugMode: 0,
      viewportQuarterZoom: false,
      viewportHalfOverlay: false,
      squareCanvas: true,
      antialiasEnabled: false,
      displayColorSpace: 'srgb',
      tracerInspect: {
        zoom: 1,
        pan: { x: 0, y: 0 },
        heatmap: false,
        exposure: 1.04,
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
      kioskEnabled: false,
      kioskUiHidden: false,
      kioskAttractMode: false,
      shortcutsOverlayVisible: false,
      compareView: {
        layout: 'single',
        syncPlay: true,
        swipePosition: 0.5,
        quadLayerIndex: 0,
        slotA: defaultCompareSlot('a', 'Live'),
        slotB: defaultCompareSlot('b', 'Preset B'),
      },
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
