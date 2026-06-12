import { useEffect, useCallback, type MutableRefObject } from 'react';
import { WebGPURenderer } from '../engine/WebGPURenderer';
import { TextureManager } from '../engine/TextureManager';
import { computeAverageLuminanceWith } from '../engine/WasmEngine';
import type { ImageEntry } from '../engine/TextureManager';

export interface UseAppWebGPUInitProps {
  previewTracerRef: MutableRefObject<HTMLCanvasElement | null>;
  antialiasEnabled: boolean;
  setError: (err: string) => void;
  deviceRef: MutableRefObject<GPUDevice | null>;
  rendererRef: MutableRefObject<WebGPURenderer | null>;
  textureManagerRef: MutableRefObject<TextureManager | null>;
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

export function useAppWebGPUInit({
  previewTracerRef,
  antialiasEnabled,
  setError,
  deviceRef,
  rendererRef,
  textureManagerRef,
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

  const init = useCallback(async () => {
      const cancelled = false;
      let localDevice: GPUDevice | null = null;
      let localRenderer: WebGPURenderer | null = null;
      if (!navigator.gpu) {
        setError('WebGPU is not supported in this browser.');
        return;
      }

      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) {
        setError('No WebGPU adapter found.');
        return;
      }

      const device = await adapter.requestDevice();

      if (cancelled) {
        device.destroy();
        return;
      }
      localDevice = device;

      const canvas = previewTracerRef.current!;
      const context = canvas.getContext('webgpu');
      if (!context) {
        setError('Failed to get WebGPU context from canvas.');
        return;
      }

      const format = navigator.gpu.getPreferredCanvasFormat();
      context.configure({ device, format, alphaMode: 'opaque' });

      const renderer = new WebGPURenderer(device, context, format, antialiasEnabled);
      localRenderer = renderer;
      const textureManager = new TextureManager(device);

      deviceRef.current = device;
      rendererRef.current = renderer;
      textureManagerRef.current = textureManager;

      try {
        const list = await textureManager.fetchImageList('./images.json');
        const entries = [...list];
        setImageList(entries);

        const urlParams = new URLSearchParams(window.location.search);
        const imgUrl = urlParams.get('img') || urlParams.get('image') || urlParams.get('url');
        const specificUrl = imgUrl ? decodeURIComponent(imgUrl) : null;
        if (specificUrl) {
          try {
            const tex = await textureManager.loadTexture(specificUrl);
            renderer.setTexture(tex);
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

            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
              if (cancelled) return;
              if (img.height > 0) setImageAspect(img.width / img.height);
              let avgLum = 128;
              try { avgLum = computeAverageLuminanceWith(img, engineModeRef.current === 'wasm'); } catch (e) { console.warn('CORS?', e); }
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
            };
            img.onerror = () => console.warn('Failed to load preview image:', specificUrl);
            img.src = specificUrl;
          } catch (e) {
            console.warn('Failed to load specific image from URL:', e);
            setSpecificImageError(`Failed to load image: ${specificUrl}`);
            if (entries.length > 0) {
              const tex = await textureManager.loadTexture(entries[0].url);
              renderer.setTexture(tex);
              setReferenceImage(ensureReferenceImage(entries, 0));
            }
          }
        } else if (entries.length > 0) {
          const tex = await textureManager.loadTexture(entries[0].url);
          renderer.setTexture(tex);
          setReferenceImage(ensureReferenceImage(entries, 0));
        }
      } catch (e) {
        console.warn('Could not load image list:', e);
      }

      setGpuReady(true);
      return { localRenderer, localDevice, cancelled };
  }, [antialiasEnabled, clearClassificationMask, ensureReferenceImage, generateClassificationMaskTexture, setError, deviceRef, rendererRef, textureManagerRef, setImageList, setReferenceImage, setCurrentImageIndex, setImageAspect, setAvgLuminance, engineModeRef, previewOriginalRef, setGpuReady, setSpecificImageError, previewTracerRef]);

  useEffect(() => {
    const canvas = previewTracerRef.current;
    let localData: { localRenderer: WebGPURenderer | null; localDevice: GPUDevice | null; cancelled: boolean } | undefined;

    init().then(res => {
      localData = res;
    }).catch((e) => setError(String(e)));

    return () => {
      if (localData) {
        localData.cancelled = true;
      }
      clearClassificationMask();
      for (const objectUrl of ownedObjectUrlsRef.current) URL.revokeObjectURL(objectUrl);
      ownedObjectUrlsRef.current = [];
      if (localData?.localRenderer) localData.localRenderer.destroy();
      if (localData?.localDevice) localData.localDevice.destroy();
      if (canvas) {
        const ctx = canvas.getContext('webgpu');
        if (ctx) ctx.unconfigure();
      }
    };
  }, [init, clearClassificationMask, ownedObjectUrlsRef, previewTracerRef, setError]);
}
