import { MAIN_VIEW_MODES } from '../engine/viewModes';
import { effectiveLayerScaleForMultiView, multiViewPerformanceNote } from '../engine/compareViews';
import { isOverlayImageSourceAvailable } from '../engine/overlayImageSource';
import { isWasmReady } from '../engine/WasmEngine';
import { DEFAULT_FPS } from '../state/defaults';
import type { ChromashiftRefs, ChromashiftStore } from './useChromashiftStore';

interface HandlerBundle {
  selectSourceIndex: (index: number) => void;
  handleAngleChange: (layer: 0 | 1 | 2, angle: number) => void;
  handleExtensionChange: (layer: 0 | 1 | 2, extension: number) => void;
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
  videoExportSettings: import('../state/types').VideoExportSettings;
  codecSupport: import('../engine/videoExport/videoCodecs').VideoCodecSupport;
  handleExportVideo: () => Promise<void>;
  handleCancelVideoExport: () => void;
  onVideoExportDurationChange: (seconds: number) => void;
  onVideoExportFpsChange: (fps: number) => void;
  onVideoExportScaleChange: (scale: number) => void;
  onVideoExportIncludeTracersChange: (include: boolean) => void;
  onVideoExportPassModeChange: (mode: import('../engine/types/RendererContracts').ExportPassMode) => void;
  onVideoExportFilenameChange: (filename: string) => void;
  onVideoExportUsePresetAnglesChange: (usePreset: boolean) => void;
  builtinPresets: readonly import('../state/presetGallery').BuiltinPreset[];
  savedPresets: import('../state/presetLibrary').StoredPreset[];
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

export function useAppUiProps(
  refs: ChromashiftRefs,
  store: ChromashiftStore,
  handlers: HandlerBundle,
  kiosk: { isFullscreen: boolean; toggleFullscreen: () => Promise<void> },
) {
  const { state, actions } = store;
  const { media, layers, tracers, output, engine, ui, reactive } = state;

  const currentImage = media.imageList[media.currentIndex] ?? null;
  const isViewingTracer = output.mainViewMode === MAIN_VIEW_MODES.FULL_RES_TRACER;
  const photoModeImage =
    output.mainViewMode === MAIN_VIEW_MODES.SOURCE_IMAGE ? currentImage
      : output.mainViewMode === MAIN_VIEW_MODES.REFERENCE_IMAGE ? media.reference
        : output.mainViewMode === MAIN_VIEW_MODES.PREVIOUS_IMAGE ? media.previous
          : null;
  const isReferenceCompareMode =
    output.mainViewMode === MAIN_VIEW_MODES.COMPARE_REFERENCE_COMPOSITE && !!media.reference;
  const showCanvasMainView = photoModeImage === null;
  const overlayImageSource = ui.overlayImageSource;
  const overlaySourceAvailable = isOverlayImageSourceAvailable(
    overlayImageSource,
    currentImage,
    media.reference,
    media.previous,
  );
  const showImageOverlay =
    ui.referenceBlendMode !== 'hidden'
    && overlaySourceAvailable
    && !isReferenceCompareMode;
  const overlayPhotoImage =
    overlayImageSource === 'source' ? currentImage
      : overlayImageSource === 'reference' ? media.reference
        : overlayImageSource === 'previous' ? media.previous
          : null;
  const overlayUsesSeparatedCanvas = overlayImageSource === 'separated';

  const compareView = ui.compareView;
  const compareDualActive = compareView.layout === 'dual';
  const comparePerformanceNote =
    compareDualActive && effectiveLayerScaleForMultiView(layers.scale, 'dual').reduced
      ? multiViewPerformanceNote('dual')
      : null;

  return {
    containerRef: refs.containerRef,
    mainViewportRef: refs.mainViewportRef,
    previewTracerRef: refs.previewTracerRef,
    photoModeImage,
    isReferenceCompareMode,
    referenceImage: media.reference,
    showCanvasMainView,
    isPaused: engine.paused,
    mainViewMode: output.mainViewMode,
    MAIN_VIEW_MODES,
    showImageOverlay,
    overlayImageSource,
    overlayPhotoImage,
    overlayUsesSeparatedCanvas,
    referenceBlendMode: ui.referenceBlendMode,
    referenceOpacity: ui.referenceOpacity,
    previewOriginalRef: refs.previewOriginalRef,
    previewSeparatedRef: refs.previewSeparatedRef,
    overlaySeparatedRef: refs.overlaySeparatedRef,
    gpuError: engine.gpuError,
    gpuReady: engine.gpuReady,
    rendererBackend: engine.backend,
    rendererFallbackReason: engine.fallbackReason,
    webglDebugMode: output.webglDebugMode,
    setWebglDebugMode: actions.setWebglDebugMode,
    collisionStats: ui.collisionStats,
    isAutoPlayActive: ui.isAutoPlayActive,
    setIsAutoPlayActive: actions.setIsAutoPlayActive,
    isImageStripOpen: ui.isImageStripOpen,
    setIsImageStripOpen: actions.setIsImageStripOpen,
    imageList: media.imageList,
    currentImageIndex: media.currentIndex,
    selectSourceIndex: handlers.selectSourceIndex,
    handleLoadFile: handlers.handleLoadFile,
    handleLoadSpecificImage: handlers.handleLoadSpecificImage,
    handleLoadReferenceFile: handlers.handleLoadReferenceFile,
    handleDropFiles: handlers.handleDropFiles,
    handleClearLocalLibrary: handlers.handleClearLocalLibrary,
    setReferenceImage: actions.setReferenceImage,
    swapSourceAndReference: handlers.swapSourceAndReference,
    setReferenceBlendMode: actions.setReferenceBlendMode,
    setOverlayImageSource: actions.setOverlayImageSource,
    setReferenceOpacity: actions.setReferenceOpacity,
    handleFreezeInspect: handlers.handleFreezeInspect,
    tracerInspectZoom: output.tracerInspect.zoom,
    setTracerInspectZoom: actions.setTracerInspectZoom,
    tracerInspectPan: output.tracerInspect.pan,
    tracerInspectHeatmap: output.tracerInspect.heatmap,
    setTracerInspectHeatmap: actions.setTracerInspectHeatmap,
    tracerInspectExposure: output.tracerInspect.exposure,
    setTracerInspectExposure: actions.setTracerInspectExposure,
    tracerInspectTonemap: output.tracerInspect.tonemap,
    setTracerInspectTonemap: actions.setTracerInspectTonemap,
    tracerInspectShowLayers: output.tracerInspect.showLayers,
    setTracerInspectShowLayers: actions.setTracerInspectShowLayers,
    handleResetInspectView: actions.resetInspectView,
    exportingTracer: ui.exportingTracer,
    handleExportTracer: handlers.handleExportTracer,
    exportingVideo: handlers.exportingVideo,
    videoExportProgress: handlers.videoExportProgress,
    videoExportSettings: handlers.videoExportSettings,
    codecSupport: handlers.codecSupport,
    handleExportVideo: handlers.handleExportVideo,
    handleCancelVideoExport: handlers.handleCancelVideoExport,
    onVideoExportDurationChange: handlers.onVideoExportDurationChange,
    onVideoExportFpsChange: handlers.onVideoExportFpsChange,
    onVideoExportScaleChange: handlers.onVideoExportScaleChange,
    onVideoExportIncludeTracersChange: handlers.onVideoExportIncludeTracersChange,
    onVideoExportPassModeChange: handlers.onVideoExportPassModeChange,
    onVideoExportFilenameChange: handlers.onVideoExportFilenameChange,
    onVideoExportUsePresetAnglesChange: handlers.onVideoExportUsePresetAnglesChange,
    builtinPresets: handlers.builtinPresets,
    savedPresets: handlers.savedPresets,
    presetStatus: handlers.presetStatus,
    presetError: handlers.presetError ?? ui.presetLoadError,
    handleSavePreset: handlers.handleSavePreset,
    handleLoadPreset: handlers.handleLoadPreset,
    handleDeletePreset: handlers.handleDeletePreset,
    handleApplyBuiltinPreset: handlers.handleApplyBuiltinPreset,
    canvasBRef: refs.canvasBRef,
    compareLayout: compareView.layout,
    compareDualActive,
    compareSyncPlay: compareView.syncPlay,
    compareSlotBLabel: compareView.slotB.label,
    compareDualAvailable: engine.backend === 'webgpu' && !ui.kioskEnabled,
    comparePerformanceNote,
    onCompareLayoutChange: actions.setCompareLayout,
    onCompareSyncPlayToggle: actions.setCompareSyncPlay,
    onCompareWithBuiltin: handlers.handleCompareWithBuiltin,
    onCompareWithSaved: handlers.handleCompareWithSaved,
    handleCopyPresetUrl: handlers.handleCopyPresetUrl,
    handleExportPresetFile: handlers.handleExportPresetFile,
    handleImportPresetFile: handlers.handleImportPresetFile,
    layerAngles: layers.angles,
    handleAngleChange: handlers.handleAngleChange,
    layerExtensions: layers.extensions,
    handleExtensionChange: handlers.handleExtensionChange,
    frameRate: engine.fps,
    setFrameRate: actions.setFrameRate,
    DEFAULT_FPS,
    layerOpacity: layers.opacity,
    setLayerOpacity: actions.setLayerOpacity,
    layerOpacities: layers.opacities,
    setLayerOpacities: actions.setLayerOpacities,
    layerScale: layers.scale,
    setLayerScale: actions.setLayerScale,
    tracerScale: tracers.scale,
    setTracerScale: actions.setTracerScale,
    tracerAboveIntensity: tracers.aboveIntensity,
    setTracerAboveIntensity: actions.setTracerAboveIntensity,
    tracerBelowIntensity: tracers.belowIntensity,
    setTracerBelowIntensity: actions.setTracerBelowIntensity,
    tracerAboveDuration: tracers.aboveDuration,
    setTracerAboveDuration: actions.setTracerAboveDuration,
    tracerBelowDuration: tracers.belowDuration,
    setTracerBelowDuration: actions.setTracerBelowDuration,
    tracerMode: tracers.mode,
    setTracerMode: actions.setTracerMode,
    layerBlendMode: tracers.layerBlendMode,
    setLayerBlendMode: actions.setLayerBlendMode,
    tracerBlendMode: tracers.tracerBlendMode,
    setTracerBlendMode: actions.setTracerBlendMode,
    outputMode: output.outputMode,
    setOutputMode: actions.setOutputMode,
    diagnosticsMode: output.diagnosticsMode,
    setDiagnosticsMode: actions.setDiagnosticsMode,
    diagnosticsOpacity: output.diagnosticsOpacity,
    setDiagnosticsOpacity: actions.setDiagnosticsOpacity,
    stampBoost: output.stampBoost,
    setStampBoost: actions.setStampBoost,
    peakCollisionsOnly: output.peakCollisionsOnly,
    setPeakCollisionsOnly: actions.setPeakCollisionsOnly,
    performanceHudEnabled: output.performanceHudEnabled,
    setPerformanceHudEnabled: actions.setPerformanceHudEnabled,
    performanceAutoDegrade: output.performanceAutoDegrade,
    setPerformanceAutoDegrade: actions.setPerformanceAutoDegrade,
    performanceBudgetExceeded: ui.performanceBudgetExceeded,
    renderGpuTiming: ui.renderGpuTiming,
    frameTimeHistory: ui.frameTimeHistory,
    applyPerformanceDegrade: actions.applyPerformanceDegrade,
    colorMode: layers.colorMode,
    setColorMode: actions.setColorMode,
    sobelEnabled: layers.sobelEnabled,
    setSobelEnabled: actions.setSobelEnabled,
    softCropEnabled: layers.softCropEnabled,
    setSoftCropEnabled: actions.setSoftCropEnabled,
    viewportQuarterZoom: output.viewportQuarterZoom,
    setViewportQuarterZoom: actions.setViewportQuarterZoom,
    viewportHalfOverlay: output.viewportHalfOverlay,
    setViewportHalfOverlay: actions.setViewportHalfOverlay,
    squareCanvas: output.squareCanvas,
    setSquareCanvas: actions.setSquareCanvas,
    antialiasEnabled: output.antialiasEnabled,
    setAntialiasEnabled: actions.setAntialiasEnabled,
    handleReset: handlers.handleReset,
    imageChangeInterval: ui.imageChangeInterval,
    setImageChangeInterval: actions.setImageChangeInterval,
    upscaleModel: ui.upscaleModel,
    setUpscaleModel: actions.setUpscaleModel,
    handleUpscaleSource: handlers.handleUpscaleSource,
    handleUpscaleOutput: handlers.handleUpscaleOutput,
    upscaleBusy: ui.upscaleBusy,
    upscaleProgress: ui.upscaleProgress,
    upscaleInfo: ui.upscaleInfo,
    engineMode: engine.engineMode,
    setEngineMode: actions.setEngineMode,
    wasmAvailable: engine.wasmAvailable,
    specificImageError: media.specificError,
    renderCpuTiming: ui.renderCpuTiming,
    avgLuminance: engine.avgLuminance,
    canvasRef: refs.canvasRef,
    setTracerPreviewFrozen: actions.setTracerPreviewFrozen,
    tracerPreviewFrozen: output.tracerPreviewFrozen,
    setLivePreviewEnabled: actions.setLivePreviewEnabled,
    livePreviewEnabled: output.livePreviewEnabled,
    setIsPaused: actions.setIsPaused,
    setMainViewMode: actions.setMainViewMode,
    setAvgLuminance: actions.setAvgLuminance,
    isViewingTracer,
    currentImage,
    rendererRef: refs.rendererRef,
    handleLoadReferenceImage: handlers.handleLoadReferenceImage,
    isWasmReady,
    setSpecificImageError: actions.setSpecificImageError,
    kioskEnabled: ui.kioskEnabled,
    kioskUiHidden: ui.kioskUiHidden,
    kioskAttractMode: ui.kioskAttractMode,
    shortcutsOverlayVisible: ui.shortcutsOverlayVisible,
    setKioskUiHidden: actions.setKioskUiHidden,
    setKioskAttractMode: actions.setKioskAttractMode,
    setShortcutsOverlayVisible: actions.setShortcutsOverlayVisible,
    kioskFullscreen: kiosk.isFullscreen,
    toggleKioskFullscreen: kiosk.toggleFullscreen,
    reactiveEnabled: reactive.enabled,
    audioEnabled: reactive.audioEnabled,
    midiEnabled: reactive.midiEnabled,
    micActive: reactive.micActive,
    micError: reactive.micError,
    midiAvailable: reactive.midiAvailable,
    midiError: reactive.midiError,
    midiLearnTarget: reactive.midiLearnTarget,
    midiBindings: reactive.midiBindings,
    audioLevels: reactive.audioLevels,
    audioSensitivity: reactive.audioSensitivity,
    layerExtension0: layers.extensions[0],
    onReactiveEnabledChange: actions.setReactiveEnabled,
    onAudioEnabledChange: actions.setReactiveAudioEnabled,
    onMidiEnabledChange: actions.setReactiveMidiEnabled,
    onAudioSensitivityChange: actions.setReactiveAudioSensitivity,
    onStartMicDemo: () => {
      actions.setReactiveEnabled(true);
      actions.setReactiveAudioEnabled(true);
    },
    onMidiLearnTargetChange: actions.setMidiLearnTarget,
    onRemoveMidiBinding: actions.removeMidiBinding,
  };
}
