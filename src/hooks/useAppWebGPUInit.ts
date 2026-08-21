import { useEffect, useCallback, useRef, useState, type MutableRefObject } from 'react';
import { computeAverageLuminanceWith } from '../engine/WasmEngine';
import type { ImageEntry } from '../engine/TextureManager';
import type { ChromashiftRenderer, ChromashiftTextureManager, RendererBackend } from '../engine/RendererTypes';
import type { ChromashiftTextureHandle } from '../engine/types/TextureHandle';
import { getRendererPreference, publishRendererBootFailure, publishRendererBreadcrumbs } from '../engine/rendererMode';
import {
  probeFailureMessage,
  probeWebGPU,
  publishWebGpuProbe,
  recordProbeStageFailure,
  recordProbeSuccess,
} from '../engine/webgpuProbe';
import { toBootstrapRuntimeError, type GpuRuntimeError, type WebGpuSession } from '../engine/gpuBootstrap';
import { listLocalImages } from '../engine/LocalLibrary';
import { PRIMARY_SLOT_ID, RendererOrchestrator } from '../engine/RendererOrchestrator';

export interface UseAppWebGPUInitProps {
  mainCanvasRef: MutableRefObject<HTMLCanvasElement | null>;
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
    sourceTexture?: ChromashiftTextureHandle | null,
  ) => Promise<number>;
  engineModeRef: MutableRefObject<string>;
  previewOriginalRef: MutableRefObject<HTMLCanvasElement | null>;
  setGpuReady: (ready: boolean) => void;
  setSpecificImageError: (err: string | null) => void;
  ownedObjectUrlsRef: MutableRefObject<string[]>;
  /** Records the initial source texture so a late compare-slot renderer can attach it. */
  sourceTextureRef: MutableRefObject<ChromashiftTextureHandle | null>;
}

export interface UseAppWebGPUInitResult {
  retryGpuBootstrap: () => Promise<void>;
  isGpuRetrying: boolean;
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
  sourceTextureRef: MutableRefObject<ChromashiftTextureHandle | null>,
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
  mainCanvasRef,
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
}: UseAppWebGPUInitProps): UseAppWebGPUInitResult {
  const activeOrchestratorRef = useRef<RendererOrchestrator | null>(null);
  const retryAbortRef = useRef<AbortController | null>(null);
  const [isGpuRetrying, setIsGpuRetrying] = useState(false);

  const destroyActiveOrchestrator = useCallback(() => {
    activeOrchestratorRef.current?.destroy();
    activeOrchestratorRef.current = null;
  }, []);

  /** Returns true when a renderer is live; false on a hard-failed boot. */
  const bootstrapGpu = useCallback(async (
    cancelToken: CancelToken,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const canvas = mainCanvasRef.current;
    if (!canvas) return false;

    const preferredBackend = getRendererPreference();
    const onRuntimeError = (error: GpuRuntimeError) => {
      if (isCancelled(cancelToken, signal)) return;
      if (error.kind !== 'device-lost') return;
      clearOrchestratorRefs(
        orchestratorRef,
        deviceRef,
        webGpuSessionRef,
        gpuImageAnalysisRef,
        rendererRef,
        textureManagerRef,
        sourceTextureRef,
      );
      activeOrchestratorRef.current = null;
      setGpuReady(false);
      setGpuError(error);
    };

    let orchestrator: RendererOrchestrator | null = null;

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
      activeOrchestratorRef.current = null;
      return true;
    };

    const finishBoot = (bootstrapped: { orchestrator: RendererOrchestrator }): boolean => {
      if (bailIfCancelled()) return false;
      syncOrchestratorRefs(
        bootstrapped.orchestrator,
        bootstrappedPrimaryRenderer(bootstrapped.orchestrator),
        orchestratorRef,
        deviceRef,
        webGpuSessionRef,
        gpuImageAnalysisRef,
        rendererRef,
        textureManagerRef,
      );
      setRendererBackend(bootstrapped.orchestrator.getBackend());
      const fallbackReason = bootstrapped.orchestrator.getFallbackReason();
      setRendererFallbackReason(fallbackReason);
      publishRendererBreadcrumbs(bootstrapped.orchestrator.getBackend(), fallbackReason);
      return true;
    };

    // Explicit diagnostic / XR / screenshot session: never request a WebGPU
    // adapter or device, so gpu-chores cannot adopt a leftover GPUDevice.
    if (preferredBackend === 'webgl') {
      try {
        if (!isCancelled(cancelToken, signal)) {
          setGpuError(null);
        }
        const bootstrapped = await RendererOrchestrator.bootstrap({
          primaryCanvas: canvas,
          antialias: antialiasEnabled,
          backend: 'webgl',
          onRuntimeError,
        });
        orchestrator = bootstrapped.orchestrator;
        activeOrchestratorRef.current = orchestrator;
        return finishBoot(bootstrapped);
      } catch (webglError) {
        if (isAbortError(webglError) || bailIfCancelled()) return false;
        const detail = webglError instanceof Error ? webglError.message : String(webglError);
        publishRendererBootFailure(detail);
        throw webglError;
      }
    }

    // Default path: WebGPU is required. Pre-flight before touching the
    // orchestrator so an unsupported browser produces a blocking screen with
    // adapter/browser detail rather than a silent WebGL slide.
    const probe = await probeWebGPU();
    publishWebGpuProbe(probe);
    if (isCancelled(cancelToken, signal)) return false;

    if (!probe.ok) {
      const { message, detail } = probeFailureMessage(probe);
      console.error(`[Chromashift:GPU] ${message} ${detail}`, probe);
      publishRendererBootFailure(detail);
      // Not recoverable by retry: the browser/device cannot run this app.
      // The overlay may offer a *new* WebGL diagnostic navigation.
      setGpuError({ kind: 'bootstrap', message, detail, recoverable: false });
      return false;
    }

    try {
      if (!isCancelled(cancelToken, signal)) {
        setGpuError(null);
      }

      const bootstrapped = await RendererOrchestrator.bootstrap({
        primaryCanvas: canvas,
        antialias: antialiasEnabled,
        backend: 'webgpu',
        onRuntimeError,
      });

      orchestrator = bootstrapped.orchestrator;
      activeOrchestratorRef.current = orchestrator;
      const ok = finishBoot(bootstrapped);
      if (ok) {
        recordProbeSuccess(probe);
      }
      return ok;
    } catch (primaryError) {
      if (isAbortError(primaryError) || bailIfCancelled()) return false;
      // The adapter was fine but device/context/pipeline creation failed —
      // exactly the Chrome-vs-Edge case. Record which stage died, then
      // hard-fail. No WebGL renderer is started in this session.
      const reason = primaryError instanceof Error
        ? primaryError.message
        : String(primaryError);
      const failed = recordProbeStageFailure(probe, 'device', reason);
      const { message, detail } = probeFailureMessage(failed);
      console.error(`[Chromashift:GPU] ${message} ${detail}`, failed);
      publishRendererBootFailure(detail);
      throw primaryError;
    }
  }, [
    antialiasEnabled,
    orchestratorRef,
    deviceRef,
    webGpuSessionRef,
    gpuImageAnalysisRef,
    rendererRef,
    textureManagerRef,
    setRendererBackend,
    setRendererFallbackReason,
    setGpuReady,
    setGpuError,
    mainCanvasRef,
    sourceTextureRef,
  ]);

  const loadInitialCorpus = useCallback(async (
    cancelToken: CancelToken,
    signal: AbortSignal,
  ): Promise<void> => {
    const localRenderer = rendererRef.current;
    const localTextureManager = textureManagerRef.current;
    if (!localRenderer || !localTextureManager) return;

    const bailIfCancelled = (): boolean => isCancelled(cancelToken, signal);

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
          const tex = await localTextureManager.loadTexture(specificUrl);
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
            sourceTextureRef.current = tex;
            setReferenceImage(ensureReferenceImage(entries, 0));
          }
        }
      } else if (entries.length > 0) {
        const tex = await localTextureManager.loadTexture(entries[0].url);
        if (bailIfCancelled()) return;

        localRenderer.setTexture(tex);
        sourceTextureRef.current = tex;
        setReferenceImage(ensureReferenceImage(entries, 0));
      }
    } catch (e) {
      if (isAbortError(e) || isCancelled(cancelToken, signal)) return;
      console.warn('Could not load image list:', e);
    }
  }, [
    clearClassificationMask,
    ensureReferenceImage,
    generateClassificationMaskTexture,
    rendererRef,
    textureManagerRef,
    setImageList,
    setReferenceImage,
    setCurrentImageIndex,
    setImageAspect,
    setAvgLuminance,
    engineModeRef,
    previewOriginalRef,
    setSpecificImageError,
    ownedObjectUrlsRef,
    sourceTextureRef,
  ]);

  const init = useCallback(async (
    cancelToken: CancelToken,
    signal: AbortSignal,
  ): Promise<void> => {
    // A hard-failed WebGPU boot must not report gpuReady: there is no renderer,
    // and WebGL is never started in-place.
    const booted = await bootstrapGpu(cancelToken, signal);
    if (!booted || isCancelled(cancelToken, signal)) return;
    await loadInitialCorpus(cancelToken, signal);
    if (isCancelled(cancelToken, signal)) return;
    setGpuReady(true);
  }, [bootstrapGpu, loadInitialCorpus, setGpuReady]);

  const retryGpuBootstrap = useCallback(async (): Promise<void> => {
    retryAbortRef.current?.abort();
    const abortController = new AbortController();
    retryAbortRef.current = abortController;
    const cancelToken: CancelToken = { cancelled: false };

    destroyActiveOrchestrator();
    clearOrchestratorRefs(
      orchestratorRef,
      deviceRef,
      webGpuSessionRef,
      gpuImageAnalysisRef,
      rendererRef,
      textureManagerRef,
      sourceTextureRef,
    );
    setGpuReady(false);
    setGpuError(null);
    setIsGpuRetrying(true);

    try {
      const booted = await bootstrapGpu(cancelToken, abortController.signal);
      if (!booted || isCancelled(cancelToken, abortController.signal)) return;
      setGpuReady(true);
    } catch (e) {
      if (isCancelled(cancelToken, abortController.signal) || isAbortError(e)) return;
      setGpuError(toBootstrapRuntimeError(e));
    } finally {
      setIsGpuRetrying(false);
    }
  }, [
    bootstrapGpu,
    destroyActiveOrchestrator,
    orchestratorRef,
    deviceRef,
    webGpuSessionRef,
    gpuImageAnalysisRef,
    rendererRef,
    textureManagerRef,
    sourceTextureRef,
    setGpuReady,
    setGpuError,
  ]);

  useEffect(() => {
    const cancelToken: CancelToken = { cancelled: false };
    const abortController = new AbortController();

    setGpuReady(false);

    init(cancelToken, abortController.signal).catch((e) => {
      if (isCancelled(cancelToken, abortController.signal) || isAbortError(e)) return;
      setGpuError(toBootstrapRuntimeError(e));
    });

    return () => {
      cancelToken.cancelled = true;
      abortController.abort();
      retryAbortRef.current?.abort();
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

      destroyActiveOrchestrator();
    };
  }, [
    init,
    destroyActiveOrchestrator,
    orchestratorRef,
    deviceRef,
    gpuImageAnalysisRef,
    rendererRef,
    setGpuError,
    setGpuReady,
    textureManagerRef,
    webGpuSessionRef,
    sourceTextureRef,
  ]);

  return { retryGpuBootstrap, isGpuRetrying };
}
