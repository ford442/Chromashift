import { useCallback, useEffect } from 'react';
import { Upscaler, type UpscaleModel } from '../engine/Upscaler';
import { MAIN_VIEW_MODES } from '../engine/viewModes';
import {
  computeAverageLuminanceStridedWith,
  computeImageAverageLuminanceWith,
} from '../engine/WasmEngine';
import { addLocalImage, clearLocalLibrary } from '../engine/LocalLibrary';
import type { ImageEntry } from '../engine/TextureManager';
import { applySourceTexture, type ChromashiftRefs, type ChromashiftStore } from './useChromashiftStore';

interface MediaHandlersOptions {
  refs: ChromashiftRefs;
  store: ChromashiftStore;
  clearClassificationMask: () => void;
  generateClassificationMaskTexture: (
    image: HTMLImageElement,
    avgLum: number,
    sourceTexture?: GPUTexture | null,
  ) => Promise<number>;
}

export function useMediaHandlers({
  refs,
  store,
  clearClassificationMask,
  generateClassificationMaskTexture,
}: MediaHandlersOptions) {
  const { state, actions, selectSourceIndex, ensureReferenceImage } = store;
  const { media } = state;
  const {
    textureManagerRef,
    rendererRef,
    capturePreviewAfterRender: capturePreviewAfterRenderRef,
    imageListRef,
    currentImageIndexRef,
    engineModeRef,
    previewOriginalRef,
    ownedObjectUrlsRef,
  } = refs;

  const handleReset = useCallback(() => {
    actions.resetRenderDefaults();
  }, [actions]);

  const handleLoadSpecificImage = useCallback(async (url: string, label = 'External Image') => {
    if (!textureManagerRef.current || !rendererRef.current) return;
    actions.setSpecificImageError(null);
    try {
      const tex = await textureManagerRef.current.loadTexture(url);
      applySourceTexture(refs, tex);
      rendererRef.current.clearPersistence();
      clearClassificationMask();
      capturePreviewAfterRenderRef.current = true;
      const currentEntry = imageListRef.current[currentImageIndexRef.current];
      if (currentEntry) actions.setPreviousImage(currentEntry);

      const existingIndex = imageListRef.current.findIndex((entry) => entry.url === url);
      if (existingIndex !== -1) {
        actions.setCurrentImageIndex(existingIndex);
      } else {
        const next = [...imageListRef.current, { url, label }];
        actions.setImageList(next);
        actions.setCurrentImageIndex(next.length - 1);
        if (media.reference === null) {
          actions.setReferenceImage(ensureReferenceImage(next, next.length - 1));
        }
      }

      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        if (img.height > 0) actions.setImageAspect(img.width / img.height);
        void (async () => {
          let avgLum = 128;
          try {
            avgLum = await generateClassificationMaskTexture(img, 128, tex as GPUTexture);
          } catch (e) {
            console.warn('Could not generate classification mask:', e);
            clearClassificationMask();
            try {
              avgLum = computeImageAverageLuminanceWith(img, engineModeRef.current === 'wasm');
            } catch (lumError) {
              console.warn('CORS?', lumError);
            }
          }
          actions.setAvgLuminance(Math.round(avgLum));
        })();
        const previewOrig = previewOriginalRef.current;
        if (previewOrig) {
          const ctx = previewOrig.getContext('2d');
          if (ctx) ctx.drawImage(img, 0, 0, previewOrig.width, previewOrig.height);
        }
      };
      img.src = url;
    } catch (e) {
      console.error('Failed to load specific image:', e);
      actions.setSpecificImageError(`Failed to load: ${url}`);
    }
  }, [
    refs,
    textureManagerRef,
    rendererRef,
    capturePreviewAfterRenderRef,
    imageListRef,
    currentImageIndexRef,
    engineModeRef,
    previewOriginalRef,
    actions,
    media.reference,
    ensureReferenceImage,
    clearClassificationMask,
    generateClassificationMaskTexture,
  ]);

  const swapSourceAndReference = useCallback(() => {
    const referenceImage = media.reference;
    if (!referenceImage) return;
    const imageList = media.imageList;
    const currentImageIndex = media.currentIndex;
    const corpusIndex = imageList.findIndex((entry) => entry.url === referenceImage.url);
    if (corpusIndex !== -1) {
      const currentEntry = imageList[currentImageIndex];
      if (currentEntry) actions.setReferenceImage(currentEntry);
      selectSourceIndex(corpusIndex);
      return;
    }
    const currentEntry = imageList[currentImageIndex];
    if (currentEntry) actions.setReferenceImage(currentEntry);
    void handleLoadSpecificImage(referenceImage.url, referenceImage.label ?? 'Reference Image');
  }, [media, actions, selectSourceIndex, handleLoadSpecificImage]);

  const handleLoadFile = useCallback((file: File) => {
    const url = URL.createObjectURL(file);
    ownedObjectUrlsRef.current.push(url);
    void handleLoadSpecificImage(url, file.name);
  }, [ownedObjectUrlsRef, handleLoadSpecificImage]);

  const handleLoadReferenceImage = useCallback((url: string, label = 'Reference Image') => {
    actions.setReferenceImage({ url, label });
  }, [actions]);

  const handleLoadReferenceFile = useCallback((file: File) => {
    const url = URL.createObjectURL(file);
    ownedObjectUrlsRef.current.push(url);
    handleLoadReferenceImage(url, file.name);
  }, [ownedObjectUrlsRef, handleLoadReferenceImage]);

  const handleFreezeInspect = useCallback(() => {
    actions.setIsPaused(true);
    actions.setMainViewMode(MAIN_VIEW_MODES.FULL_RES_TRACER);
  }, [actions]);

  /**
   * Persist dropped files (and any images inside dropped folders) into the local
   * IndexedDB library, then append them to the corpus and select the first one as
   * the new source. Existing textures are unaffected — the new entries just carry
   * blob: URLs backed by IndexedDB, so they behave like any other corpus image.
   */
  const handleDropFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    const additions: ImageEntry[] = [];
    for (const file of files) {
      try {
        const { meta, thumbBlob } = await addLocalImage(file);
        const url = URL.createObjectURL(file);
        const thumbUrl = URL.createObjectURL(thumbBlob);
        ownedObjectUrlsRef.current.push(url, thumbUrl);
        additions.push({ url, thumbUrl, label: meta.label, localId: meta.id });
      } catch (e) {
        console.error('Failed to store dropped image:', file.name, e);
      }
    }
    if (additions.length === 0) return;

    const nextList = [...imageListRef.current, ...additions];
    actions.setImageList(nextList);
    const firstNewIndex = nextList.length - additions.length;
    actions.setCurrentImageIndex(firstNewIndex);
    if (media.reference === null) {
      actions.setReferenceImage(ensureReferenceImage(nextList, firstNewIndex));
    }
  }, [ownedObjectUrlsRef, imageListRef, actions, media.reference, ensureReferenceImage]);

  /** Wipe the local library and drop every locally-sourced entry from the corpus. */
  const handleClearLocalLibrary = useCallback(async () => {
    await clearLocalLibrary().catch((e) => console.error('Failed to clear local library:', e));
    const remaining = imageListRef.current.filter((entry) => !entry.localId);
    actions.setImageList(remaining);
    if (media.reference?.localId) actions.setReferenceImage(null);
    if (media.previous?.localId) actions.setPreviousImage(null);
    const currentEntry = imageListRef.current[currentImageIndexRef.current];
    if (currentEntry?.localId) {
      actions.setCurrentImageIndex(0);
    }
  }, [imageListRef, currentImageIndexRef, actions, media.reference, media.previous]);

  return {
    handleReset,
    handleLoadSpecificImage,
    swapSourceAndReference,
    handleLoadFile,
    handleLoadReferenceImage,
    handleLoadReferenceFile,
    handleFreezeInspect,
    handleDropFiles,
    handleClearLocalLibrary,
  };
}

export function useUpscalerHandlers(
  refs: ChromashiftRefs,
  store: ChromashiftStore,
  clearClassificationMask: () => void,
) {
  const { state, actions } = store;
  const { media, ui } = state;
  const {
    rendererRef,
    textureManagerRef,
    upscalerRef,
    engineModeRef,
    capturePreviewAfterRender: capturePreviewAfterRenderRef,
    previewOriginalRef,
    previewTracerRef,
  } = refs;

  const parseUpscaleModel = useCallback((value: string): UpscaleModel => {
    const parts = value.split(':');
    if (parts[0] === 'realesrgan') {
      return { kind: 'realesrgan', variant: parts[1] as UpscaleModel extends { kind: 'realesrgan'; variant: infer V } ? V : never };
    }
    if (parts[0] === 'swin_unet') {
      return {
        kind: 'swin_unet',
        style: parts[1] as 'art' | 'art_scan' | 'photo',
        scale: Number(parts[2]) as 1 | 2 | 4,
        noise: Number(parts[3]) as -1 | 0 | 1 | 2 | 3,
        tileSize: 256,
      };
    }
    return { kind: 'realcugan', factor: Number(parts[1]) as 2 | 4, denoise: parts[2] as 'conservative' | '0x' | '1x' | '2x' | '3x' };
  }, []);

  const handleUpscaleSource = useCallback(async () => {
    if (!rendererRef.current || !textureManagerRef.current) return;
    if (upscalerRef.current?.isBusy()) return;

    const activeImage = media.imageList[media.currentIndex];
    const url = activeImage?.url;
    if (!url) return;

    upscalerRef.current ??= new Upscaler();
    actions.setUpscaleBusy(true);
    actions.setUpscaleProgress(0);
    actions.setUpscaleInfo('Preparing…');

    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const i = new Image();
        i.crossOrigin = 'anonymous';
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error('Failed to load image for upscaling'));
        i.src = url;
      });
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const cx = c.getContext('2d');
      if (!cx) throw new Error('2D context unavailable');
      cx.drawImage(img, 0, 0);
      const src = cx.getImageData(0, 0, c.width, c.height);

      const result = await upscalerRef.current.upscale(
        src.data, src.width, src.height, parseUpscaleModel(ui.upscaleModel),
        (p) => { actions.setUpscaleProgress(p.progress); actions.setUpscaleInfo(p.info); },
      );

      const tex = textureManagerRef.current.uploadPixels(
        `__upscaled__:${url}`, result.pixels, result.width, result.height,
      );
      applySourceTexture(refs, tex);
      rendererRef.current.clearPersistence();
      clearClassificationMask();

      const stride = Math.max(1, Math.floor(Math.max(result.width, result.height) / 256));
      const avgLum = computeAverageLuminanceStridedWith(
        result.pixels, result.width, result.height, stride,
        engineModeRef.current === 'wasm',
      );
      actions.setAvgLuminance(Math.round(avgLum));
      actions.setImageAspect(result.width / result.height);
      capturePreviewAfterRenderRef.current = true;

      const previewOrig = previewOriginalRef.current;
      if (previewOrig) {
        const pctx = previewOrig.getContext('2d');
        if (pctx) {
          const tmp = document.createElement('canvas');
          tmp.width = result.width;
          tmp.height = result.height;
          const buf = new Uint8ClampedArray(result.pixels.byteLength); buf.set(result.pixels);
          tmp.getContext('2d')!.putImageData(new ImageData(buf, result.width, result.height), 0, 0);
          pctx.drawImage(tmp, 0, 0, previewOrig.width, previewOrig.height);
        }
      }

      actions.setUpscaleInfo(`Done — ${result.width}×${result.height}`);
    } catch (e) {
      console.error('Upscale failed:', e);
      actions.setUpscaleInfo(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      actions.setUpscaleBusy(false);
    }
  }, [
    refs,
    rendererRef,
    textureManagerRef,
    upscalerRef,
    engineModeRef,
    capturePreviewAfterRenderRef,
    previewOriginalRef,
    media,
    ui.upscaleModel,
    actions,
    parseUpscaleModel,
    clearClassificationMask,
  ]);

  const handleUpscaleOutput = useCallback(async () => {
    if (!previewTracerRef.current) return;
    if (upscalerRef.current?.isBusy()) return;

    upscalerRef.current ??= new Upscaler();
    actions.setUpscaleBusy(true);
    actions.setUpscaleProgress(0);
    actions.setUpscaleInfo('Capturing canvas…');

    try {
      const canvas = previewTracerRef.current;
      const scratch = document.createElement('canvas');
      scratch.width = canvas.width;
      scratch.height = canvas.height;
      const sctx = scratch.getContext('2d');
      if (!sctx) throw new Error('2D context unavailable');
      sctx.drawImage(canvas, 0, 0);
      const src = sctx.getImageData(0, 0, scratch.width, scratch.height);

      const result = await upscalerRef.current.upscale(
        src.data, src.width, src.height, parseUpscaleModel(ui.upscaleModel),
        (p) => { actions.setUpscaleProgress(p.progress); actions.setUpscaleInfo(p.info); },
      );

      const out = document.createElement('canvas');
      out.width = result.width;
      out.height = result.height;
      const outBuf = new Uint8ClampedArray(result.pixels.byteLength); outBuf.set(result.pixels);
      out.getContext('2d')!.putImageData(new ImageData(outBuf, result.width, result.height), 0, 0);
      out.toBlob((blob) => {
        if (!blob) return;
        const dlUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = dlUrl;
        a.download = `chromashift-upscaled-${result.width}x${result.height}.png`;
        a.click();
        URL.revokeObjectURL(dlUrl);
      }, 'image/png');

      actions.setUpscaleInfo(`Saved — ${result.width}×${result.height}`);
    } catch (e) {
      console.error('Upscale output failed:', e);
      actions.setUpscaleInfo(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      actions.setUpscaleBusy(false);
    }
  }, [previewTracerRef, upscalerRef, ui.upscaleModel, actions, parseUpscaleModel]);

  return { handleUpscaleSource, handleUpscaleOutput };
}

export function useTracerExport(
  refs: ChromashiftRefs,
  store: ChromashiftStore,
) {
  const { state, actions } = store;
  const { rendererRef, previewTracerRef } = refs;

  const handleExportTracer = useCallback(async () => {
    const renderer = rendererRef.current;
    if (!renderer || state.ui.exportingTracer) return;
    actions.setExportingTracer(true);
    try {
      const mainCanvas = previewTracerRef.current;
      const baseWidth = Math.max(1, Math.round(mainCanvas?.width ?? 2048));
      const baseHeight = Math.max(1, Math.round(mainCanvas?.height ?? 2048));
      const longestEdge = Math.max(baseWidth, baseHeight);
      const exportScale = Math.max(1, 3840 / longestEdge);
      const width = Math.max(1, Math.round(baseWidth * exportScale));
      const height = Math.max(1, Math.round(baseHeight * exportScale));
      const { tracers, layers, output } = state;
      const inspect = output.tracerInspect;
      const result = await renderer.exportTracerView({
        width,
        height,
        tracerAboveOpacity: tracers.aboveIntensity,
        tracerBelowOpacity: tracers.belowIntensity,
        tracerBlendMode: tracers.tracerBlendMode,
        inspectZoom: inspect.zoom,
        inspectPanX: inspect.pan.x,
        inspectPanY: inspect.pan.y,
        showHeatmap: inspect.heatmap,
        exposure: inspect.exposure,
        applyTonemap: inspect.tonemap,
        showLayers: inspect.showLayers,
        layerBlendMode: tracers.layerBlendMode,
        layerOpacity0: layers.opacities[0],
        layerOpacity1: layers.opacities[1],
        layerOpacity2: layers.opacities[2],
      });
      if (!result) return;

      const exportCanvas = document.createElement('canvas');
      exportCanvas.width = result.width;
      exportCanvas.height = result.height;
      const exportCtx = exportCanvas.getContext('2d');
      if (!exportCtx) return;
      exportCtx.putImageData(new ImageData(result.data, result.width, result.height), 0, 0);
      exportCanvas.toBlob((blob) => {
        if (!blob) return;
        const href = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = href;
        link.download = `chromashift-tracer-${result.width}x${result.height}.png`;
        link.click();
        URL.revokeObjectURL(href);
      }, 'image/png');
    } finally {
      actions.setExportingTracer(false);
    }
  }, [rendererRef, previewTracerRef, state, actions]);

  return { handleExportTracer };
}

export function useAppKeyboardShortcuts(
  refs: ChromashiftRefs,
  store: ChromashiftStore,
  swapSourceAndReference: () => void,
): void {
  const { actions, selectSourceIndex } = store;
  const { currentImageIndexRef, imageListRef, renderStateRef } = refs;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName;
      if (target?.isContentEditable || tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') {
        return;
      }

      if (event.key === '[') {
        event.preventDefault();
        selectSourceIndex(Math.max(0, currentImageIndexRef.current - 1));
      } else if (event.key === ']') {
        event.preventDefault();
        selectSourceIndex(Math.min(imageListRef.current.length - 1, currentImageIndexRef.current + 1));
      } else if (event.key === ' ') {
        const { kioskEnabled, kioskUiHidden } = renderStateRef.current.ui;
        if (kioskEnabled && kioskUiHidden) return;
        event.preventDefault();
        actions.togglePaused();
      } else if (event.key === 'r' || event.key === 'R') {
        event.preventDefault();
        if (imageListRef.current.length > 0) {
          selectSourceIndex(Math.floor(Math.random() * imageListRef.current.length));
        }
      } else if (event.key === 's' || event.key === 'S') {
        event.preventDefault();
        swapSourceAndReference();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentImageIndexRef, imageListRef, renderStateRef, actions, selectSourceIndex, swapSourceAndReference]);
}
