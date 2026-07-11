import type { GpuRenderTiming } from '../engine/types/RendererContracts';
import type { ImageEntry } from '../engine/TextureManager';
import type { RendererBackend } from '../engine/RendererTypes';
import type { CollisionStats } from '../engine/types/RendererState';
import type { MainViewMode } from '../engine/viewModes';
import type { EngineKind } from '../engine/WasmEngine';
import type { GpuRuntimeError } from '../engine/gpuBootstrap';
import type { ExportPassMode } from '../engine/types/RendererContracts';
import type { OverlayImageSource, ReferenceBlendMode } from '../components/overlay/types';
export type { ReactiveSlice } from '../engine/reactive/types';

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
  /** Show per-pass GPU timing HUD in the Diagnostics panel (WebGPU only). */
  performanceHudEnabled: boolean;
  /** Automatically reduce MSAA / tracer scale / live readback when over frame budget. */
  performanceAutoDegrade: boolean;
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
  overlayImageSource: OverlayImageSource;
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
  renderGpuTiming: GpuRenderTiming;
  /** Sparkline samples (total ms = max(cpu last, gpu total) per frame). */
  frameTimeHistory: number[];
  performanceBudgetExceeded: boolean;
  collisionStats: CollisionStats;
  /** Friendly message when a ?preset= URL parameter could not be applied. */
  presetLoadError: string | null;
  /** Set from `?kiosk=1` — gallery / installation mode. */
  kioskEnabled: boolean;
  /** When true, NUNIF and peripheral chrome are hidden for a clean canvas. */
  kioskUiHidden: boolean;
  /** Slow parameter drift for unattended attract loops. */
  kioskAttractMode: boolean;
  shortcutsOverlayVisible: boolean;
}

export interface ChromashiftState {
  media: MediaSlice;
  layers: LayersSlice;
  tracers: TracersSlice;
  output: OutputSlice;
  engine: EngineSlice;
  ui: UiSlice;
  reactive: import('../engine/reactive/types').ReactiveSlice;
}
