import { useEffect } from 'react';
import {
  computeAverageLuminanceWith,
  isWasmReady,
} from '../engine/WasmEngine';
import type { ChromashiftRefs, ChromashiftStore } from './useChromashiftStore';

interface ImagePlaybackOptions {
  refs: ChromashiftRefs;
  store: ChromashiftStore;
  clearClassificationMask: () => void;
  generateClassificationMaskTexture: (image: HTMLImageElement, avgLum: number) => void;
}

export function useImagePlayback({
  refs,
  store,
  clearClassificationMask,
  generateClassificationMaskTexture,
}: ImagePlaybackOptions): void {
  const { state, actions, selectSourceIndex } = store;
  const { media, engine, ui } = state;
  const {
    textureManagerRef,
    rendererRef,
    loadGenRef,
    previewOriginalRef,
    engineModeRef,
    capturePreviewAfterRender,
  } = refs;

  useEffect(() => {
    if (!engine.gpuReady || media.imageList.length === 0) return;
    const activeImage = media.imageList[media.currentIndex];
    if (!activeImage) return;
    const url = activeImage.url;
    const gen = ++loadGenRef.current;
    clearClassificationMask();
    rendererRef.current?.clearPersistence();

    textureManagerRef.current?.loadTexture(url).then((tex) => {
      if (gen !== loadGenRef.current) return;
      rendererRef.current?.setTexture(tex);
      capturePreviewAfterRender.current = true;

      const previewOrig = previewOriginalRef.current;
      if (previewOrig) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          if (gen !== loadGenRef.current) return;
          if (img.height > 0) actions.setImageAspect(img.width / img.height);

          let avgLum = 128;
          try {
            avgLum = computeAverageLuminanceWith(img, engineModeRef.current === 'wasm');
          } catch (e) {
            console.warn('Could not compute average luminance (CORS?):', e);
          }
          actions.setAvgLuminance(Math.round(avgLum));
          try {
            generateClassificationMaskTexture(img, avgLum);
          } catch (e) {
            console.warn('Could not generate classification mask:', e);
            clearClassificationMask();
          }

          const ctx = previewOrig.getContext('2d');
          if (ctx) ctx.drawImage(img, 0, 0, previewOrig.width, previewOrig.height);
        };
        img.onerror = () => console.warn('Failed to load preview image:', url);
        img.src = url;
      }
    }).catch((e) => console.warn('Failed to load texture:', url, e));
  }, [
    engine.gpuReady,
    media.imageList,
    media.currentIndex,
    actions,
    textureManagerRef,
    rendererRef,
    loadGenRef,
    previewOriginalRef,
    engineModeRef,
    capturePreviewAfterRender,
    clearClassificationMask,
    generateClassificationMaskTexture,
  ]);

  useEffect(() => {
    if (!ui.isAutoPlayActive || engine.paused || media.imageList.length === 0) return;
    const interval = setInterval(() => {
      selectSourceIndex(Math.floor(Math.random() * media.imageList.length));
    }, ui.imageChangeInterval * 1000);
    return () => clearInterval(interval);
  }, [ui.isAutoPlayActive, engine.paused, ui.imageChangeInterval, media.imageList.length, selectSourceIndex]);

  useEffect(() => {
    if (!engine.gpuReady || media.imageList.length === 0) return;
    if (engine.engineMode !== 'wasm' || !isWasmReady()) {
      clearClassificationMask();
      return;
    }
    const activeImage = media.imageList[media.currentIndex];
    if (!activeImage) return;
    const url = activeImage.url;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        generateClassificationMaskTexture(img, engine.avgLuminance);
      } catch (e) {
        console.warn('Could not refresh classification mask:', e);
        clearClassificationMask();
      }
    };
    img.onerror = () => clearClassificationMask();
    img.src = url;
  }, [
    engine.gpuReady,
    media.imageList,
    media.currentIndex,
    engine.engineMode,
    engine.avgLuminance,
    clearClassificationMask,
    generateClassificationMaskTexture,
  ]);
}
