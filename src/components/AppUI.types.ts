import type { RefObject } from 'react';
import type { ChromashiftRefs } from '../hooks/useChromashiftStore';
import type { ImageEntry } from '../engine/TextureManager';
import type { GpuRuntimeError } from '../engine/gpuBootstrap';
import type { CollisionStats } from '../engine/types/RendererState';
import type { RendererBackend } from '../engine/RendererTypes';
import type { CompareLayoutMode } from '../engine/compareViews';
import type { MainViewMode } from '../engine/viewModes';
import type { ExportPassMode, GpuRenderTiming } from '../engine/types/RendererContracts';
import type { VideoCodecSupport } from '../engine/videoExport/videoCodecs';
import type { BuiltinPreset } from '../state/presetGallery';
import type { StoredPreset } from '../state/presetLibrary';
import type { LayerTriple, VideoExportSettings } from '../state/types';
import type { AudioLevelSnapshot, MidiBinding, MidiParamId } from '../engine/reactive/types';
import type {
  EngineMode,
  LayerIndex,
  OverlayImageSource,
  ReferenceBlendMode,
} from './overlay/types';

export interface AppUiHandlerBundle {
  selectSourceIndex: (index: number) => void;
  handleAngleChange: (layer: LayerIndex, angle: number) => void;
  handleExtensionChange: (layer: LayerIndex, extension: number) => void;
  handleReset: () => void;
  handleLoadSpecificImage: (url: string, label?: string) => Promise<void>;
  handleLoadFile: (file: File) => void;
  handleLoadReferenceImage: (url: string, label?: string) => void;
  handleLoadReferenceFile: (file: File) => void;
  handleDropFiles: (files: File[]) => Promise<void>;
  handleClearLocalLibrary: () => Promise<void>;
  swapSourceAndReference: () => void;
  handleFreezeInspect: () => void;
  handleUpscaleSource: () => Promise<void>;
  handleUpscaleOutput: () => Promise<void>;
  handleExportTracer: () => Promise<void>;
  exportingVideo: boolean;
  videoExportProgress: number;
  videoExportSettings: VideoExportSettings;
  codecSupport: VideoCodecSupport;
  handleExportVideo: () => Promise<void>;
  handleCancelVideoExport: () => void;
  onVideoExportDurationChange: (seconds: number) => void;
  onVideoExportFpsChange: (fps: number) => void;
  onVideoExportScaleChange: (scale: number) => void;
  onVideoExportIncludeTracersChange: (include: boolean) => void;
  onVideoExportPassModeChange: (mode: ExportPassMode) => void;
  onVideoExportFilenameChange: (filename: string) => void;
  onVideoExportUsePresetAnglesChange: (usePreset: boolean) => void;
  builtinPresets: readonly BuiltinPreset[];
  savedPresets: StoredPreset[];
  presetStatus: string | null;
  presetError: string | null;
  handleSavePreset: (name: string) => void;
  handleLoadPreset: (name: string) => void;
  handleDeletePreset: (name: string) => void;
  handleApplyBuiltinPreset: (id: string) => void;
  handleCompareWithBuiltin: (id: string) => void;
  handleCompareWithSaved: (name: string) => void;
  handleCopyPresetUrl: () => void;
  handleExportPresetFile: () => void;
  handleImportPresetFile: (file: File) => void;
}

export interface KioskControls {
  isFullscreen: boolean;
  toggleFullscreen: () => Promise<void>;
}

export interface AppUIRefsProps {
  containerRef: RefObject<HTMLDivElement | null>;
  mainViewportRef: RefObject<HTMLDivElement | null>;
  mainCanvasRef: RefObject<HTMLCanvasElement | null>;
  canvasBRef: RefObject<HTMLCanvasElement | null>;
  previewOriginalRef: RefObject<HTMLCanvasElement | null>;
  previewSeparatedRef: RefObject<HTMLCanvasElement | null>;
  overlaySeparatedRef: RefObject<HTMLCanvasElement | null>;
  previewTracerRef: RefObject<HTMLCanvasElement | null>;
  rendererRef: ChromashiftRefs['rendererRef'];
}

export interface AppUIMainViewportProps {
  photoModeImage: ImageEntry | null;
  isReferenceCompareMode: boolean;
  referenceImage: ImageEntry | null;
  showCanvasMainView: boolean;
  isPaused: boolean;
  mainViewMode: MainViewMode;
  showImageOverlay: boolean;
  overlayImageSource: OverlayImageSource;
  overlayPhotoImage: ImageEntry | null;
  overlayUsesSeparatedCanvas: boolean;
  referenceBlendMode: ReferenceBlendMode;
  referenceOpacity: number;
  compareDualActive: boolean;
  compareSlotBLabel: string;
}

export interface AppUIPreviewStripProps {
  tracerPreviewFrozen: boolean;
  setTracerPreviewFrozen: (frozen: boolean) => void;
  livePreviewEnabled: boolean;
  setLivePreviewEnabled: (enabled: boolean) => void;
}

export interface AppUIChromeProps {
  gpuError: GpuRuntimeError | null;
  collisionStats: CollisionStats;
  avgLuminance: number;
  engineMode: EngineMode;
  wasmAvailable: boolean;
  renderCpuTiming: { last: number; avg: number };
  performanceHudEnabled: boolean;
  imageList: ImageEntry[];
  currentImageIndex: number;
  referenceImage: ImageEntry | null;
  isImageStripOpen: boolean;
  isPaused: boolean;
  specificImageError: string | null;
  kioskEnabled: boolean;
  kioskUiHidden: boolean;
  shortcutsOverlayVisible: boolean;
  kioskFullscreen: boolean;
  selectSourceIndex: (index: number) => void;
  setIsPaused: (paused: boolean) => void;
  toggleImageStrip: () => void;
  setMainViewMode: (mode: MainViewMode) => void;
  setReferenceImage: (img: ImageEntry | null) => void;
  handleClearLocalLibrary: () => Promise<void>;
  setAvgLuminance: (value: number) => void;
  setShortcutsOverlayVisible: (visible: boolean) => void;
  toggleKioskFullscreen: () => Promise<void>;
  setSpecificImageError: (error: string | null) => void;
}

export interface AppUIControlProps {
  rendererBackend: RendererBackend;
  rendererFallbackReason: string | null;
  webglDebugMode: number;
  setWebglDebugMode: (mode: number) => void;
  isAutoPlayActive: boolean;
  setIsAutoPlayActive: (active: boolean) => void;
  handleLoadFile: (file: File) => void;
  handleLoadSpecificImage: (url: string, label?: string) => Promise<void>;
  handleLoadReferenceFile: (file: File) => void;
  handleLoadReferenceImage: (url: string, label?: string) => void;
  handleDropFiles: (files: File[]) => Promise<void>;
  swapSourceAndReference: () => void;
  setReferenceBlendMode: (mode: ReferenceBlendMode) => void;
  setOverlayImageSource: (source: OverlayImageSource) => void;
  setReferenceOpacity: (opacity: number) => void;
  handleFreezeInspect: () => void;
  tracerInspectZoom: number;
  setTracerInspectZoom: (zoom: number) => void;
  tracerInspectHeatmap: boolean;
  setTracerInspectHeatmap: (enabled: boolean) => void;
  tracerInspectExposure: number;
  setTracerInspectExposure: (exposure: number) => void;
  tracerInspectTonemap: boolean;
  setTracerInspectTonemap: (enabled: boolean) => void;
  tracerInspectShowLayers: boolean;
  setTracerInspectShowLayers: (enabled: boolean) => void;
  handleResetInspectView: () => void;
  exportingTracer: boolean;
  handleExportTracer: () => Promise<void>;
  exportingVideo: boolean;
  videoExportProgress: number;
  videoExportSettings: VideoExportSettings;
  codecSupport: VideoCodecSupport;
  handleExportVideo: () => Promise<void>;
  handleCancelVideoExport: () => void;
  onVideoExportDurationChange: (seconds: number) => void;
  onVideoExportFpsChange: (fps: number) => void;
  onVideoExportScaleChange: (scale: number) => void;
  onVideoExportIncludeTracersChange: (include: boolean) => void;
  onVideoExportPassModeChange: (mode: ExportPassMode) => void;
  onVideoExportFilenameChange: (filename: string) => void;
  onVideoExportUsePresetAnglesChange: (usePreset: boolean) => void;
  builtinPresets: readonly BuiltinPreset[];
  savedPresets: StoredPreset[];
  presetStatus: string | null;
  presetError: string | null;
  handleSavePreset: (name: string) => void;
  handleLoadPreset: (name: string) => void;
  handleDeletePreset: (name: string) => void;
  handleApplyBuiltinPreset: (id: string) => void;
  handleCopyPresetUrl: () => void;
  handleExportPresetFile: () => void;
  handleImportPresetFile: (file: File) => void;
  compareLayout: CompareLayoutMode;
  compareSyncPlay: boolean;
  compareDualAvailable: boolean;
  comparePerformanceNote: string | null;
  onCompareLayoutChange: (layout: CompareLayoutMode) => void;
  onCompareSyncPlayToggle: (sync: boolean) => void;
  onCompareWithBuiltin: (id: string) => void;
  onCompareWithSaved: (name: string) => void;
  layerAngles: LayerTriple<number>;
  handleAngleChange: (layer: LayerIndex, angle: number) => void;
  layerExtensions: LayerTriple<number>;
  handleExtensionChange: (layer: LayerIndex, extension: number) => void;
  frameRate: number;
  setFrameRate: (fps: number) => void;
  layerOpacity: number;
  setLayerOpacity: (opacity: number) => void;
  layerOpacities: LayerTriple<number>;
  setLayerOpacities: (opacities: LayerTriple<number>) => void;
  layerScale: number;
  setLayerScale: (scale: number) => void;
  tracerScale: number;
  setTracerScale: (scale: number) => void;
  tracerAboveIntensity: number;
  setTracerAboveIntensity: (value: number) => void;
  tracerBelowIntensity: number;
  setTracerBelowIntensity: (value: number) => void;
  tracerAboveDuration: number;
  setTracerAboveDuration: (value: number) => void;
  tracerBelowDuration: number;
  setTracerBelowDuration: (value: number) => void;
  tracerMode: number;
  setTracerMode: (mode: number) => void;
  layerBlendMode: number;
  setLayerBlendMode: (mode: number) => void;
  tracerBlendMode: number;
  setTracerBlendMode: (mode: number) => void;
  outputMode: number;
  setOutputMode: (mode: number) => void;
  diagnosticsMode: boolean;
  setDiagnosticsMode: (enabled: boolean) => void;
  diagnosticsOpacity: number;
  setDiagnosticsOpacity: (opacity: number) => void;
  stampBoost: number;
  setStampBoost: (value: number) => void;
  peakCollisionsOnly: boolean;
  setPeakCollisionsOnly: (enabled: boolean) => void;
  performanceAutoDegrade: boolean;
  setPerformanceHudEnabled: (enabled: boolean) => void;
  setPerformanceAutoDegrade: (enabled: boolean) => void;
  performanceBudgetExceeded: boolean;
  renderGpuTiming: GpuRenderTiming;
  frameTimeHistory: readonly number[];
  applyPerformanceDegrade: () => void;
  colorMode: number;
  setColorMode: (mode: number) => void;
  sobelEnabled: boolean;
  setSobelEnabled: (enabled: boolean) => void;
  softCropEnabled: boolean;
  setSoftCropEnabled: (enabled: boolean) => void;
  viewportQuarterZoom: boolean;
  setViewportQuarterZoom: (enabled: boolean) => void;
  viewportHalfOverlay: boolean;
  setViewportHalfOverlay: (enabled: boolean) => void;
  squareCanvas: boolean;
  setSquareCanvas: (enabled: boolean) => void;
  antialiasEnabled: boolean;
  setAntialiasEnabled: (enabled: boolean) => void;
  handleReset: () => void;
  imageChangeInterval: number;
  setImageChangeInterval: (seconds: number) => void;
  upscaleModel: string;
  setUpscaleModel: (model: string) => void;
  handleUpscaleSource: () => Promise<void>;
  handleUpscaleOutput: () => Promise<void>;
  upscaleBusy: boolean;
  upscaleProgress: number;
  upscaleInfo: string;
  engineMode: EngineMode;
  setEngineMode: (mode: EngineMode) => void;
  wasmAvailable: boolean;
  xrAvailable: boolean;
  xrReason: string | null;
  xrImmersive: boolean;
  xrBusy: boolean;
  xrError: string | null;
  xrEnterAllowed: boolean;
  onEnterXr: () => void;
  onExitXr: () => void;
  isViewingTracer: boolean;
  currentImage: ImageEntry | null;
  isWasmReady: () => boolean;
  kioskEnabled: boolean;
  reactiveEnabled: boolean;
  audioEnabled: boolean;
  midiEnabled: boolean;
  micActive: boolean;
  micError: string | null;
  midiAvailable: boolean;
  midiError: string | null;
  midiLearnTarget: MidiParamId | null;
  midiBindings: MidiBinding[];
  audioLevels: AudioLevelSnapshot;
  audioSensitivity: number;
  layerExtension0: number;
  onReactiveEnabledChange: (enabled: boolean) => void;
  onAudioEnabledChange: (enabled: boolean) => void;
  onMidiEnabledChange: (enabled: boolean) => void;
  onAudioSensitivityChange: (value: number) => void;
  onStartMicDemo: () => void;
  onMidiLearnTargetChange: (target: MidiParamId | null) => void;
  onRemoveMidiBinding: (param: MidiParamId) => void;
}

export type AppUIProps =
  AppUIRefsProps &
  AppUIMainViewportProps &
  AppUIPreviewStripProps &
  AppUIChromeProps &
  AppUIControlProps;

export type MainViewportProps = Pick<
  AppUIRefsProps,
  'mainViewportRef' | 'mainCanvasRef' | 'canvasBRef' | 'overlaySeparatedRef'
> &
  Pick<
    AppUIMainViewportProps,
    | 'photoModeImage'
    | 'isReferenceCompareMode'
    | 'referenceImage'
    | 'showCanvasMainView'
    | 'isPaused'
    | 'mainViewMode'
    | 'showImageOverlay'
    | 'overlayImageSource'
    | 'overlayPhotoImage'
    | 'overlayUsesSeparatedCanvas'
    | 'referenceBlendMode'
    | 'referenceOpacity'
    | 'compareDualActive'
    | 'compareSlotBLabel'
  >;

export type PreviewStripProps = Pick<
  AppUIRefsProps,
  'previewOriginalRef' | 'previewSeparatedRef' | 'previewTracerRef'
> &
  Pick<
    AppUIPreviewStripProps,
    'tracerPreviewFrozen' | 'setTracerPreviewFrozen' | 'livePreviewEnabled' | 'setLivePreviewEnabled'
  >;

export type ChromeShellProps = AppUIChromeProps & {
  showChrome: boolean;
  showKioskRemote: boolean;
};
