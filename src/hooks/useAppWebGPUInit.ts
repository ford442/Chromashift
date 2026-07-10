import { useEffect, useCallback, type MutableRefObject } from 'react';
import { WebGPURenderer } from '../engine/WebGPURenderer';
import { TextureManager } from '../engine/TextureManager';
import { WebGLRenderer } from '../engine/WebGLRenderer';
import { WebGLTextureManager } from '../engine/WebGLTextureManager';
import { computeAverageLuminanceWith } from '../engine/WasmEngine';
import type { ImageEntry } from '../engine/TextureManager';
import type { ChromashiftRenderer, ChromashiftTextureManager, RendererBackend } from '../engine/RendererTypes';
import { getRendererPreference, publishRendererBreadcrumbs } from '../engine/rendererMode';
import {
  bootstrapWebGpu,
  createWebGL2Context,
  toBootstrapRuntimeError,
  withErrorScope,
  type GpuRuntimeError,
  type WebGpuSession,
} from '../engine/gpuBootstrap';

export interface UseAppWebGPUInitProps {
  previewTracerRef: MutableRefObject<HTMLCanvasElement | null>;
  antialiasEnabled: boolean;
  setGpuError: (err: GpuRuntimeError | null) => void;
  deviceRef: MutableRefObject<GPUDevice | null>;
  webGpuSessionRef: MutableRefObject<WebGpuSession | null>;
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
  generateClassificationMaskTexture: (img: HTMLImageElement, avgLumValue: number) => void;
  engineModeRef: MutableRefObject<string>;
  previewOriginalRef: MutableRefObject<HTMLCanvasElement | null>;
  setGpuReady: (ready: boolean) => void;
  setSpecificImageError: (err: string | null) => void;
  ownedObjectUrlsRef: MutableRefObject<string[]>;
}

interface CancelToken {
  cancelled: boolean;
}

interface InitResources {
  localRenderer: ChromashiftRenderer | null;
  localTextureManager: ChromashiftTextureManager | null;
  localDevice: GPUDevice | null;
  localSession: WebGpuSession | null;
  backend: RendererBackend;
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

function syncLiveResources(
  liveResources: InitResources,
  resources: InitResources,
): void {
  liveResources.localRenderer = resources.localRenderer;
  liveResources.localTextureManager = resources.localTextureManager;
  liveResources.localDevice = resources.localDevice;
  liveResources.localSession = resources.localSession;
  liveResources.backend = resources.backend;
}

function destroyInitResources(resources: InitResources, canvas: HTMLCanvasElement | null): void {
  resources.localRenderer?.destroy();
  resources.localTextureManager?.destroy();
  resources.localSession?.detach();
  resources.localDevice?.destroy();

  resources.localRenderer = null;
  resources.localTextureManager = null;
  resources.localSession = null;
  resources.localDevice = null;

  if (canvas && resources.backend === 'webgpu') {
    const ctx = canvas.getContext('webgpu');
    ctx?.unconfigure();
  }
}

export function useAppWebGPUInit({
  previewTracerRef,
  antialiasEnabled,
  setGpuError,
  deviceRef,
  webGpuSessionRef,
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
  ownedObjectUrlsRef
}: UseAppWebGPUInitProps) {

  const init = useCallback(async (
    cancelToken: CancelToken,
    signal: AbortSignal,
    liveResources: InitResources,
  ): Promise<void> => {
      const canvas = previewTracerRef.current;
      if (!canvas) return;

      const resources: InitResources = {
        localRenderer: null,
        localTextureManager: null,
        localDevice: null,
        localSession: null,
        backend: getRendererPreference(),
      };
      let fallbackReason: string | null = null;

      const bailIfCancelled = (): boolean => {
        if (!isCancelled(cancelToken, signal)) return false;
        deviceRef.current = null;
        webGpuSessionRef.current = null;
        rendererRef.current = null;
        textureManagerRef.current = null;
        destroyInitResources(resources, canvas);
        syncLiveResources(liveResources, resources);
        return true;
      };

      async function createWebGPU(): Promise<{
        renderer: WebGPURenderer;
        textureManager: TextureManager;
        device: GPUDevice;
        session: WebGpuSession;
      }> {
        const session = await bootstrapWebGpu({
          canvas: canvas!,
          antialias: antialiasEnabled,
          onRuntimeError: (error) => {
            if (isCancelled(cancelToken, signal)) return;
            setGpuReady(false);
            setGpuError(error);
          },
        });

        if (bailIfCancelled()) {
          session.detach();
          session.device.destroy();
          throw new DOMException('Aborted', 'AbortError');
        }

        const renderer = await withErrorScope(
          session.device,
          'validation',
          'WebGPURenderer',
          () => new WebGPURenderer(session.device, session.context, session.format, antialiasEnabled),
        );

        return {
          renderer,
          textureManager: new TextureManager(session.device),
          device: session.device,
          session,
        };
      }

      function createWebGL(): {
        renderer: WebGLRenderer;
        textureManager: WebGLTextureManager;
      } {
        const gl = createWebGL2Context(canvas!, { antialias: antialiasEnabled });
        return {
          renderer: new WebGLRenderer(canvas!, gl),
          textureManager: new WebGLTextureManager(gl),
        };
      }

      try {
        if (!isCancelled(cancelToken, signal)) {
          setGpuError(null);
        }

        if (resources.backend === 'webgl') {
          const created = createWebGL();
          resources.localRenderer = created.renderer;
          resources.localTextureManager = created.textureManager;
        } else {
          const created = await createWebGPU();
          resources.localRenderer = created.renderer;
          resources.localTextureManager = created.textureManager;
          resources.localDevice = created.device;
          resources.localSession = created.session;
        }
      } catch (primaryError) {
        if (isAbortError(primaryError) || bailIfCancelled()) return;

        if (resources.backend === 'webgpu') {
          fallbackReason = primaryError instanceof Error ? primaryError.message : String(primaryError);
          const created = createWebGL();
          resources.backend = 'webgl';
          resources.localRenderer = created.renderer;
          resources.localTextureManager = created.textureManager;
        } else {
          throw primaryError;
        }
      }

      syncLiveResources(liveResources, resources);
      if (bailIfCancelled()) return;

      deviceRef.current = resources.localDevice;
      webGpuSessionRef.current = resources.localSession;
      rendererRef.current = resources.localRenderer;
      textureManagerRef.current = resources.localTextureManager;
      setRendererBackend(resources.backend);
      setRendererFallbackReason(fallbackReason);
      publishRendererBreadcrumbs(resources.backend, fallbackReason);

      const { localRenderer, localTextureManager } = resources;
      if (!localRenderer || !localTextureManager) return;

      try {
        const list = await localTextureManager.fetchImageList('./images.json', signal);
        if (bailIfCancelled()) return;

        const entries = [...list];
        setImageList(entries);

        const urlParams = new URLSearchParams(window.location.search);
        const imgUrl = urlParams.get('img') || urlParams.get('image') || urlParams.get('url');
        const specificUrl = imgUrl ? decodeURIComponent(imgUrl) : null;

        if (specificUrl) {
          try {
            const tex = await localTextureManager.loadTexture(specificUrl);
            if (bailIfCancelled()) return;

            localRenderer.setTexture(tex);
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
                avgLum = computeAverageLuminanceWith(img, engineModeRef.current === 'wasm');
              } catch (e) {
                console.warn('CORS?', e);
              }
              setAvgLuminance(Math.round(avgLum));
              try {
                generateClassificationMaskTexture(img, avgLum);
              } catch (e) {
                console.warn('Could not generate classification mask:', e);
                clearClassificationMask();
              }
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
              setReferenceImage(ensureReferenceImage(entries, 0));
            }
          }
        } else if (entries.length > 0) {
          const tex = await localTextureManager.loadTexture(entries[0].url);
          if (bailIfCancelled()) return;

          localRenderer.setTexture(tex);
          setReferenceImage(ensureReferenceImage(entries, 0));
        }
      } catch (e) {
        if (isAbortError(e) || isCancelled(cancelToken, signal)) return;
        console.warn('Could not load image list:', e);
      }

      if (bailIfCancelled()) return;
      setGpuReady(true);
  }, [antialiasEnabled, clearClassificationMask, ensureReferenceImage, generateClassificationMaskTexture, deviceRef, webGpuSessionRef, rendererRef, textureManagerRef, setRendererBackend, setRendererFallbackReason, setImageList, setReferenceImage, setCurrentImageIndex, setImageAspect, setAvgLuminance, engineModeRef, previewOriginalRef, setGpuReady, setSpecificImageError, setGpuError, previewTracerRef]);

  useEffect(() => {
    const canvas = previewTracerRef.current;
    const cancelToken: CancelToken = { cancelled: false };
    const abortController = new AbortController();
    const liveResources: InitResources = {
      localRenderer: null,
      localTextureManager: null,
      localDevice: null,
      localSession: null,
      backend: getRendererPreference(),
    };

    init(cancelToken, abortController.signal, liveResources).catch((e) => {
      if (isCancelled(cancelToken, abortController.signal) || isAbortError(e)) return;
      setGpuError(toBootstrapRuntimeError(e));
    });

    return () => {
      cancelToken.cancelled = true;
      abortController.abort();

      deviceRef.current = null;
      webGpuSessionRef.current = null;
      rendererRef.current = null;
      textureManagerRef.current = null;

      clearClassificationMask();
      for (const objectUrl of ownedObjectUrlsRef.current) URL.revokeObjectURL(objectUrl);
      ownedObjectUrlsRef.current = [];

      destroyInitResources(liveResources, canvas);
    };
  }, [init, clearClassificationMask, deviceRef, ownedObjectUrlsRef, previewTracerRef, rendererRef, setGpuError, textureManagerRef, webGpuSessionRef]);
}
