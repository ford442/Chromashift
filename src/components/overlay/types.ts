import type { ExportPanelProps } from './ExportPanel';
import type { PresetsPanelProps } from './PresetsPanel';
import type { CollisionStats } from '../../engine/types/RendererState';
import type { RendererBackend } from '../../engine/RendererTypes';

export type ReferenceBlendMode = 'hidden' | 'overlay' | 'split' | 'checker' | 'difference' | 'edge';
export type EngineMode = 'ts' | 'wasm';
export type LayerIndex = 0 | 1 | 2;

export type OverlaySectionId =
  | 'renderer'
  | 'layers'
  | 'tracer'
  | 'reactive'
  | 'upscale'
  | 'diagnostics'
  | 'export'
  | 'viewport'
  | 'presets';

export interface PlayPanelProps {
  isAutoPlayActive: boolean;
  onAutoPlayToggle: (active: boolean) => void;
  onReset: () => void;
  imageChangeInterval: number;
  onImageChangeIntervalChange: (seconds: number) => void;
  isImageStripOpen: boolean;
  onToggleImageStrip: () => void;
  onLoadSpecificImage: (url: string) => void;
  onLoadFile: (file: File) => void;
  referenceImageLabel: string | null;
  onLoadReferenceImage: (url: string) => void;
  onLoadReferenceFile: (file: File) => void;
}

export interface RendererPanelProps {
  rendererBackend: RendererBackend;
  rendererFallbackReason: string | null;
  webglDebugMode: number;
  onRendererBackendChange: (backend: RendererBackend) => void;
  onWebglDebugModeChange: (mode: number) => void;
  engineMode: EngineMode;
  wasmAvailable: boolean;
  onEngineModeChange: (mode: EngineMode) => void;
}

export interface LayerPanelProps {
  layerAngles: [number, number, number];
  layerExtensions: [number, number, number];
  frameRate: number;
  layerOpacity: number;
  layerOpacities: [number, number, number];
  layerScale: number;
  tracerScale: number;
  colorMode: number;
  sobelEnabled: boolean;
  softCropEnabled: boolean;
  onAngleChange: (layer: LayerIndex, angle: number) => void;
  onExtensionChange: (layer: LayerIndex, extension: number) => void;
  onFrameRateChange: (fps: number) => void;
  onLayerOpacityChange: (opacity: number) => void;
  onLayerOpacityPerLayerChange: (layer: LayerIndex, opacity: number) => void;
  onLayerScaleChange: (value: number) => void;
  onTracerScaleChange: (value: number) => void;
  onColorModeChange: (value: number) => void;
  onSobelEnabledToggle: (value: boolean) => void;
  onSoftCropEnabledToggle: (value: boolean) => void;
}

export interface TracerPanelProps {
  tracerAboveIntensity: number;
  tracerBelowIntensity: number;
  tracerAboveDuration: number;
  tracerBelowDuration: number;
  tracerMode: number;
  outputMode: number;
  layerBlendMode: number;
  tracerBlendMode: number;
  isViewingTracer: boolean;
  mainViewMode: number;
  currentImageLabel: string | null;
  referenceImageLabel: string | null;
  referenceBlendMode: ReferenceBlendMode;
  referenceOpacity: number;
  isImageStripOpen: boolean;
  onTracerAboveIntensityChange: (value: number) => void;
  onTracerBelowIntensityChange: (value: number) => void;
  onTracerAboveDurationChange: (value: number) => void;
  onTracerBelowDurationChange: (value: number) => void;
  onTracerModeChange: (value: number) => void;
  onOutputModeChange: (value: number) => void;
  onLayerBlendModeChange: (value: number) => void;
  onTracerBlendModeChange: (value: number) => void;
  onTracerViewToggle: (value: boolean) => void;
  onMainViewModeChange: (value: number) => void;
  onReferenceBlendModeChange: (value: ReferenceBlendMode) => void;
  onReferenceOpacityChange: (value: number) => void;
  onSwapSourceReference: () => void;
  onToggleImageStrip: () => void;
}

export interface DiagnosticsPanelProps {
  diagnosticsMode: boolean;
  diagnosticsOpacity: number;
  stampBoost: number;
  peakCollisionsOnly: boolean;
  collisionStats: CollisionStats;
  isPaused: boolean;
  mainViewMode: number;
  exportingTracer: boolean;
  tracerInspectHeatmap: boolean;
  tracerInspectZoom: number;
  tracerInspectExposure: number;
  tracerInspectTonemap: boolean;
  tracerInspectShowLayers: boolean;
  performanceHudEnabled: boolean;
  performanceAutoDegrade: boolean;
  performanceBudgetExceeded: boolean;
  frameRate: number;
  renderCpuTiming: { last: number; avg: number };
  renderGpuTiming: import('../../engine/types/RendererContracts').GpuRenderTiming;
  frameTimeHistory: readonly number[];
  rendererBackend: RendererBackend;
  onDiagnosticsModeChange: (value: boolean) => void;
  onDiagnosticsOpacityChange: (value: number) => void;
  onStampBoostChange: (value: number) => void;
  onPeakCollisionsOnlyChange: (value: boolean) => void;
  onPerformanceHudToggle: (value: boolean) => void;
  onPerformanceAutoDegradeToggle: (value: boolean) => void;
  onApplyPerformanceDegrade: () => void;
  onFreezeInspect: () => void;
  onExportTracer: () => void;
  onTracerInspectHeatmapToggle: (value: boolean) => void;
  onTracerInspectZoomChange: (value: number) => void;
  onTracerInspectExposureChange: (value: number) => void;
  onTracerInspectTonemapToggle: (value: boolean) => void;
  onTracerInspectShowLayersToggle: (value: boolean) => void;
  onResetInspectView: () => void;
}

export interface UpscalePanelProps {
  upscaleModel: string;
  upscaleBusy: boolean;
  upscaleProgress: number;
  upscaleInfo: string;
  onUpscaleModelChange: (value: string) => void;
  onUpscaleSource: () => void;
  onUpscaleOutput: () => void;
}

export interface ViewportPanelProps {
  squareCanvas: boolean;
  antialiasEnabled: boolean;
  viewportQuarterZoom: boolean;
  viewportHalfOverlay: boolean;
  isViewingTracer: boolean;
  mainViewMode: number;
  onSquareCanvasToggle: (value: boolean) => void;
  onAntialiasToggle: (value: boolean) => void;
  onViewportQuarterZoomToggle: (value: boolean) => void;
  onViewportHalfOverlayToggle: (value: boolean) => void;
}

export interface ReactivePanelProps {
  reactiveEnabled: boolean;
  audioEnabled: boolean;
  midiEnabled: boolean;
  micActive: boolean;
  micError: string | null;
  midiAvailable: boolean;
  midiError: string | null;
  midiLearnTarget: import('../../engine/reactive/types').MidiParamId | null;
  midiBindings: import('../../engine/reactive/types').MidiBinding[];
  audioLevels: import('../../engine/reactive/types').AudioLevelSnapshot;
  audioSensitivity: number;
  layerExtension0: number;
  onReactiveEnabledChange: (enabled: boolean) => void;
  onAudioEnabledChange: (enabled: boolean) => void;
  onMidiEnabledChange: (enabled: boolean) => void;
  onAudioSensitivityChange: (value: number) => void;
  onStartMicDemo: () => void;
  onMidiLearnTargetChange: (target: import('../../engine/reactive/types').MidiParamId | null) => void;
  onRemoveMidiBinding: (param: import('../../engine/reactive/types').MidiParamId) => void;
}

export type OverlayProps =
  PlayPanelProps &
  RendererPanelProps &
  LayerPanelProps &
  TracerPanelProps &
  DiagnosticsPanelProps &
  UpscalePanelProps &
  ExportPanelProps &
  ViewportPanelProps &
  PresetsPanelProps &
  ReactivePanelProps;
