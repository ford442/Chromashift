import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import type { ImageEntry } from '../engine/TextureManager';
import type { RendererBackend } from '../engine/RendererTypes';
import type { CollisionStats } from '../engine/types/RendererState';
import type { MainViewMode } from '../engine/viewModes';
import type { EngineKind } from '../engine/WasmEngine';
import type { GpuRuntimeError } from '../engine/gpuBootstrap';
import type { OverlayImageSource, ReferenceBlendMode } from '../components/overlay/types';
import {
  chromashiftReducer,
  createInitialState,
  type ChromashiftAction,
  type ChromashiftSettingsInput,
} from '../state/chromashiftReducer';
import { createInitialStateFromUrl } from '../state/presetUrl';
import type { ChromashiftState, LayerTriple } from '../state/types';
import type { ReactiveModulation } from '../engine/reactive/types';

export interface ChromashiftRefs {
  previewTracerRef: RefObject<HTMLCanvasElement | null>;
  orchestratorRef: RefObject<import('../engine/RendererOrchestrator').RendererOrchestrator | null>;
  rendererRef: RefObject<import('../engine/RendererTypes').ChromashiftRenderer | null>;
  textureManagerRef: RefObject<import('../engine/RendererTypes').ChromashiftTextureManager | null>;
  deviceRef: RefObject<GPUDevice | null>;
  webGpuSessionRef: RefObject<import('../engine/gpuBootstrap').WebGpuSession | null>;
  containerRef: RefObject<HTMLDivElement | null>;
  mainViewportRef: RefObject<HTMLDivElement | null>;
  previewOriginalRef: RefObject<HTMLCanvasElement | null>;
  previewSeparatedRef: RefObject<HTMLCanvasElement | null>;
  overlaySeparatedRef: RefObject<HTMLCanvasElement | null>;
  mainCanvasRef: RefObject<HTMLCanvasElement | null>;
  upscalerRef: RefObject<import('../engine/Upscaler').Upscaler | null>;
  tracerScratchRef: RefObject<HTMLCanvasElement | null>;
  capturePreviewAfterRender: MutableRefObject<boolean>;
  tracerDragRef: MutableRefObject<{ pointerId: number; x: number; y: number } | null>;
  animAnglesRef: MutableRefObject<LayerTriple<number>>;
  /** Compare slot B (dual layout): canvas, renderer, independent angle clock. */
  canvasBRef: RefObject<HTMLCanvasElement | null>;
  rendererBRef: MutableRefObject<import('../engine/RendererTypes').ChromashiftRenderer | null>;
  animAnglesBRef: MutableRefObject<LayerTriple<number>>;
  /** Last source texture handed to the renderer(s); lets slot B attach late. */
  sourceTextureRef: MutableRefObject<GPUTexture | null>;
  lastAngleSyncRef: MutableRefObject<number>;
  lastRenderMetricSyncRef: MutableRefObject<number>;
  loadGenRef: MutableRefObject<number>;
  maskTextureRef: MutableRefObject<GPUTexture | null>;
  gpuImageAnalysisRef: RefObject<import('../engine/compute/GpuImageAnalysis').GpuImageAnalysis | null>;
  imageListRef: MutableRefObject<ImageEntry[]>;
  currentImageIndexRef: MutableRefObject<number>;
  ownedObjectUrlsRef: MutableRefObject<string[]>;
  engineModeRef: MutableRefObject<EngineKind>;
  renderStateRef: MutableRefObject<ChromashiftState>;
  /** Per-frame audio modulation; null when reactive input is off or idle. */
  reactiveModRef: MutableRefObject<ReactiveModulation | null>;
}

export function useChromashiftRefs(): ChromashiftRefs {
  const previewTracerRef = useRef<HTMLCanvasElement>(null);
  const orchestratorRef = useRef<import('../engine/RendererOrchestrator').RendererOrchestrator | null>(null);
  const rendererRef = useRef<import('../engine/RendererTypes').ChromashiftRenderer | null>(null);
  const textureManagerRef = useRef<import('../engine/RendererTypes').ChromashiftTextureManager | null>(null);
  const deviceRef = useRef<GPUDevice | null>(null);
  const webGpuSessionRef = useRef<import('../engine/gpuBootstrap').WebGpuSession | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const mainViewportRef = useRef<HTMLDivElement>(null);
  const previewOriginalRef = useRef<HTMLCanvasElement>(null);
  const previewSeparatedRef = useRef<HTMLCanvasElement>(null);
  const overlaySeparatedRef = useRef<HTMLCanvasElement>(null);
  const mainCanvasRef = useRef<HTMLCanvasElement>(null);
  const upscalerRef = useRef<import('../engine/Upscaler').Upscaler | null>(null);
  const tracerScratchRef = useRef<HTMLCanvasElement | null>(null);
  const capturePreviewAfterRender = useRef(false);
  const tracerDragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const animAnglesRef = useRef<LayerTriple<number>>([0, 0, 0]);
  const canvasBRef = useRef<HTMLCanvasElement>(null);
  const rendererBRef = useRef<import('../engine/RendererTypes').ChromashiftRenderer | null>(null);
  const animAnglesBRef = useRef<LayerTriple<number>>([0, 0, 0]);
  const sourceTextureRef = useRef<GPUTexture | null>(null);
  const lastAngleSyncRef = useRef(0);
  const lastRenderMetricSyncRef = useRef(0);
  const loadGenRef = useRef(0);
  const maskTextureRef = useRef<GPUTexture | null>(null);
  const gpuImageAnalysisRef = useRef<import('../engine/compute/GpuImageAnalysis').GpuImageAnalysis | null>(null);
  const imageListRef = useRef<ImageEntry[]>([]);
  const currentImageIndexRef = useRef(0);
  const ownedObjectUrlsRef = useRef<string[]>([]);
  const engineModeRef = useRef<EngineKind>('ts');
  const renderStateRef = useRef<ChromashiftState>(createInitialState());
  const reactiveModRef = useRef<ReactiveModulation | null>(null);

  return {
    previewTracerRef,
    orchestratorRef,
    rendererRef,
    textureManagerRef,
    deviceRef,
    webGpuSessionRef,
    containerRef,
    mainViewportRef,
    previewOriginalRef,
    previewSeparatedRef,
    overlaySeparatedRef,
    mainCanvasRef,
    upscalerRef,
    tracerScratchRef,
    capturePreviewAfterRender,
    tracerDragRef,
    animAnglesRef,
    canvasBRef,
    rendererBRef,
    animAnglesBRef,
    sourceTextureRef,
    lastAngleSyncRef,
    lastRenderMetricSyncRef,
    loadGenRef,
    maskTextureRef,
    gpuImageAnalysisRef,
    imageListRef,
    currentImageIndexRef,
    ownedObjectUrlsRef,
    engineModeRef,
    renderStateRef,
    reactiveModRef,
  };
}

/**
 * Route a new source texture to every live renderer (slot A + compare slot B)
 * and record it so a late-created slot B renderer can attach it.
 */
export function applySourceTexture(refs: ChromashiftRefs, tex: unknown): void {
  refs.sourceTextureRef.current = tex as GPUTexture;
  refs.rendererRef.current?.setTexture(tex);
  refs.rendererBRef.current?.setTexture(tex);
}

export function useChromashiftStore(refs: ChromashiftRefs) {
  // Lazy initializer applies any ?preset= URL parameter before the first
  // render commit, so a shared preset is live before the first frame.
  const [state, dispatch] = useReducer(chromashiftReducer, undefined, () => createInitialStateFromUrl());
  const {
    renderStateRef,
    engineModeRef,
    imageListRef,
    currentImageIndexRef,
    animAnglesRef,
  } = refs;

  useEffect(() => {
    renderStateRef.current = state;
  }, [renderStateRef, state]);

  useEffect(() => {
    engineModeRef.current = state.engine.engineMode;
  }, [engineModeRef, state.engine.engineMode]);

  useEffect(() => {
    imageListRef.current = state.media.imageList;
  }, [imageListRef, state.media.imageList]);

  useEffect(() => {
    currentImageIndexRef.current = state.media.currentIndex;
  }, [currentImageIndexRef, state.media.currentIndex]);

  useEffect(() => {
    animAnglesRef.current = [...state.layers.angles];
  }, [animAnglesRef, state.layers.angles]);

  const actions = useMemo(() => ({
    dispatch,
    resetRenderDefaults: () => dispatch({ type: 'reset/renderDefaults' }),
    applySettings: (settings: ChromashiftSettingsInput) =>
      dispatch({ type: 'settings/apply', settings }),
    setImageList: (imageList: ImageEntry[]) =>
      dispatch({ type: 'media/patch', patch: { imageList } }),
    setCurrentImageIndex: (currentIndex: number) =>
      dispatch({ type: 'media/patch', patch: { currentIndex } }),
    setReferenceImage: (reference: ImageEntry | null) =>
      dispatch({ type: 'media/patch', patch: { reference } }),
    setPreviousImage: (previous: ImageEntry | null) =>
      dispatch({ type: 'media/patch', patch: { previous } }),
    setImageAspect: (aspect: number) =>
      dispatch({ type: 'media/patch', patch: { aspect } }),
    setSpecificImageError: (specificError: string | null) =>
      dispatch({ type: 'media/patch', patch: { specificError } }),
    setLayerAngles: (angles: LayerTriple<number>) =>
      dispatch({ type: 'layers/patch', patch: { angles } }),
    setLayerExtensions: (extensions: LayerTriple<number>) =>
      dispatch({ type: 'layers/patch', patch: { extensions } }),
    setFrameRate: (fps: number) =>
      dispatch({ type: 'engine/patch', patch: { fps } }),
    setAvgLuminance: (avgLuminance: number) =>
      dispatch({ type: 'engine/patch', patch: { avgLuminance } }),
    setLayerOpacity: (opacity: number) =>
      dispatch({ type: 'layers/patch', patch: { opacity } }),
    setLayerOpacities: (opacities: LayerTriple<number>) =>
      dispatch({ type: 'layers/patch', patch: { opacities } }),
    setLayerScale: (scale: number) =>
      dispatch({ type: 'layers/patch', patch: { scale } }),
    setTracerScale: (scale: number) =>
      dispatch({ type: 'tracers/patch', patch: { scale } }),
    setTracerAboveIntensity: (aboveIntensity: number) =>
      dispatch({ type: 'tracers/patch', patch: { aboveIntensity } }),
    setTracerBelowIntensity: (belowIntensity: number) =>
      dispatch({ type: 'tracers/patch', patch: { belowIntensity } }),
    setTracerAboveDuration: (aboveDuration: number) =>
      dispatch({ type: 'tracers/patch', patch: { aboveDuration } }),
    setTracerBelowDuration: (belowDuration: number) =>
      dispatch({ type: 'tracers/patch', patch: { belowDuration } }),
    setTracerMode: (mode: number) =>
      dispatch({ type: 'tracers/patch', patch: { mode } }),
    setLayerBlendMode: (layerBlendMode: number) =>
      dispatch({ type: 'tracers/patch', patch: { layerBlendMode } }),
    setTracerBlendMode: (tracerBlendMode: number) =>
      dispatch({ type: 'tracers/patch', patch: { tracerBlendMode } }),
    setSquareCanvas: (squareCanvas: boolean) =>
      dispatch({ type: 'output/patch', patch: { squareCanvas } }),
    setAntialiasEnabled: (antialiasEnabled: boolean) =>
      dispatch({ type: 'output/patch', patch: { antialiasEnabled } }),
    setColorMode: (colorMode: number) =>
      dispatch({ type: 'layers/patch', patch: { colorMode } }),
    setSobelEnabled: (sobelEnabled: boolean) =>
      dispatch({ type: 'layers/patch', patch: { sobelEnabled } }),
    setSoftCropEnabled: (softCropEnabled: boolean) =>
      dispatch({ type: 'layers/patch', patch: { softCropEnabled } }),
    setOutputMode: (outputMode: number) =>
      dispatch({ type: 'output/patch', patch: { outputMode } }),
    setDiagnosticsMode: (diagnosticsMode: boolean) =>
      dispatch({ type: 'output/patch', patch: { diagnosticsMode } }),
    setDiagnosticsOpacity: (diagnosticsOpacity: number) =>
      dispatch({ type: 'output/patch', patch: { diagnosticsOpacity } }),
    setStampBoost: (stampBoost: number) =>
      dispatch({ type: 'output/patch', patch: { stampBoost } }),
    setPeakCollisionsOnly: (peakCollisionsOnly: boolean) =>
      dispatch({ type: 'output/patch', patch: { peakCollisionsOnly } }),
    setWebglDebugMode: (webglDebugMode: number) =>
      dispatch({ type: 'output/patch', patch: { webglDebugMode } }),
    setIsPaused: (paused: boolean) =>
      dispatch({ type: 'engine/patch', patch: { paused } }),
    togglePaused: () => dispatch({ type: 'ui/togglePaused' }),
    setMainViewMode: (mainViewMode: MainViewMode) =>
      dispatch({ type: 'output/patch', patch: { mainViewMode } }),
    setTracerInspectZoom: (zoom: number) =>
      dispatch({ type: 'output/patchInspect', patch: { zoom } }),
    setTracerInspectPan: (pan: { x: number; y: number }) =>
      dispatch({ type: 'output/patchInspect', patch: { pan } }),
    setTracerInspectHeatmap: (heatmap: boolean) =>
      dispatch({ type: 'output/patchInspect', patch: { heatmap } }),
    setTracerInspectExposure: (exposure: number) =>
      dispatch({ type: 'output/patchInspect', patch: { exposure } }),
    setTracerInspectTonemap: (tonemap: boolean) =>
      dispatch({ type: 'output/patchInspect', patch: { tonemap } }),
    setTracerInspectShowLayers: (showLayers: boolean) =>
      dispatch({ type: 'output/patchInspect', patch: { showLayers } }),
    resetInspectView: () => dispatch({ type: 'output/resetInspectView' }),
    setExportingTracer: (exportingTracer: boolean) =>
      dispatch({ type: 'ui/patch', patch: { exportingTracer } }),
    setExportingVideo: (exportingVideo: boolean) =>
      dispatch({ type: 'ui/patch', patch: { exportingVideo } }),
    setVideoExportProgress: (videoExportProgress: number) =>
      dispatch({ type: 'ui/patch', patch: { videoExportProgress } }),
    patchVideoExportSettings: (patch: Partial<import('../state/types').VideoExportSettings>) =>
      dispatch({ type: 'ui/patchVideoExport', patch }),
    setViewportQuarterZoom: (viewportQuarterZoom: boolean) =>
      dispatch({ type: 'output/patch', patch: { viewportQuarterZoom } }),
    setViewportHalfOverlay: (viewportHalfOverlay: boolean) =>
      dispatch({ type: 'output/patch', patch: { viewportHalfOverlay } }),
    setTracerPreviewFrozen: (tracerPreviewFrozen: boolean) =>
      dispatch({ type: 'output/patch', patch: { tracerPreviewFrozen } }),
    setLivePreviewEnabled: (livePreviewEnabled: boolean) =>
      dispatch({ type: 'output/patch', patch: { livePreviewEnabled } }),
    setIsAutoPlayActive: (isAutoPlayActive: boolean) =>
      dispatch({ type: 'ui/patch', patch: { isAutoPlayActive } }),
    setImageChangeInterval: (imageChangeInterval: number) =>
      dispatch({ type: 'ui/patch', patch: { imageChangeInterval } }),
    setIsImageStripOpen: (isImageStripOpen: boolean) =>
      dispatch({ type: 'ui/patch', patch: { isImageStripOpen } }),
    toggleImageStrip: () => dispatch({ type: 'ui/toggleImageStrip' }),
    setReferenceBlendMode: (referenceBlendMode: ReferenceBlendMode) =>
      dispatch({ type: 'ui/patch', patch: { referenceBlendMode } }),
    setOverlayImageSource: (overlayImageSource: OverlayImageSource) =>
      dispatch({ type: 'ui/patch', patch: { overlayImageSource } }),
    setReferenceOpacity: (referenceOpacity: number) =>
      dispatch({ type: 'ui/patch', patch: { referenceOpacity } }),
    setUpscaleModel: (upscaleModel: string) =>
      dispatch({ type: 'ui/patch', patch: { upscaleModel } }),
    setUpscaleBusy: (upscaleBusy: boolean) =>
      dispatch({ type: 'ui/patch', patch: { upscaleBusy } }),
    setUpscaleProgress: (upscaleProgress: number) =>
      dispatch({ type: 'ui/patch', patch: { upscaleProgress } }),
    setUpscaleInfo: (upscaleInfo: string) =>
      dispatch({ type: 'ui/patch', patch: { upscaleInfo } }),
    setEngineMode: (engineMode: EngineKind) =>
      dispatch({ type: 'engine/patch', patch: { engineMode } }),
    setWasmAvailable: (wasmAvailable: boolean) =>
      dispatch({ type: 'engine/patch', patch: { wasmAvailable } }),
    setGpuReady: (gpuReady: boolean) =>
      dispatch({ type: 'engine/patch', patch: { gpuReady } }),
    setGpuError: (gpuError: GpuRuntimeError | null) =>
      dispatch({ type: 'engine/patch', patch: { gpuError } }),
    setRendererBackend: (backend: RendererBackend) =>
      dispatch({ type: 'engine/patch', patch: { backend } }),
    setRendererFallbackReason: (fallbackReason: string | null) =>
      dispatch({ type: 'engine/patch', patch: { fallbackReason } }),
    setRenderCpuTiming: (renderCpuTiming: { last: number; avg: number }) =>
      dispatch({ type: 'ui/patch', patch: { renderCpuTiming } }),
    setRenderGpuTiming: (renderGpuTiming: import('../engine/types/RendererContracts').GpuRenderTiming) =>
      dispatch({ type: 'ui/patch', patch: { renderGpuTiming } }),
    setFrameTimeHistory: (frameTimeHistory: number[]) =>
      dispatch({ type: 'ui/patch', patch: { frameTimeHistory } }),
    setPerformanceBudgetExceeded: (performanceBudgetExceeded: boolean) =>
      dispatch({ type: 'ui/patch', patch: { performanceBudgetExceeded } }),
    setPerformanceHudEnabled: (performanceHudEnabled: boolean) =>
      dispatch({ type: 'output/patch', patch: { performanceHudEnabled } }),
    setPerformanceAutoDegrade: (performanceAutoDegrade: boolean) =>
      dispatch({ type: 'output/patch', patch: { performanceAutoDegrade } }),
    applyPerformanceDegrade: () => dispatch({ type: 'ui/applyPerformanceDegrade' }),
    setCollisionStats: (collisionStats: CollisionStats) =>
      dispatch({ type: 'ui/patch', patch: { collisionStats } }),
    setKioskUiHidden: (kioskUiHidden: boolean) =>
      dispatch({ type: 'ui/patch', patch: { kioskUiHidden } }),
    setKioskAttractMode: (kioskAttractMode: boolean) =>
      dispatch({ type: 'ui/patch', patch: { kioskAttractMode } }),
    setShortcutsOverlayVisible: (shortcutsOverlayVisible: boolean) =>
      dispatch({ type: 'ui/patch', patch: { shortcutsOverlayVisible } }),
    setCompareLayout: (layout: import('../engine/compareViews').CompareLayoutMode) =>
      dispatch({ type: 'compare/setLayout', layout }),
    setCompareSyncPlay: (syncPlay: boolean) =>
      dispatch({ type: 'compare/setSyncPlay', syncPlay }),
    setCompareSlotB: (label: string, settings: ChromashiftSettingsInput) =>
      dispatch({ type: 'compare/setSlotB', label, settings }),
    setReactiveEnabled: (enabled: boolean) =>
      dispatch({
        type: 'reactive/patch',
        patch: {
          enabled,
          ...(enabled ? {} : { audioEnabled: false, midiEnabled: false, midiLearnTarget: null }),
        },
      }),
    setReactiveAudioEnabled: (audioEnabled: boolean) =>
      dispatch({ type: 'reactive/patch', patch: { audioEnabled } }),
    setReactiveMidiEnabled: (midiEnabled: boolean) =>
      dispatch({ type: 'reactive/patch', patch: { midiEnabled } }),
    setReactiveAudioSensitivity: (audioSensitivity: number) =>
      dispatch({ type: 'reactive/patch', patch: { audioSensitivity } }),
    setMidiLearnTarget: (midiLearnTarget: import('../engine/reactive/types').MidiParamId | null) =>
      dispatch({ type: 'reactive/patch', patch: { midiLearnTarget } }),
    removeMidiBinding: (param: import('../engine/reactive/types').MidiParamId) =>
      dispatch({ type: 'reactive/removeMidiBinding', param }),
  }), []);

  const selectSourceIndex = useCallback((nextIndex: number) => {
    const list = imageListRef.current;
    const currentIndexValue = currentImageIndexRef.current;
    if (nextIndex < 0 || nextIndex >= list.length || nextIndex === currentIndexValue) return;
    const currentEntry = list[currentIndexValue];
    dispatch({
      type: 'media/selectIndex',
      index: nextIndex,
      previous: currentEntry ?? null,
    });
  }, [imageListRef, currentImageIndexRef]);

  const handleAngleChange = useCallback((layer: 0 | 1 | 2, angle: number) => {
    animAnglesRef.current[layer] = angle;
    dispatch({ type: 'layers/setTriple', field: 'angles', layer, value: angle });
  }, [animAnglesRef]);

  const handleExtensionChange = useCallback((layer: 0 | 1 | 2, extension: number) => {
    dispatch({ type: 'layers/setTriple', field: 'extensions', layer, value: extension });
  }, []);

  const ensureReferenceImage = useCallback((list: ImageEntry[], preferredCurrentIndex: number) => {
    if (list.length <= 1) return null;
    return preferredCurrentIndex === 0 ? list[1] : list[0];
  }, []);

  return { state, dispatch, actions, selectSourceIndex, handleAngleChange, handleExtensionChange, ensureReferenceImage };
}

export type ChromashiftStore = ReturnType<typeof useChromashiftStore>;
export type ChromashiftDispatch = import('react').Dispatch<ChromashiftAction>;
