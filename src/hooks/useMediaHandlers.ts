import { useCallback, useEffect } from 'react';
import { Upscaler, type UpscaleModel } from '../engine/upscale/Upscaler';
import { MAIN_VIEW_MODES } from '../engine/viewModes';
import { buildRendererState } from '../engine/buildRendererState';
import { resolvePresentation } from '../engine/color/presentation';
import { downloadBlob, encodeStillPng, stillExportSpace } from '../engine/color/stillExport';
import { computeAverageLuminanceStridedWith } from '../engine/WasmEngine';
import { addLocalImage, clearLocalLibrary } from '../engine/library/LocalLibrary';
import type { ImageEntry } from '../engine/library/imageEntry';
import type { ChromashiftRefs, ChromashiftStore } from './useChromashiftStore';
import { drawOriginalPreview, previewSizeOf } from './sourcePreview';

interface MediaHandlersOptions {
  refs: ChromashiftRefs;
  store: ChromashiftStore;
  clearClassificationMask: () => void;
  analyzeSource: (url: string) => Promise<number>;
}

export function useMediaHandlers({
  refs,
  store,
  clearClassificationMask,
  analyzeSource,
}: MediaHandlersOptions) {
  const { state, actions, selectSourceIndex, ensureReferenceImage } = store;
  const { media } = state;
  const {
    renderHostRef,
    capturePreviewAfterRender: capturePreviewAfterRenderRef,
    imageListRef,
    currentImageIndexRef,
    previewOriginalRef,
    ownedObjectUrlsRef,
  } = refs;

  const handleReset = useCallback(() => {
    actions.resetRenderDefaults();
  }, [actions]);

  const handleLoadSpecificImage = useCallback(async (url: string, label = 'External Image') => {
    if (!refs.renderStateRef.current.engine.gpuReady) return;
    const host = renderHostRef.current;
    actions.setSpecificImageError(null);
    try {
      const loaded = await host.loadSource({
        url,
        keep: [url, media.reference?.url].filter((u): u is string => !!u),
        preview: previewSizeOf(previewOriginalRef.current),
      });
      host.clearPersistence();
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

      if (loaded.height > 0) actions.setImageAspect(loaded.width / loaded.height);
      drawOriginalPreview(previewOriginalRef.current, loaded.preview);
      void analyzeSource(url).then(
        (avgLum) => actions.setAvgLuminance(Math.round(avgLum)),
        (error: unknown) => {
          console.warn('Could not analyze the source (CORS?):', error);
          actions.setAvgLuminance(128);
        },
      );
    } catch (e) {
      console.error('Failed to load specific image:', e);
      actions.setSpecificImageError(`Failed to load: ${url}`);
    }
  }, [
    refs,
    renderHostRef,
    capturePreviewAfterRenderRef,
    imageListRef,
    currentImageIndexRef,
    previewOriginalRef,
    actions,
    media.reference,
    ensureReferenceImage,
    clearClassificationMask,
    analyzeSource,
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
    renderHostRef,
    renderStateRef,
    upscalerRef,
    engineModeRef,
    capturePreviewAfterRender: capturePreviewAfterRenderRef,
    previewOriginalRef,
    mainCanvasRef,
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
    if (!renderStateRef.current.engine.gpuReady) return;
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

      // Measured before the upload: the pixels are handed to the renderer.
      const stride = Math.max(1, Math.floor(Math.max(result.width, result.height) / 256));
      const avgLum = computeAverageLuminanceStridedWith(
        result.pixels, result.width, result.height, stride,
        engineModeRef.current === 'wasm',
      );
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

      const host = renderHostRef.current;
      const pixels = new Uint8ClampedArray(result.pixels.byteLength);
      pixels.set(result.pixels);
      await host.uploadPixels(`__upscaled__:${url}`, pixels, result.width, result.height);
      host.clearPersistence();
      clearClassificationMask();

      actions.setAvgLuminance(Math.round(avgLum));
      actions.setImageAspect(result.width / result.height);
      capturePreviewAfterRenderRef.current = true;

      actions.setUpscaleInfo(`Done — ${result.width}×${result.height}`);
    } catch (e) {
      console.error('Upscale failed:', e);
      actions.setUpscaleInfo(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      actions.setUpscaleBusy(false);
    }
  }, [
    renderHostRef,
    renderStateRef,
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
    if (!mainCanvasRef.current) return;
    if (upscalerRef.current?.isBusy()) return;

    upscalerRef.current ??= new Upscaler();
    actions.setUpscaleBusy(true);
    actions.setUpscaleProgress(0);
    actions.setUpscaleInfo('Capturing canvas…');

    try {
      // The frame comes back by readback: the canvas may be drawn by the
      // render worker, and the page cannot read a transferred canvas.
      const host = renderHostRef.current;
      const { width, height } = host.canvasSize(mainCanvasRef.current);
      const frame = await host.exportFrame({
        state: buildRendererState(renderStateRef.current, renderStateRef.current.layers.angles, {
          presentationSpace: 'srgb',
        }),
        options: { width, height },
        liveAngles: true,
      });
      if (!frame) throw new Error('The renderer returned no frame.');
      const src = { data: frame.data, width: frame.width, height: frame.height };

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
  }, [renderHostRef, renderStateRef, mainCanvasRef, upscalerRef, ui.upscaleModel, actions, parseUpscaleModel]);

  return { handleUpscaleSource, handleUpscaleOutput };
}

export function useTracerExport(
  refs: ChromashiftRefs,
  store: ChromashiftStore,
) {
  const { getState, actions } = store;
  const { renderHostRef, mainCanvasRef } = refs;

  const handleExportTracer = useCallback(async () => {
    const host = renderHostRef.current;
    const snapshot = getState();
    if (!snapshot.engine.gpuReady || snapshot.ui.exportingTracer) return;
    actions.setExportingTracer(true);
    try {
      const mainCanvas = mainCanvasRef.current;
      const size = mainCanvas ? host.canvasSize(mainCanvas) : null;
      const baseWidth = Math.max(1, Math.round(size?.width ?? 2048));
      const baseHeight = Math.max(1, Math.round(size?.height ?? 2048));
      const longestEdge = Math.max(baseWidth, baseHeight);
      const exportScale = Math.max(1, 3840 / longestEdge);
      const width = Math.max(1, Math.round(baseWidth * exportScale));
      const height = Math.max(1, Math.round(baseHeight * exportScale));
      const { tracers, layers, output } = snapshot;
      const inspect = output.tracerInspect;
      const result = await host.exportTracer({
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
        layerOpacities: layers.opacities,
      });
      if (!result) return;

      // The tracer-inspect pass writes sRGB (it does not run the presentation
      // matrix), so its still is tagged sRGB whatever the canvas presents.
      const png = await encodeStillPng(result, 'srgb');
      if (!png) return;
      downloadBlob(png.blob, `chromashift-tracer-${result.width}x${result.height}.png`);
    } catch (error) {
      // The button's click handler drops this promise: report here or nowhere.
      console.error('Tracer export failed:', error);
      alert(error instanceof Error ? error.message : 'Tracer export failed.');
    } finally {
      actions.setExportingTracer(false);
    }
  }, [renderHostRef, mainCanvasRef, getState, actions]);

  /**
   * A PNG of the current composite, encoded for — and tagged with — the
   * presentation space `color/presentation.ts` resolves. Falls back to an
   * sRGB render when the UA cannot tag a 2D canvas Display P3, so the file
   * never claims a space its bytes are not in.
   */
  const handleExportStill = useCallback(async () => {
    const host = renderHostRef.current;
    const snapshot = getState();
    if (!snapshot.engine.gpuReady || snapshot.ui.exportingTracer) return;
    actions.setExportingTracer(true);
    try {
      const mainCanvas = mainCanvasRef.current;
      const size = mainCanvas ? host.canvasSize(mainCanvas) : null;
      const width = Math.max(1, Math.round(size?.width ?? 2048));
      const height = Math.max(1, Math.round(size?.height ?? 2048));
      const requested = resolvePresentation({
        colorSpace: snapshot.output.displayColorSpace,
        presentation: snapshot.output.canvasHdr ? 'hdr-extended' : 'sdr',
      }).space;
      // WebGL converts only in its on-screen blit; its export readback is sRGB.
      const space = snapshot.engine.backend === 'webgpu' ? stillExportSpace(requested) : 'srgb';
      // Drawn at the live angles, which the renderer holds.
      const state = buildRendererState(snapshot, snapshot.layers.angles, {
        presentationSpace: space,
      });
      const result = await host.exportFrame({ state, options: { width, height }, liveAngles: true });
      if (!result) return;
      const png = await encodeStillPng(result, space);
      if (!png) return;
      downloadBlob(png.blob, `chromashift-still-${result.width}x${result.height}-${png.colorSpace}.png`);
    } catch (error) {
      console.error('Still export failed:', error);
      alert(error instanceof Error ? error.message : 'Still export failed.');
    } finally {
      actions.setExportingTracer(false);
    }
  }, [renderHostRef, mainCanvasRef, getState, actions]);

  return { handleExportTracer, handleExportStill };
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
