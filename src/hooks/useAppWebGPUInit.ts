import { useEffect, useCallback, useRef, type MutableRefObject } from 'react';
import type { ImageEntry } from '../engine/TextureManager';
import type { ChromashiftRenderer, ChromashiftTextureManager } from '../engine/RendererTypes';
import { publishRendererBreadcrumbs } from '../engine/rendererMode';
import {
  toBootstrapRuntimeError,
  type GpuRuntimeError,
  type WebGpuSession,
} from '../engine/gpuBootstrap';
import { computeAverageLuminanceWith } from '../engine/WasmEngine';
import { listLocalImages } from '../engine/LocalLibrary';
import {
  PRIMARY_SLOT_ID,
  RendererOrchestrator,
} from '../engine/RendererOrchestrator';

export interface UseAppWebGPUInitProps {
  previewTracerRef: MutableRefObject<HTMLCanvasElement | null>;
  antialiasEnabled: boolean;
  setGpuError: (err: GpuRuntimeError | null) => void;
  deviceRef: MutableRefObject<GPUDevice | null>;
  webGpuSessionRef: MutableRefObject<WebGpuSession | null>;
  orchestratorRef: MutableRefObject<RendererOrchestrator | null>;
  gpuImageAnalysisRef: MutableRefObject<import('../engine/compute/GpuImageAnalysis').GpuImageAnalysis | null>;
  rendererRef: MutableRefObject<ChromashiftRenderer | null>;
  textureManagerRef: MutableRefObject<ChromashiftTextureManager | null>;
  setRendererBackend: (backend: import('../engine/RendererTypes').RendererBackend) => void;
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

function syncOrchestratorRefs(
  orchestrator: RendererOrchestrator | null,
  refs: {
    deviceRef: MutableRefObject<GPUDevice | null>;
    webGpuSessionRef: MutableRefObject<WebGpuSession | null>;
    orchestratorRef: MutableRefObject<RendererOrchestrator | null>;
    gpuImageAnalysisRef: MutableRefObject<import('../engine/compute/GpuImageAnalysis').GpuImageAnalysis | null>;
    rendererRef: MutableRefObject<ChromashiftRenderer | null>;
    textureManagerRef: MutableRefObject<ChromashiftTextureManager | null>;
    cleanupOrchestratorRef: MutableRefObject<RendererOrchestrator | null>;
  },
): void {
  refs.orchestratorRef.current = orchestrator;
  refs.cleanupOrchestratorRef.current = orchestrator;
  refs.deviceRef.current = orchestrator?.sharedDevice() ?? null;
  refs.webGpuSessionRef.current = orchestrator?.sharedSession() ?? null;
  refs.gpuImageAnalysisRef.current = orchestrator?.sharedGpuAnalysis() ?? null;
  refs.rendererRef.current = orchestrator?.getSlot(PRIMARY_SLOT_ID)?.renderer ?? null;
  refs.textureManagerRef.current = orchestrator?.sharedTextureManager() ?? null;
}

function clearOrchestratorRefs(
  refs: Pick<
    UseAppWebGPUInitProps,
  'deviceRef' | 'webGpuSessionRef' | 'orchestratorRef' | 'gpuImageAnalysisRef' | 'rendererRef' | 'textureManagerRef'
  > & {
    cleanupOrchestratorRef: MutableRefObject<RendererOrchestrator | null>;
  },
): void {
  refs.orchestratorRef.current = null;
  refs.cleanupOrchestratorRef.current = null;
  refs.deviceRef.current = null;
  refs.webGpuSessionRef.current = null;
  refs.gpuImageAnalysisRef.current = null;
  refs.rendererRef.current = null;
  refs.textureManagerRef.current = null;
}

export function useAppWebGPUInit({
  previewTracerRef,
  antialiasEnabled,
  setGpuError,
  deviceRef,
  webGpuSessionRef,
  orchestratorRef,
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
  const cleanupOrchestratorRef = useRef<RendererOrchestrator | null>(null);

  const init = useCallback(async (
    cancelToken: CancelToken,
    signal: AbortSignal,
  ): Promise<void> => {
    const canvas = previewTracerRef.current;
    if (!canvas) return;

    const refBundle = {
      deviceRef,
      webGpuSessionRef,
      orchestratorRef,
      gpuImageAnalysisRef,
      rendererRef,
      textureManagerRef,
      cleanupOrchestratorRef,
    };

    let orchestrator: RendererOrchestrator | null = null;

    const bailIfCancelled = (): boolean => {
      if (!isCancelled(cancelToken, signal)) return false;
      clearOrchestratorRefs(refBundle);
      orchestrator?.destroy();
      return true;
    };

    try {
      if (!isCancelled(cancelToken, signal)) {
        setGpuError(null);
      }

      const result = await RendererOrchestrator.bootstrap(canvas, {
        antialias: antialiasEnabled,
        onRuntimeError: (error) => {
          if (isCancelled(cancelToken, signal)) return;
          setGpuReady(false);
          setGpuError(error);
        },
      });

      if (bailIfCancelled()) return;

      orchestrator = result.orchestrator;
      syncOrchestratorRefs(orchestrator, refBundle);
      setRendererBackend(result.backend);
      setRendererFallbackReason(result.fallbackReason);
      publishRendererBreadcrumbs(result.backend, result.fallbackReason);

      const localRenderer = orchestrator.getSlot(PRIMARY_SLOT_ID)?.renderer;
      const localTextureManager = orchestrator.sharedTextureManager();
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
    } catch (error) {
      if (isAbortError(error) || isCancelled(cancelToken, signal)) {
        orchestrator?.destroy();
        clearOrchestratorRefs(refBundle);
        return;
      }
      orchestrator?.destroy();
      clearOrchestratorRefs(refBundle);
      throw error;
    }
  }, [
    antialiasEnabled,
    clearClassificationMask,
    ensureReferenceImage,
    generateClassificationMaskTexture,
    deviceRef,
    webGpuSessionRef,
    orchestratorRef,
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

    init(cancelToken, abortController.signal).catch((e) => {
      if (isCancelled(cancelToken, abortController.signal) || isAbortError(e)) return;
      setGpuError(toBootstrapRuntimeError(e));
    });

    return () => {
      cancelToken.cancelled = true;
      abortController.abort();

      // Orchestrator is assigned asynchronously during init; cleanup ref tracks the live instance.
      // eslint-disable-next-line react-hooks/exhaustive-deps -- async GPU bootstrap
      const orchestratorToDestroy = cleanupOrchestratorRef.current;
      clearOrchestratorRefs({
        deviceRef,
        webGpuSessionRef,
        orchestratorRef,
        gpuImageAnalysisRef,
        rendererRef,
        textureManagerRef,
        cleanupOrchestratorRef,
      });
      sourceTextureRef.current = null;

      clearClassificationMask();
      for (const objectUrl of ownedObjectUrlsRef.current) URL.revokeObjectURL(objectUrl);
      ownedObjectUrlsRef.current = [];

      orchestratorToDestroy?.destroy();
    };
  }, [
    init,
    clearClassificationMask,
    deviceRef,
    gpuImageAnalysisRef,
    ownedObjectUrlsRef,
    orchestratorRef,
    rendererRef,
    setGpuError,
    textureManagerRef,
    webGpuSessionRef,
    sourceTextureRef,
  ]);
}
