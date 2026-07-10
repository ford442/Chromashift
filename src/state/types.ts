import type { ImageEntry } from '../engine/TextureManager';
import type { RendererBackend } from '../engine/RendererTypes';
import type { CollisionStats } from '../engine/types/RendererState';
import type { MainViewMode } from '../engine/viewModes';
import type { EngineKind } from '../engine/WasmEngine';
import type { GpuRuntimeError } from '../engine/gpuBootstrap';
import type { ExportPassMode } from '../engine/types/RendererContracts';
import type { ReferenceBlendMode } from '../components/overlay/types';

export type LayerTriple<T> = [T, T, T];

export interface TracerInspectState {
  zoom: number;
  pan: { x: number; y: number };
  heatmap: boolean;
  exposure: number;
  tonemap: boolean;
  showLayers: boolean;
}

export interface MediaSlice {
  imageList: ImageEntry[];
  currentIndex: number;
  reference: ImageEntry | null;
  previous: ImageEntry | null;
  aspect: number;
  specificError: string | null;
}

export interface LayersSlice {
  angles: LayerTriple<number>;
  extensions: LayerTriple<number>;
  opacity: number;
  opacities: LayerTriple<number>;
  scale: number;
  colorMode: number;
  sobelEnabled: boolean;
  softCropEnabled: boolean;
}

export interface TracersSlice {
  aboveIntensity: number;
  belowIntensity: number;
  aboveDuration: number;
  belowDuration: number;
  mode: number;
  scale: number;
  layerBlendMode: number;
  tracerBlendMode: number;
}

export interface OutputSlice {
  mainViewMode: MainViewMode;
  outputMode: number;
  diagnosticsMode: boolean;
  diagnosticsOpacity: number;
  stampBoost: number;
  peakCollisionsOnly: boolean;
  webglDebugMode: number;
  viewportQuarterZoom: boolean;
  viewportHalfOverlay: boolean;
  squareCanvas: boolean;
  antialiasEnabled: boolean;
  tracerInspect: TracerInspectState;
  tracerPreviewFrozen: boolean;
  livePreviewEnabled: boolean;
}

export interface EngineSlice {
  backend: RendererBackend;
  fallbackReason: string | null;
  engineMode: EngineKind;
  wasmAvailable: boolean;
  fps: number;
  paused: boolean;
  gpuReady: boolean;
  gpuError: GpuRuntimeError | null;
  avgLuminance: number;
}

export interface VideoExportSettings {
  durationSec: number;
  fps: number;
  resolutionScale: number;
  includeTracers: boolean;
  passMode: ExportPassMode;
  filename: string;
  usePresetAngles: boolean;
}

export interface UiSlice {
  isAutoPlayActive: boolean;
  imageChangeInterval: number;
  isImageStripOpen: boolean;
  referenceBlendMode: ReferenceBlendMode;
  referenceOpacity: number;
  exportingTracer: boolean;
  exportingVideo: boolean;
  videoExportProgress: number;
  videoExportSettings: VideoExportSettings;
  upscaleModel: string;
  upscaleBusy: boolean;
  upscaleProgress: number;
  upscaleInfo: string;
  renderCpuTiming: { last: number; avg: number };
  collisionStats: CollisionStats;
}

export interface ChromashiftState {
  media: MediaSlice;
  layers: LayersSlice;
  tracers: TracersSlice;
  output: OutputSlice;
  engine: EngineSlice;
  ui: UiSlice;
}
