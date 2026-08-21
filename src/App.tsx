/**
 * Chromashift – WebGPU-based visual engine
 *
 * Replaces the legacy Canvas 2D slideshow with a 3-layer WebGPU pipeline.
 * All colour separation and rotation happen entirely in the GPU shaders.
 */

import { AppUI } from './components/AppUI';
import { useAppWebGPUInit } from './hooks/useAppWebGPUInit';
import { useAnimationLoop } from './hooks/useAnimationLoop';
import { useAppUiProps } from './hooks/useAppUiProps';
import { useCanvasResize, useCollisionStatsPoll, useWasmEngineLoader } from './hooks/useAppLifecycle';
import { useClassificationMask } from './hooks/useClassificationMask';
import { useCompareQuadSlots } from './hooks/useCompareQuadSlots';
import { useCompareSlotRenderer } from './hooks/useCompareSlotRenderer';
import { useQuadStationaryRefresh } from './hooks/useQuadStationaryRefresh';
import { useCompareSwipeInteraction } from './hooks/useCompareSwipeInteraction';
import { useChromashiftRefs, useChromashiftStore } from './hooks/useChromashiftStore';
import { useImagePlayback } from './hooks/useImagePlayback';
import { useLiveSource } from './hooks/useLiveSource';
import {
  useAppKeyboardShortcuts,
  useMediaHandlers,
  useTracerExport,
  useUpscalerHandlers,
} from './hooks/useMediaHandlers';
import { usePresets } from './hooks/usePresets';
import { useColorProfiles } from './hooks/useColorProfiles';
import { useVideoExport } from './hooks/useVideoExport';
import { useStationaryPreviews } from './hooks/useStationaryPreviews';
import { useTracerInspectInteraction } from './hooks/useTracerInspectInteraction';
import { useReactiveInput } from './hooks/useReactiveInput';
import { useKioskMode } from './hooks/useKioskMode';
import { useWebXr } from './hooks/useWebXr';

export default function App() {
  const refs = useChromashiftRefs();
  const store = useChromashiftStore(refs);
  const { state, actions } = store;
  const { media, output, engine } = state;

  const { clearClassificationMask, generateClassificationMaskTexture } = useClassificationMask(refs);

  useWasmEngineLoader(actions.setWasmAvailable);
  useCanvasResize(refs, output.squareCanvas, media.aspect, state.ui.compareView.layout);
  useCollisionStatsPoll(refs, engine.gpuReady, actions.setCollisionStats);

  const { retryGpuBootstrap, isGpuRetrying } = useAppWebGPUInit({
    mainCanvasRef: refs.mainCanvasRef,
    antialiasEnabled: output.antialiasEnabled,
    displayColorSpace: output.displayColorSpace,
    setGpuError: actions.setGpuError,
    orchestratorRef: refs.orchestratorRef,
    deviceRef: refs.deviceRef,
    webGpuSessionRef: refs.webGpuSessionRef,
    gpuImageAnalysisRef: refs.gpuImageAnalysisRef,
    rendererRef: refs.rendererRef,
    textureManagerRef: refs.textureManagerRef,
    setRendererBackend: actions.setRendererBackend,
    setRendererFallbackReason: actions.setRendererFallbackReason,
    setImageList: actions.setImageList,
    setReferenceImage: actions.setReferenceImage,
    ensureReferenceImage: store.ensureReferenceImage,
    setCurrentImageIndex: actions.setCurrentImageIndex,
    setImageAspect: actions.setImageAspect,
    setAvgLuminance: actions.setAvgLuminance,
    clearClassificationMask,
    generateClassificationMaskTexture,
    engineModeRef: refs.engineModeRef,
    previewOriginalRef: refs.previewOriginalRef,
    setGpuReady: actions.setGpuReady,
    setSpecificImageError: actions.setSpecificImageError,
    ownedObjectUrlsRef: refs.ownedObjectUrlsRef,
    sourceTextureRef: refs.sourceTextureRef,
  });

  // After useAppWebGPUInit so slot B cleanup runs before the shared device is destroyed.
  useCompareSlotRenderer(refs, store);
  useCompareQuadSlots(refs, store);
  useCompareSwipeInteraction(refs, store);

  useImagePlayback({ refs, store, clearClassificationMask, generateClassificationMaskTexture });
  const liveSource = useLiveSource(refs, store);
  useStationaryPreviews(refs, store);
  useQuadStationaryRefresh(refs, store);
  useAnimationLoop(refs, store);
  useReactiveInput(refs, store);
  useTracerInspectInteraction(refs, store);

  const mediaHandlers = useMediaHandlers({
    refs,
    store,
    clearClassificationMask,
    generateClassificationMaskTexture,
  });
  const { handleUpscaleSource, handleUpscaleOutput } = useUpscalerHandlers(
    refs,
    store,
    clearClassificationMask,
  );
  const { handleExportTracer } = useTracerExport(refs, store);
  const videoExport = useVideoExport(refs, store);
  const presets = usePresets(store);
  const colorProfiles = useColorProfiles(store);

  useAppKeyboardShortcuts(refs, store, mediaHandlers.swapSourceAndReference);

  const kiosk = useKioskMode(refs, store);
  const webxr = useWebXr(refs, store);

  const uiProps = useAppUiProps(refs, store, {
    retryGpuBootstrap,
    isGpuRetrying,
    selectSourceIndex: store.selectSourceIndex,
    handleAngleChange: store.handleAngleChange,
    handleExtensionChange: store.handleExtensionChange,
    handleReset: mediaHandlers.handleReset,
    handleLoadSpecificImage: mediaHandlers.handleLoadSpecificImage,
    handleLoadFile: mediaHandlers.handleLoadFile,
    handleLoadReferenceImage: mediaHandlers.handleLoadReferenceImage,
    handleLoadReferenceFile: mediaHandlers.handleLoadReferenceFile,
    handleDropFiles: mediaHandlers.handleDropFiles,
    handleClearLocalLibrary: mediaHandlers.handleClearLocalLibrary,
    swapSourceAndReference: mediaHandlers.swapSourceAndReference,
    handleFreezeInspect: mediaHandlers.handleFreezeInspect,
    handleUpscaleSource,
    handleUpscaleOutput,
    handleExportTracer,
    ...videoExport,
    ...presets,
    ...colorProfiles,
    ...liveSource,
  }, kiosk, webxr);

  return <AppUI {...uiProps} />;
}
