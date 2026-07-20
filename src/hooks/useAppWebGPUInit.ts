import { useEffect, useCallback, type MutableRefObject } from 'react';
import { computeAverageLuminanceWith } from '../engine/WasmEngine';
import type { ImageEntry } from '../engine/TextureManager';
import type { ChromashiftRenderer, ChromashiftTextureManager, RendererBackend } from '../engine/RendererTypes';
import { publishRendererBreadcrumbs } from '../engine/rendererMode';
import { toBootstrapRuntimeError, type GpuRuntimeError, type WebGpuSession } from '../engine/gpuBootstrap';
import { listLocalImages } from '../engine/LocalLibrary';
import { PRIMARY_SLOT_ID, RendererOrchestrator } from '../engine/RendererOrchestrator';

export interface UseAppWebGPUInitProps {
  previewTracerRef: MutableRefObject<HTMLCanvasElement | null>;
  antialiasEnabled: boolean;
  setGpuError: (err: GpuRuntimeError | null) => void;
  orchestratorRef: MutableRefObject<RendererOrchestrator | null>;
  deviceRef: MutableRefObject<GPUDevice | null>;
  webGpuSessionRef: MutableRefObject<WebGpuSession | null>;
  gpuImageAnalysisRef: MutableRefObject<import('../engine/compute/GpuImageAnalysis').GpuImageAnalysis | null>;
  rendererRef: MutableRefObject<ChromashiftRenderer | null>;
  textureManagerRef: MutableRefObject<ChromashiftTextureManager | null>;
  setRendererBackend: (backend: RendererBackend) => void;
  setRendererFallbackReason: (reason: string | null) => void;
  setImageList: (list: ImageEntry[]) => void;
  setReferenceImage: (img: ImageEntry | null) => void;
  ensureReferenceImage: (list: ImageEntry[], index: number) => ImageEntry | null;
  setCurrentImageIndex: (idx: number) => void;
  setImageAspect: (aspect: number) => void;
  setAvgLuminance: (lum: number) => void;
  clearClassificationMask: () => void;
  generateClassificationMaskTexture: (
    img: HTMLImageElement,
    avgLumValue: number,
    sourceTexture?: GPUTexture | null,
  ) => Promise<number>;
  engineModeRef: MutableRefObject<string>;
  previewOriginalRef: MutableRefObject<HTMLCanvasElement | null>;
  setGpuReady: (ready: boolean) => void;
  setSpecificImageError: (err: string | null) => void;
  ownedObjectUrlsRef: MutableRefObject<string[]>;
  /** Records the initial source texture so a late compare-slot renderer can attach it. */
  sourceTextureRef: MutableRefObject<GPUTexture | null>;
}

interface CancelToken {
  cancelled: boolean;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function isCancelled(cancelToken: CancelToken, signal: AbortSignal): boolean {
  return cancelToken.cancelled || signal.aborted;
}

function clearOrchestratorRefs(
  orchestratorRef: MutableRefObject<RendererOrchestrator | null>,
  deviceRef: MutableRefObject<GPUDevice | null>,
  webGpuSessionRef: MutableRefObject<WebGpuSession | null>,
  gpuImageAnalysisRef: MutableRefObject<import('../engine/compute/GpuImageAnalysis').GpuImageAnalysis | null>,
  rendererRef: MutableRefObject<ChromashiftRenderer | null>,
  textureManagerRef: MutableRefObject<ChromashiftTextureManager | null>,
  sourceTextureRef: MutableRefObject<GPUTexture | null>,
): void {
  orchestratorRef.current = null;
  deviceRef.current = null;
  webGpuSessionRef.current = null;
  gpuImageAnalysisRef.current = null;
  rendererRef.current = null;
  textureManagerRef.current = null;
  sourceTextureRef.current = null;
}

function syncOrchestratorRefs(
  orchestrator: RendererOrchestrator,
  primaryRenderer: ChromashiftRenderer,
  orchestratorRef: MutableRefObject<RendererOrchestrator | null>,
  deviceRef: MutableRefObject<GPUDevice | null>,
  webGpuSessionRef: MutableRefObject<WebGpuSession | null>,
  gpuImageAnalysisRef: MutableRefObject<import('../engine/compute/GpuImageAnalysis').GpuImageAnalysis | null>,
  rendererRef: MutableRefObject<ChromashiftRenderer | null>,
  textureManagerRef: MutableRefObject<ChromashiftTextureManager | null>,
): void {
  orchestratorRef.current = orchestrator;
  deviceRef.current = orchestrator.sharedDevice();
  webGpuSessionRef.current = orchestrator.sessionRef();
  gpuImageAnalysisRef.current = orchestrator.gpuImageAnalysisRef();
  rendererRef.current = primaryRenderer;
  textureManagerRef.current = orchestrator.textureManagerRef();
}

function bootstrappedPrimaryRenderer(orchestrator: RendererOrchestrator): ChromashiftRenderer {
  const primarySlot = orchestrator.getSlot(PRIMARY_SLOT_ID);
  if (!primarySlot) {
    throw new Error('Primary renderer slot was not created.');
  }
  return primarySlot.renderer;
}

function loadPreviewImage(url: string, signal: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    const img = new Image();
    img.crossOrigin = 'anonymous';

    const onAbort = () => {
      img.onload = null;
      img.onerror = null;
      img.src = '';
      reject(new DOMException('Aborted', 'AbortError'));
    };

    signal.addEventListener('abort', onAbort, { once: true });

    img.onload = () => {
      signal.removeEventListener('abort', onAbort);
      resolve(img);
    };
    img.onerror = () => {
      signal.removeEventListener('abort', onAbort);
      reject(new Error(`Failed to load preview image: ${url}`));
    };
    img.src = url;
  });
}

export function useAppWebGPUInit({
  previewTracerRef,
  antialiasEnabled,
  setGpuError,
  orchestratorRef,
  deviceRef,
  webGpuSessionRef,
  gpuImageAnalysisRef,
  rendererRef,
  textureManagerRef,
  setRendererBackend,
  setRendererFallbackReason,
  setImageList,
  setReferenceImage,
  ensureReferenceImage,
  setCurrentImageIndex,
  setImageAspect,
  setAvgLuminance,
  clearClassificationMask,
  generateClassificationMaskTexture,
  engineModeRef,
  previewOriginalRef,
  setGpuReady,
  setSpecificImageError,
  ownedObjectUrlsRef,
  sourceTextureRef,
}: UseAppWebGPUInitProps) {
  const init = useCallback(async (
    cancelToken: CancelToken,
    signal: AbortSignal,
    liveOrchestrator: { current: RendererOrchestrator | null },
  ): Promise<void> => {
    const canvas = previewTracerRef.current;
    if (!canvas) return;

    let orchestrator: RendererOrchestrator | null = null;
    let fallbackReason: string | null = null;
    let backend: RendererBackend = 'webgpu';

    const bailIfCancelled = (): boolean => {
      if (!isCancelled(cancelToken, signal)) return false;
      clearOrchestratorRefs(
        orchestratorRef,
        deviceRef,
        webGpuSessionRef,
        gpuImageAnalysisRef,
        rendererRef,
        textureManagerRef,
        sourceTextureRef,
      );
      orchestrator?.destroy();
      liveOrchestrator.current = null;
      return true;
    };

    try {
      if (!isCancelled(cancelToken, signal)) {
        setGpuError(null);
      }

      const bootstrapped = await RendererOrchestrator.bootstrap({
        primaryCanvas: canvas,
        antialias: antialiasEnabled,
        onRuntimeError: (error) => {
          if (isCancelled(cancelToken, signal)) return;
          clearOrchestratorRefs(
            orchestratorRef,
            deviceRef,
            webGpuSessionRef,
            gpuImageAnalysisRef,
            rendererRef,
            textureManagerRef,
            sourceTextureRef,
          );
          liveOrchestrator.current = null;
          setGpuReady(false);
          setGpuError(error);
        },
      });

      orchestrator = bootstrapped.orchestrator;
      liveOrchestrator.current = orchestrator;
      fallbackReason = bootstrapped.fallbackReason;
      backend = bootstrapped.backend;
    } catch (primaryError) {
      if (isAbortError(primaryError) || bailIfCancelled()) return;
      throw primaryError;
    }

    if (bailIfCancelled()) return;

    syncOrchestratorRefs(
      orchestrator,
      bootstrappedPrimaryRenderer(orchestrator),
      orchestratorRef,
      deviceRef,
      webGpuSessionRef,
      gpuImageAnalysisRef,
      rendererRef,
      textureManagerRef,
    );
    setRendererBackend(backend);
    setRendererFallbackReason(fallbackReason);
    publishRendererBreadcrumbs(backend, fallbackReason);

    const localRenderer = rendererRef.current;
    const localTextureManager = textureManagerRef.current;
    if (!localRenderer || !localTextureManager) return;

    try {
      const list = await localTextureManager.fetchImageList('./images.json', signal);
      if (bailIfCancelled()) return;

      const localRecords = await listLocalImages().catch(() => []);
      if (bailIfCancelled()) return;
      const localEntries: ImageEntry[] = localRecords.map((record) => {
        const url = URL.createObjectURL(record.blob);
        const thumbUrl = URL.createObjectURL(record.thumbBlob);
        ownedObjectUrlsRef.current.push(url, thumbUrl);
        return { url, thumbUrl, label: record.label, localId: record.id };
      });

      const entries = [...list, ...localEntries];
      setImageList(entries);

      const urlParams = new URLSearchParams(window.location.search);
      const imgUrl = urlParams.get('img') || urlParams.get('image') || urlParams.get('url');
      const specificUrl = imgUrl ? decodeURIComponent(imgUrl) : null;

      if (specificUrl) {
        try {
          const tex = await localTextureManager.loadTexture(specificUrl) as GPUTexture;
          if (bailIfCancelled()) return;

          localRenderer.setTexture(tex);
          sourceTextureRef.current = tex;
          const existingIndex = entries.findIndex((entry) => entry.url === specificUrl);
          if (existingIndex === -1) {
            entries.push({ url: specificUrl, label: 'Query Image' });
            setImageList([...entries]);
            setCurrentImageIndex(entries.length - 1);
            setReferenceImage(ensureReferenceImage(entries, entries.length - 1));
          } else {
            setCurrentImageIndex(existingIndex);
            setReferenceImage(ensureReferenceImage(entries, existingIndex));
          }

          try {
            const img = await loadPreviewImage(specificUrl, signal);
            if (bailIfCancelled()) return;

            if (img.height > 0) setImageAspect(img.width / img.height);
            let avgLum = 128;
            try {
              avgLum = await generateClassificationMaskTexture(img, 128, tex);
            } catch (e) {
              console.warn('Could not generate classification mask:', e);
              clearClassificationMask();
              try {
                avgLum = computeAverageLuminanceWith(img, engineModeRef.current === 'wasm');
              } catch (lumError) {
                console.warn('CORS?', lumError);
              }
            }
            setAvgLuminance(Math.round(avgLum));
            const previewOrig = previewOriginalRef.current;
            if (previewOrig) {
              const ctx = previewOrig.getContext('2d');
              if (ctx) ctx.drawImage(img, 0, 0, previewOrig.width, previewOrig.height);
            }
          } catch (previewError) {
            if (!isAbortError(previewError) && !isCancelled(cancelToken, signal)) {
              console.warn('Failed to load preview image:', specificUrl, previewError);
            }
          }
        } catch (e) {
          if (isAbortError(e) || bailIfCancelled()) return;

          console.warn('Failed to load specific image from URL:', e);
          setSpecificImageError(`Failed to load image: ${specificUrl}`);
          if (entries.length > 0) {
            const tex = await localTextureManager.loadTexture(entries[0].url);
            if (bailIfCancelled()) return;

            localRenderer.setTexture(tex);
            sourceTextureRef.current = tex as GPUTexture;
            setReferenceImage(ensureReferenceImage(entries, 0));
          }
        }
      } else if (entries.length > 0) {
        const tex = await localTextureManager.loadTexture(entries[0].url);
        if (bailIfCancelled()) return;

        localRenderer.setTexture(tex);
        sourceTextureRef.current = tex as GPUTexture;
        setReferenceImage(ensureReferenceImage(entries, 0));
      }
    } catch (e) {
      if (isAbortError(e) || isCancelled(cancelToken, signal)) return;
      console.warn('Could not load image list:', e);
    }

    if (bailIfCancelled()) return;
    setGpuReady(true);
  }, [
    antialiasEnabled,
    clearClassificationMask,
    ensureReferenceImage,
    generateClassificationMaskTexture,
    orchestratorRef,
    deviceRef,
    webGpuSessionRef,
    gpuImageAnalysisRef,
    rendererRef,
    textureManagerRef,
    setRendererBackend,
    setRendererFallbackReason,
    setImageList,
    setReferenceImage,
    setCurrentImageIndex,
    setImageAspect,
    setAvgLuminance,
    engineModeRef,
    previewOriginalRef,
    setGpuReady,
    setSpecificImageError,
    setGpuError,
    previewTracerRef,
    ownedObjectUrlsRef,
    sourceTextureRef,
  ]);

  useEffect(() => {
    const cancelToken: CancelToken = { cancelled: false };
    const abortController = new AbortController();
    const liveOrchestrator: { current: RendererOrchestrator | null } = { current: null };

    setGpuReady(false);

    init(cancelToken, abortController.signal, liveOrchestrator).catch((e) => {
      if (isCancelled(cancelToken, abortController.signal) || isAbortError(e)) return;
      setGpuError(toBootstrapRuntimeError(e));
    });

    return () => {
      cancelToken.cancelled = true;
      abortController.abort();
      setGpuReady(false);

      clearOrchestratorRefs(
        orchestratorRef,
        deviceRef,
        webGpuSessionRef,
        gpuImageAnalysisRef,
        rendererRef,
        textureManagerRef,
        sourceTextureRef,
      );

      liveOrchestrator.current?.destroy();
      liveOrchestrator.current = null;
    };
  }, [init, clearClassificationMask, orchestratorRef, deviceRef, gpuImageAnalysisRef, ownedObjectUrlsRef, rendererRef, setGpuError, setGpuReady, textureManagerRef, webGpuSessionRef, sourceTextureRef]);
}
