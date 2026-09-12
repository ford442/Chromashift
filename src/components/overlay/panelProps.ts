/**
 * Per-panel prop slices for {@link NunifOverlay}.
 *
 * `NunifOverlay` used to spread the whole `OverlayProps` bag into every panel
 * (`<TracerPanel {...props} />`), which made the panels' `memo()` wrappers
 * decorative: changing *any* control re-rendered *all* of them, because every
 * panel's prop object differed on some unrelated field. Each panel already
 * declares its own `*PanelProps` interface, so we narrow the bag down to that
 * interface and hand the panel only what it reads.
 *
 * The key maps below are `Record<keyof XPanelProps, true>`, so TypeScript
 * rejects both a typo'd key and a *missing* one — adding a field to a panel's
 * props interface fails the build until it is listed here.
 */
import type {
  DiagnosticsPanelProps,
  LayerPanelProps,
  OverlayProps,
  PlayPanelProps,
  ReactivePanelProps,
  RendererPanelProps,
  TracerPanelProps,
  UpscalePanelProps,
  ViewportPanelProps,
} from './types';
import type { ExportPanelProps } from './ExportPanel';
import type { PresetsPanelProps } from './PresetsPanel';

function keysOf<T>(map: Record<keyof T, true>): readonly (keyof T)[] {
  return Object.keys(map) as (keyof T)[];
}

function pick<T>(source: OverlayProps, keys: readonly (keyof T)[]): T {
  const target = {} as T;
  for (const key of keys) {
    target[key] = (source as unknown as T)[key];
  }
  return target;
}

const PLAY_KEYS = keysOf<PlayPanelProps>({
  isAutoPlayActive: true,
  onAutoPlayToggle: true,
  onReset: true,
  imageChangeInterval: true,
  onImageChangeIntervalChange: true,
  isImageStripOpen: true,
  onToggleImageStrip: true,
  onLoadSpecificImage: true,
  onLoadFile: true,
  referenceImageLabel: true,
  onLoadReferenceImage: true,
  onLoadReferenceFile: true,
});

const RENDERER_KEYS = keysOf<RendererPanelProps>({
  rendererBackend: true,
  rendererFallbackReason: true,
  webglDebugMode: true,
  onRendererBackendChange: true,
  onWebglDebugModeChange: true,
  engineMode: true,
  wasmAvailable: true,
  onEngineModeChange: true,
  xrAvailable: true,
  xrReason: true,
  xrImmersive: true,
  xrBusy: true,
  xrError: true,
  xrEnterAllowed: true,
  kioskEnabled: true,
  onEnterXr: true,
  onExitXr: true,
});

const LAYER_KEYS = keysOf<LayerPanelProps>({
  layerExtensions: true,
  frameRate: true,
  layerOpacity: true,
  layerOpacities: true,
  layerScale: true,
  tracerScale: true,
  colorMode: true,
  sobelEnabled: true,
  softCropEnabled: true,
  onAngleChange: true,
  onExtensionChange: true,
  onFrameRateChange: true,
  onLayerOpacityChange: true,
  onLayerOpacityPerLayerChange: true,
  onLayerScaleChange: true,
  onTracerScaleChange: true,
  onColorModeChange: true,
  onSobelEnabledToggle: true,
  onSoftCropEnabledToggle: true,
  colorProfiles: true,
});

const TRACER_KEYS = keysOf<TracerPanelProps>({
  tracerAboveIntensity: true,
  tracerBelowIntensity: true,
  tracerAboveDuration: true,
  tracerBelowDuration: true,
  tracerMode: true,
  motionMode: true,
  motionGain: true,
  motionDecayBias: true,
  motionThreshold: true,
  outputMode: true,
  layerBlendMode: true,
  tracerBlendMode: true,
  isViewingTracer: true,
  mainViewMode: true,
  currentImageLabel: true,
  referenceImageLabel: true,
  referenceBlendMode: true,
  overlayImageSource: true,
  referenceOpacity: true,
  isImageStripOpen: true,
  onTracerAboveIntensityChange: true,
  onTracerBelowIntensityChange: true,
  onTracerAboveDurationChange: true,
  onTracerBelowDurationChange: true,
  onTracerModeChange: true,
  onMotionModeChange: true,
  onMotionGainChange: true,
  onMotionDecayBiasChange: true,
  onMotionThresholdChange: true,
  onOutputModeChange: true,
  onLayerBlendModeChange: true,
  onTracerBlendModeChange: true,
  onTracerViewToggle: true,
  onMainViewModeChange: true,
  onReferenceBlendModeChange: true,
  onOverlayImageSourceChange: true,
  onReferenceOpacityChange: true,
  onSwapSourceReference: true,
  onToggleImageStrip: true,
});

const DIAGNOSTICS_KEYS = keysOf<DiagnosticsPanelProps>({
  diagnosticsMode: true,
  diagnosticsOpacity: true,
  stampBoost: true,
  peakCollisionsOnly: true,
  isPaused: true,
  mainViewMode: true,
  exportingTracer: true,
  tracerInspectHeatmap: true,
  tracerInspectZoom: true,
  tracerInspectExposure: true,
  tracerInspectTonemap: true,
  tracerInspectShowLayers: true,
  performanceHudEnabled: true,
  performanceAutoDegrade: true,
  frameRate: true,
  rendererBackend: true,
  onDiagnosticsModeChange: true,
  onDiagnosticsOpacityChange: true,
  onStampBoostChange: true,
  onPeakCollisionsOnlyChange: true,
  onPerformanceHudToggle: true,
  onPerformanceAutoDegradeToggle: true,
  onApplyPerformanceDegrade: true,
  onFreezeInspect: true,
  onExportTracer: true,
  onTracerInspectHeatmapToggle: true,
  onTracerInspectZoomChange: true,
  onTracerInspectExposureChange: true,
  onTracerInspectTonemapToggle: true,
  onTracerInspectShowLayersToggle: true,
  onResetInspectView: true,
});

const UPSCALE_KEYS = keysOf<UpscalePanelProps>({
  upscaleModel: true,
  upscaleBusy: true,
  upscaleProgress: true,
  upscaleInfo: true,
  onUpscaleModelChange: true,
  onUpscaleSource: true,
  onUpscaleOutput: true,
});

const EXPORT_KEYS = keysOf<ExportPanelProps>({
  exportingVideo: true,
  videoExportProgress: true,
  videoExportSettings: true,
  codecSupport: true,
  onExportVideo: true,
  onCancelVideoExport: true,
  onVideoExportDurationChange: true,
  onVideoExportFpsChange: true,
  onVideoExportScaleChange: true,
  onVideoExportIncludeTracersChange: true,
  onVideoExportPassModeChange: true,
  onVideoExportFilenameChange: true,
  onVideoExportUsePresetAnglesChange: true,
  onVideoExportContainerChange: true,
  onVideoExportQualityChange: true,
});

const VIEWPORT_KEYS = keysOf<ViewportPanelProps>({
  squareCanvas: true,
  antialiasEnabled: true,
  displayColorSpace: true,
  viewportQuarterZoom: true,
  viewportHalfOverlay: true,
  isViewingTracer: true,
  mainViewMode: true,
  onSquareCanvasToggle: true,
  onAntialiasToggle: true,
  onDisplayColorSpaceChange: true,
  onViewportQuarterZoomToggle: true,
  onViewportHalfOverlayToggle: true,
  compareLayout: true,
  compareSyncPlay: true,
  compareDualAvailable: true,
  comparePerformanceNote: true,
  onCompareLayoutChange: true,
  onCompareSyncPlayToggle: true,
});

const PRESETS_KEYS = keysOf<PresetsPanelProps>({
  builtinPresets: true,
  savedPresets: true,
  presetStatus: true,
  presetError: true,
  onSavePreset: true,
  onLoadPreset: true,
  onDeletePreset: true,
  onApplyBuiltinPreset: true,
  onCopyPresetUrl: true,
  onExportPresetFile: true,
  onImportPresetFile: true,
  compareDualAvailable: true,
  onCompareWithBuiltin: true,
  onCompareWithSaved: true,
});

const REACTIVE_KEYS = keysOf<ReactivePanelProps>({
  reactiveEnabled: true,
  audioEnabled: true,
  midiEnabled: true,
  micActive: true,
  micError: true,
  midiAvailable: true,
  midiError: true,
  midiLearnTarget: true,
  midiBindings: true,
  audioLevels: true,
  audioSensitivity: true,
  layerExtension0: true,
  onReactiveEnabledChange: true,
  onAudioEnabledChange: true,
  onMidiEnabledChange: true,
  onAudioSensitivityChange: true,
  onStartMicDemo: true,
  onMidiLearnTargetChange: true,
  onRemoveMidiBinding: true,
});

/**
 * Every panel's declared prop keys, keyed by panel id.
 *
 * Exported for `panelProps.test.ts`, which uses it to assert that changing a
 * field owned by one panel leaves every other panel's slice shallow-equal —
 * the property that makes the panels' `memo()` wrappers do any work.
 */
export const PANEL_PROP_KEYS = {
  play: PLAY_KEYS,
  renderer: RENDERER_KEYS,
  layer: LAYER_KEYS,
  tracer: TRACER_KEYS,
  diagnostics: DIAGNOSTICS_KEYS,
  upscale: UPSCALE_KEYS,
  export: EXPORT_KEYS,
  viewport: VIEWPORT_KEYS,
  presets: PRESETS_KEYS,
  reactive: REACTIVE_KEYS,
} as const satisfies Record<string, readonly string[]>;

export const selectPlayPanelProps = (p: OverlayProps) => pick<PlayPanelProps>(p, PLAY_KEYS);
export const selectRendererPanelProps = (p: OverlayProps) => pick<RendererPanelProps>(p, RENDERER_KEYS);
export const selectLayerPanelProps = (p: OverlayProps) => pick<LayerPanelProps>(p, LAYER_KEYS);
export const selectTracerPanelProps = (p: OverlayProps) => pick<TracerPanelProps>(p, TRACER_KEYS);
export const selectDiagnosticsPanelProps = (p: OverlayProps) => pick<DiagnosticsPanelProps>(p, DIAGNOSTICS_KEYS);
export const selectUpscalePanelProps = (p: OverlayProps) => pick<UpscalePanelProps>(p, UPSCALE_KEYS);
export const selectExportPanelProps = (p: OverlayProps) => pick<ExportPanelProps>(p, EXPORT_KEYS);
export const selectViewportPanelProps = (p: OverlayProps) => pick<ViewportPanelProps>(p, VIEWPORT_KEYS);
export const selectPresetsPanelProps = (p: OverlayProps) => pick<PresetsPanelProps>(p, PRESETS_KEYS);
export const selectReactivePanelProps = (p: OverlayProps) => pick<ReactivePanelProps>(p, REACTIVE_KEYS);
