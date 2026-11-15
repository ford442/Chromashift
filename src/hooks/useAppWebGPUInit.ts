import { useEffect, useCallback, useRef, useState, type RefObject } from 'react';
import type { ImageEntry } from '../engine/library/imageEntry';
import type { RendererBackend } from '../engine/types/RendererContracts';
import { getRendererPreference } from '../engine/rendererMode';
import { getGpuFatalError, toBootstrapRuntimeError, type GpuRuntimeError } from '../engine/gpu/gpuErrors';
import { listLocalImages } from '../engine/library/LocalLibrary';
import { createIndexedDbManifestStore, fetchCorpusManifest } from '../engine/library/corpusManifest';
import { passGraphSelection } from '../engine/graph';
import type { RenderHost } from '../engine/render/RenderHost';

export interface UseAppWebGPUInitProps {
  mainCanvasRef: RefObject<HTMLCanvasElement | null>;
  renderHostRef: RefObject<RenderHost>;
  antialiasEnabled: boolean;
  displayColorSpace: import('../engine/gpu/gpuOptions').DisplayColorSpace;
  canvasHdr: boolean;
  setGpuError: (err: GpuRuntimeError | null) => void;
  setRendererBackend: (backend: RendererBackend) => void;
  setRendererFallbackReason: (reason: string | null) => void;
  setImageList: (list: ImageEntry[]) => void;
  setReferenceImage: (img: ImageEntry | null) => void;
  ensureReferenceImage: (list: ImageEntry[], index: number) => ImageEntry | null;
  setCurrentImageIndex: (idx: number) => void;
  setGpuReady: (ready: boolean) => void;
  setSpecificImageError: (err: string | null) => void;
  ownedObjectUrlsRef: RefObject<string[]>;
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

/**
 * Page-lifetime GPU boot (#157 / #158), through the render host (#253). The
 * probe, the device and the renderer live wherever the host's transport put
 * them — the render worker, or this thread. This hook decides *when* to boot
 * and what the overlay says; the host and the service do the rest.
 */
export function useAppWebGPUInit({
  mainCanvasRef,
  renderHostRef,
  antialiasEnabled,
  displayColorSpace,
  canvasHdr,
  setGpuError,
  setRendererBackend,
  setRendererFallbackReason,
  setImageList,
  setReferenceImage,
  ensureReferenceImage,
  setCurrentImageIndex,
  setGpuReady,
  setSpecificImageError,
  ownedObjectUrlsRef,
}: UseAppWebGPUInitProps): UseAppWebGPUInitResult {
  const retryAbortRef = useRef<AbortController | null>(null);
  const antialiasEnabledRef = useRef(antialiasEnabled);
  const displayColorSpaceRef = useRef(displayColorSpace);
  antialiasEnabledRef.current = antialiasEnabled;
  displayColorSpaceRef.current = displayColorSpace;
  const canvasHdrRef = useRef(canvasHdr);
  canvasHdrRef.current = canvasHdr;
  const [isGpuRetrying, setIsGpuRetrying] = useState(false);
  /** `retryGpuBootstrap`, for the WebGL restore path that runs before it is defined. */
  const retryGpuBootstrapRef = useRef<(() => Promise<void>) | null>(null);

  /** Returns true when a renderer is live; false on a hard-failed or overtaken boot. */
  const bootstrapGpu = useCallback(async (
    cancelToken: CancelToken,
    signal: AbortSignal,
    retry: boolean,
  ): Promise<boolean> => {
    const fatal = getGpuFatalError();
    if (fatal) {
      if (!isCancelled(cancelToken, signal)) setGpuError(fatal);
      return false;
    }

    const canvas = mainCanvasRef.current;
    if (!canvas) return false;
    if (!isCancelled(cancelToken, signal)) setGpuError(null);

    const result = await renderHostRef.current.boot(canvas, {
      backend: getRendererPreference(),
      antialias: antialiasEnabledRef.current,
      // Applied at boot: the standing effects below re-run only on a change,
      // so a preset URL that selects display-p3 or Canvas HDR before boot
      // would otherwise never reach the canvas.
      colorSpace: displayColorSpaceRef.current,
      canvasHdr: canvasHdrRef.current,
      // The gate reads the page's URL and storage; the renderer may have neither.
      passGraph: passGraphSelection().name,
      // Retry GPU: the service releases the page's device and adapter first.
      retry,
    });
    if (isCancelled(cancelToken, signal)) return false;
    if (!result.ok) {
      if ('error' in result) setGpuError(result.error);
      return false;
    }
    setRendererBackend(result.backend);
    setRendererFallbackReason(result.fallbackReason);
    return true;
  }, [mainCanvasRef, renderHostRef, setGpuError, setRendererBackend, setRendererFallbackReason]);

  /**
   * The manifest, the local library, and the first source — uploaded before
   * `gpuReady`, so the first frame has it. Its thumbnail, mask and luminance
   * follow from `useImagePlayback` once the GPU is ready.
   */
  const loadInitialCorpus = useCallback(async (
    cancelToken: CancelToken,
    signal: AbortSignal,
  ): Promise<void> => {
    const host = renderHostRef.current;
    const bailIfCancelled = (): boolean => isCancelled(cancelToken, signal);
    const upload = async (url: string): Promise<boolean> => {
      try {
        await host.loadSource({ url, keep: [url] });
        return true;
      } catch (error) {
        if (!bailIfCancelled()) console.warn('Failed to load source image:', url, error);
        return false;
      }
    };

    try {
      // Revalidated against an IndexedDB copy, so a repeat visit answers 304
      // instead of re-downloading and re-parsing ~360 kB before the first frame.
      const { entries: list } = await fetchCorpusManifest('./images.json', {
        signal,
        store: createIndexedDbManifestStore(),
      });
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
        const loaded = await upload(specificUrl);
        if (bailIfCancelled()) return;
        if (loaded) {
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
          return;
        }
        setSpecificImageError(`Failed to load image: ${specificUrl}`);
      }
      if (entries.length > 0) {
        await upload(entries[0]!.url);
        if (bailIfCancelled()) return;
        setReferenceImage(ensureReferenceImage(entries, 0));
      }
    } catch (e) {
      if (isAbortError(e) || isCancelled(cancelToken, signal)) return;
      console.warn('Could not load image list:', e);
    }
  }, [
    renderHostRef,
    ensureReferenceImage,
    setImageList,
    setReferenceImage,
    setCurrentImageIndex,
    setSpecificImageError,
    ownedObjectUrlsRef,
  ]);

  const init = useCallback(async (
    cancelToken: CancelToken,
    signal: AbortSignal,
  ): Promise<void> => {
    // A hard-failed WebGPU boot must not report gpuReady: there is no renderer,
    // and WebGL is never started in-place.
    const booted = await bootstrapGpu(cancelToken, signal, false);
    if (!booted || isCancelled(cancelToken, signal)) return;
    await loadInitialCorpus(cancelToken, signal);
    if (isCancelled(cancelToken, signal)) return;
    setGpuReady(true);
  }, [bootstrapGpu, loadInitialCorpus, setGpuReady]);

  const retryGpuBootstrap = useCallback(async (): Promise<void> => {
    const fatal = getGpuFatalError();
    if (fatal) {
      setGpuError(fatal);
      return;
    }

    retryAbortRef.current?.abort();
    const abortController = new AbortController();
    retryAbortRef.current = abortController;
    const cancelToken: CancelToken = { cancelled: false };

    setGpuReady(false);
    setGpuError(null);
    setIsGpuRetrying(true);

    try {
      const booted = await bootstrapGpu(cancelToken, abortController.signal, true);
      if (!booted || isCancelled(cancelToken, abortController.signal)) return;
      setGpuReady(true);
    } catch (e) {
      if (isCancelled(cancelToken, abortController.signal) || isAbortError(e)) return;
      setGpuError(toBootstrapRuntimeError(e));
    } finally {
      setIsGpuRetrying(false);
    }
  }, [bootstrapGpu, setGpuReady, setGpuError]);

  retryGpuBootstrapRef.current = retryGpuBootstrap;

  // What the renderer reports unasked: a refused pipeline (shown; the session
  // keeps drawing without it), a lost device or context (rendering stops
  // until Retry GPU), a restored WebGL context (boot again, as Retry would).
  useEffect(() => {
    const host = renderHostRef.current;
    const offError = host.on('runtime-error', (error) => {
      if (error.kind !== 'pipeline') setGpuReady(false);
      setGpuError(error);
    });
    const offRestored = host.on('context-restored', () => {
      void retryGpuBootstrapRef.current?.();
    });
    return () => {
      offError();
      offRestored();
    };
  }, [renderHostRef, setGpuError, setGpuReady]);

  const initRef = useRef(init);
  initRef.current = init;

  useEffect(() => {
    const fatal = getGpuFatalError();
    if (fatal) {
      setGpuError(fatal);
      return;
    }

    const host = renderHostRef.current;
    const cancelToken: CancelToken = { cancelled: false };
    const abortController = new AbortController();

    setGpuReady(false);

    initRef.current(cancelToken, abortController.signal).catch((e) => {
      if (isCancelled(cancelToken, abortController.signal) || isAbortError(e)) return;
      const err = toBootstrapRuntimeError(e);
      const sticky = getGpuFatalError() ?? err;
      setGpuError(sticky);
    });

    return () => {
      cancelToken.cancelled = true;
      abortController.abort();
      retryAbortRef.current?.abort();
      setGpuReady(false);
      // Tears the renderer down and overtakes a boot in flight. The device
      // lease and the canvas (transferred, on the worker) stay.
      host.shutdown();
    };
    // Page-lifetime GPU boot (#157 / #158): every dependency here is stable —
    // refs, the store's memoized actions — so this runs once. `init` is read
    // through `initRef` because it is rebuilt every render; a re-run would
    // reset requestDevice to attempt 1 and could OOM D3D12 command queues.
    // Resize / antialias / colour-space changes reconfigure, never reboot.
  }, [setGpuError, setGpuReady, renderHostRef]);

  useEffect(() => {
    renderHostRef.current.setCanvas({ colorSpace: displayColorSpace });
  }, [displayColorSpace, renderHostRef]);

  useEffect(() => {
    renderHostRef.current.setCanvas({ canvasHdr });
  }, [canvasHdr, renderHostRef]);

  return { retryGpuBootstrap, isGpuRetrying };
}
