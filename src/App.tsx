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
import { useCompareSlotRenderer } from './hooks/useCompareSlotRenderer';
import { useChromashiftRefs, useChromashiftStore } from './hooks/useChromashiftStore';
import { useImagePlayback } from './hooks/useImagePlayback';
import {
  useAppKeyboardShortcuts,
  useMediaHandlers,
  useTracerExport,
  useUpscalerHandlers,
} from './hooks/useMediaHandlers';
import { usePresets } from './hooks/usePresets';
import { useVideoExport } from './hooks/useVideoExport';
import { useTracerInspectInteraction } from './hooks/useTracerInspectInteraction';
import { useReactiveInput } from './hooks/useReactiveInput';
import { useKioskMode } from './hooks/useKioskMode';

export default function App() {
  const refs = useChromashiftRefs();
  const store = useChromashiftStore(refs);
  const { state, actions } = store;
  const { media, output, engine } = state;

  const { clearClassificationMask, generateClassificationMaskTexture } = useClassificationMask(refs);

  useWasmEngineLoader(actions.setWasmAvailable);
  useCanvasResize(refs, output.squareCanvas, media.aspect, state.ui.compareView.layout);
  useCollisionStatsPoll(refs, engine.gpuReady, actions.setCollisionStats);

  useAppWebGPUInit({
    previewTracerRef: refs.previewTracerRef,
    antialiasEnabled: output.antialiasEnabled,
    setGpuError: actions.setGpuError,
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

  useImagePlayback({ refs, store, clearClassificationMask, generateClassificationMaskTexture });
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

  useAppKeyboardShortcuts(refs, store, mediaHandlers.swapSourceAndReference);

  const kiosk = useKioskMode(refs, store);

  const uiProps = useAppUiProps(refs, store, {
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
  }, kiosk);

  return <AppUI {...uiProps} />;
}
