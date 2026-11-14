import { useEffect, useRef } from 'react';
import type { ChromashiftRefs, ChromashiftStore } from './useChromashiftStore';
import { drawOriginalPreview, previewSizeOf } from './sourcePreview';

interface ImagePlaybackOptions {
  refs: ChromashiftRefs;
  store: ChromashiftStore;
  clearClassificationMask: () => void;
  analyzeSource: (url: string) => Promise<number>;
}

export function useImagePlayback({
  refs,
  store,
  clearClassificationMask,
  analyzeSource,
}: ImagePlaybackOptions): void {
  const { state, actions, selectSourceIndex } = store;
  const { media, engine, ui } = state;
  const {
    renderHostRef,
    loadGenRef,
    previewOriginalRef,
    capturePreviewAfterRender,
  } = refs;

  useEffect(() => {
    if (!engine.gpuReady || media.imageList.length === 0 || media.liveSource.active) return;
    const activeImage = media.imageList[media.currentIndex];
    if (!activeImage) return;
    const url = activeImage.url;
    const gen = ++loadGenRef.current;
    const host = renderHostRef.current;
    clearClassificationMask();
    host.clearPersistence(['quad-c']);

    // The renderer fetches and decodes (off the page, on the worker) and
    // sends back the size and a thumbnail-sized bitmap for the Original preview.
    host.loadSource({
      url,
      keep: [url, media.reference?.url].filter((u): u is string => !!u),
      preview: previewSizeOf(previewOriginalRef.current),
    }).then((loaded) => {
      if (gen !== loadGenRef.current) {
        loaded.preview?.close();
        return;
      }
      capturePreviewAfterRender.current = true;
      if (loaded.height > 0) actions.setImageAspect(loaded.width / loaded.height);
      drawOriginalPreview(previewOriginalRef.current, loaded.preview);
      void analyzeSource(url).then(
        (avgLum) => {
          if (gen === loadGenRef.current) actions.setAvgLuminance(Math.round(avgLum));
        },
        (error: unknown) => {
          console.warn('Could not analyze the source (CORS?):', url, error);
          if (gen === loadGenRef.current) actions.setAvgLuminance(128);
        },
      );
    }).catch((e) => console.warn('Failed to load texture:', url, e));
  }, [
    engine.gpuReady,
    media.imageList,
    media.currentIndex,
    media.reference?.url,
    media.liveSource.active,
    actions,
    renderHostRef,
    loadGenRef,
    previewOriginalRef,
    capturePreviewAfterRender,
    clearClassificationMask,
    analyzeSource,
  ]);

  useEffect(() => {
    if (
      !ui.isAutoPlayActive || engine.paused || ui.exportingVideo
      || media.imageList.length === 0 || media.liveSource.active
    ) return;
    const interval = setInterval(() => {
      selectSourceIndex(Math.floor(Math.random() * media.imageList.length));
    }, ui.imageChangeInterval * 1000);
    return () => clearInterval(interval);
  }, [
    ui.isAutoPlayActive, engine.paused, ui.exportingVideo, ui.imageChangeInterval,
    media.imageList.length, media.liveSource.active, selectSourceIndex,
  ]);

  // A luminance change re-runs the analysis for the current source (the mask
  // follows the average). The renderer analyzes what it shows. Not the GPU
  // becoming ready: the load above analyzes every source it uploads, and a
  // second run alongside it only queues behind it in the analysis worker.
  const refreshedLuminanceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!engine.gpuReady || media.liveSource.active) {
      refreshedLuminanceRef.current = null;
      return;
    }
    const previous = refreshedLuminanceRef.current;
    refreshedLuminanceRef.current = engine.avgLuminance;
    if (previous === null || previous === engine.avgLuminance) return;

    const index = refs.currentImageIndexRef.current;
    const list = refs.imageListRef.current;
    if (list.length === 0) return;
    const activeImage = list[index];
    if (!activeImage) return;

    void analyzeSource(activeImage.url).catch((e) => {
      console.warn('Could not refresh classification mask:', e);
      clearClassificationMask();
    });
  }, [
    refs,
    engine.gpuReady,
    engine.avgLuminance,
    media.liveSource.active,
    clearClassificationMask,
    analyzeSource,
  ]);
}
