import { MAIN_VIEW_MODES } from '../engine/viewModes';
import { getRendererPreference } from '../engine/rendererMode';
import type { ExportPassMode } from '../engine/types/RendererContracts';
import type { ChromashiftState, LayerTriple } from './types';

export const DEFAULT_ANGLES: LayerTriple<number> = [0, 0, 0];
export const DEFAULT_EXTENSIONS: LayerTriple<number> = [130, 230, 330];
export const DEFAULT_FPS = 30;

export const DEFAULT_COLLISION_STATS = {
  sampledPixels: 0,
  twoOverlapPixels: 0,
  threeOverlapPixels: 0,
  dominantLayerWins: [0, 0, 0] as LayerTriple<number>,
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
};

export function createInitialState(): ChromashiftState {
  return {
    media: {
      imageList: [],
      currentIndex: 0,
      reference: null,
      previous: null,
      aspect: 1,
      specificError: null,
    },
    layers: {
      angles: [...DEFAULT_ANGLES],
      extensions: [...DEFAULT_EXTENSIONS],
      opacity: 1,
      opacities: [1, 1, 1],
      scale: 1,
      colorMode: 1,
      sobelEnabled: false,
      softCropEnabled: false,
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
      referenceOpacity: 0.22,
      exportingTracer: false,
      exportingVideo: false,
      videoExportProgress: 0,
      videoExportSettings: { ...DEFAULT_VIDEO_EXPORT_SETTINGS },
      upscaleModel: 'realesrgan:general_plus',
      upscaleBusy: false,
      upscaleProgress: 0,
      upscaleInfo: '',
      renderCpuTiming: { last: 0, avg: 0 },
      collisionStats: { ...DEFAULT_COLLISION_STATS },
    },
  };
}
