import type { ImageEntry } from '../engine/TextureManager';
import type { RendererBackend } from '../engine/RendererTypes';
import type { MainViewMode } from '../engine/viewModes';
import type { EngineKind } from '../engine/WasmEngine';
import type { GpuRuntimeError } from '../engine/gpuBootstrap';
import type { ExportPassMode } from '../engine/types/RendererContracts';
import type { VideoExportContainer, VideoExportQuality } from '../engine/videoExport/videoCodecs';
import type { OverlayImageSource, ReferenceBlendMode } from '../components/overlay/types';
import type { CompareViewState } from '../engine/compareViews';
import type { ColorProfile } from '../engine/color/colorProfile';
import type { MotionMode } from '../engine/motionModes';
export type { ReactiveSlice } from '../engine/reactive/types';
export type { MotionMode } from '../engine/motionModes';

export type DisplayColorSpace = import('../engine/gpuOptions').DisplayColorSpace;

/**
 * A value carried once per band layer.
 *
 * Deliberately a plain array and not a 3-tuple: a session's layer count is
 * {@link LayersSlice.count} (1–`MAX_LAYER_COUNT`), and every consumer sizes
 * itself from `.length` rather than from a type-level width. `layerArrays.test.ts`
 * fails if a fixed-width tuple is reintroduced anywhere on this contract.
 */
export type PerLayer<T> = T[];

export interface TracerInspectState {
  zoom: number;
  pan: { x: number; y: number };
  heatmap: boolean;
  exposure: number;
  tonemap: boolean;
  showLayers: boolean;
}

export type LiveSourceKind = 'camera' | 'screen' | 'video-file';

/**
 * Runtime-only state for a webcam / screen-share / looping video-file source
 * driving the main composite in place of a still image. Never serialized into
 * presets (see `ChromashiftSettingsInput` in `chromashiftReducer.ts`) — the
 * underlying `MediaStream`/`HTMLVideoElement` can't round-trip through JSON,
 * so a shared preset URL never auto-requests camera/screen access.
 */
export interface LiveSourceState {
  active: boolean;
  kind: LiveSourceKind | null;
  label: string | null;
  width: number;
  height: number;
  error: string | null;
}

export interface MediaSlice {
  imageList: ImageEntry[];
  /**
   * Number of `imageList` entries backed by the local IndexedDB library.
   * Derived by the reducer whenever `imageList` is replaced, so the image strip
   * can read it in O(1) instead of scanning thousands of entries per render.
   */
  localCount: number;
  currentIndex: number;
  reference: ImageEntry | null;
  previous: ImageEntry | null;
  aspect: number;
  specificError: string | null;
  liveSource: LiveSourceState;
}

export interface LayersSlice {
  /**
   * How many band layers this session renders, 1–`MAX_LAYER_COUNT` (10 — one
   * per canonical threshold in shared/band.json). Every `PerLayer` array in
   * this slice is exactly this long; the reducer resizes them together so the
   * invariant can never be broken by a partial patch.
   */
  count: number;
  angles: PerLayer<number>;
  /**
   * Per-layer spin rate in degrees, normalized so wall-clock °/s = value × 30.
   * Changing FPS only changes sampling density, not angular speed.
   */
  extensions: PerLayer<number>;
  opacity: number;
  opacities: PerLayer<number>;
  scale: number;
  colorMode: number;
  sobelEnabled: boolean;
  softCropEnabled: boolean;
  /**
   * Active named colour profile (see docs/COLOR_PROFILES.md). `cr0p-classic`
   * keeps the branchy shader path; any other id renders through the LUT path.
   */
  colorProfileId: string;
  /**
   * Full profile document for non-built-in profiles, embedded so a preset file
   * carries the table with it. `null` for built-ins and for ids resolved from
   * the local profile library.
   */
  colorProfile: ColorProfile | null;
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
  /**
   * Temporal term applied on top of the purely spatial coincidence test —
   * `off` (the default) is behaviourally identical to the pre-motion pipeline.
   * See `engine/motionModes.ts` and `docs/LIVE_SOURCE.md`.
   */
  motionMode: MotionMode;
  /** How strongly motion boosts a fresh stamp. */
  motionGain: number;
  /** How much motion slows local decay (0 = none, 1 = trail fully held). */
  motionDecayBias: number;
  /** Noise floor on the frame difference, so sensor grain does not light up. */
  motionThreshold: number;
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
  /** Canvas presentation colour space (WebGPU `GPUCanvasConfiguration.colorSpace`). LUTs stay sRGB. */
  displayColorSpace: DisplayColorSpace;
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

export type { VideoExportContainer, VideoExportQuality } from '../engine/videoExport/videoCodecs';

export interface VideoExportSettings {
  durationSec: number;
  fps: number;
  resolutionScale: number;
  includeTracers: boolean;
  passMode: ExportPassMode;
  filename: string;
  usePresetAngles: boolean;
  container: VideoExportContainer;
  quality: VideoExportQuality;
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
  /** Friendly message when a ?preset= URL parameter could not be applied. */
  presetLoadError: string | null;
  /** Set from `?kiosk=1` — gallery / installation mode. */
  kioskEnabled: boolean;
  /** When true, NUNIF and peripheral chrome are hidden for a clean canvas. */
  kioskUiHidden: boolean;
  /** Slow parameter drift for unattended attract loops. */
  kioskAttractMode: boolean;
  shortcutsOverlayVisible: boolean;
  /** Multi-view comparison layout (dual A/B, etc.) — see docs/COMPARE_VIEWS.md. */
  compareView: CompareViewState;
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
