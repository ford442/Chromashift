import { useEffect, useCallback, type MutableRefObject } from 'react';
import { WebGPURenderer } from '../engine/WebGPURenderer';
import { TextureManager } from '../engine/TextureManager';
import { WebGLRenderer } from '../engine/WebGLRenderer';
import { WebGLTextureManager } from '../engine/WebGLTextureManager';
import { computeAverageLuminanceWith } from '../engine/WasmEngine';
import type { ImageEntry } from '../engine/TextureManager';
import type { ChromashiftRenderer, ChromashiftTextureManager, RendererBackend } from '../engine/RendererTypes';
import { getRendererPreference, publishRendererBreadcrumbs } from '../engine/rendererMode';

export interface UseAppWebGPUInitProps {
  previewTracerRef: MutableRefObject<HTMLCanvasElement | null>;
  antialiasEnabled: boolean;
  setError: (err: string) => void;
  deviceRef: MutableRefObject<GPUDevice | null>;
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

export function useAppWebGPUInit({
  previewTracerRef,
  antialiasEnabled,
  setError,
  deviceRef,
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

  const init = useCallback(async () => {
      const canvas = previewTracerRef.current;
      if (!canvas) return undefined;

      const cancelled = false;
      let localDevice: GPUDevice | null = null;
      let localRenderer: ChromashiftRenderer | null = null;
      let localTextureManager: ChromashiftTextureManager | null = null;
      let backend: RendererBackend = getRendererPreference();
      let fallbackReason: string | null = null;

      async function createWebGPU(): Promise<{
        renderer: WebGPURenderer;
        textureManager: TextureManager;
        device: GPUDevice;
      }> {
        if (!navigator.gpu) throw new Error('WebGPU is not supported in this browser.');
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
        if (!adapter) throw new Error('No WebGPU adapter found.');
        const device = await adapter.requestDevice();
        const context = canvas!.getContext('webgpu');
        if (!context) {
          device.destroy();
          throw new Error('Failed to get WebGPU context from canvas.');
        }
        const format = navigator.gpu.getPreferredCanvasFormat();
        context.configure({ device, format, alphaMode: 'opaque' });
        return {
          renderer: new WebGPURenderer(device, context, format, antialiasEnabled),
          textureManager: new TextureManager(device),
          device,
        };
      }

      function createWebGL(): {
        renderer: WebGLRenderer;
        textureManager: WebGLTextureManager;
      } {
        const gl = canvas!.getContext('webgl2', {
          alpha: false,
          antialias: antialiasEnabled,
          preserveDrawingBuffer: true,
        });
        if (!gl) throw new Error('WebGL2 is not supported in this browser.');
        return {
          renderer: new WebGLRenderer(canvas!, gl),
          textureManager: new WebGLTextureManager(gl),
        };
      }

      try {
        if (backend === 'webgl') {
          const created = createWebGL();
          localRenderer = created.renderer;
          localTextureManager = created.textureManager;
        } else {
          const created = await createWebGPU();
          localRenderer = created.renderer;
          localTextureManager = created.textureManager;
          localDevice = created.device;
        }
      } catch (primaryError) {
        if (backend === 'webgpu') {
          fallbackReason = primaryError instanceof Error ? primaryError.message : String(primaryError);
          const created = createWebGL();
          backend = 'webgl';
          localRenderer = created.renderer;
          localTextureManager = created.textureManager;
        } else {
          throw primaryError;
        }
      }

      if (cancelled) {
        localRenderer.destroy();
        localTextureManager.destroy();
        localDevice?.destroy();
        return { localRenderer, localTextureManager, localDevice, backend, cancelled };
      }

      deviceRef.current = localDevice;
      rendererRef.current = localRenderer;
      textureManagerRef.current = localTextureManager;
      setRendererBackend(backend);
      setRendererFallbackReason(fallbackReason);
      publishRendererBreadcrumbs(backend, fallbackReason);

      try {
        const list = await localTextureManager.fetchImageList('./images.json');
        const entries = [...list];
        setImageList(entries);

        const urlParams = new URLSearchParams(window.location.search);
        const imgUrl = urlParams.get('img') || urlParams.get('image') || urlParams.get('url');
        const specificUrl = imgUrl ? decodeURIComponent(imgUrl) : null;
        if (specificUrl) {
          try {
            const tex = await localTextureManager.loadTexture(specificUrl);
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
              const tex = await localTextureManager.loadTexture(entries[0].url);
              localRenderer.setTexture(tex);
              setReferenceImage(ensureReferenceImage(entries, 0));
            }
          }
        } else if (entries.length > 0) {
          const tex = await localTextureManager.loadTexture(entries[0].url);
          localRenderer.setTexture(tex);
          setReferenceImage(ensureReferenceImage(entries, 0));
        }
      } catch (e) {
        console.warn('Could not load image list:', e);
      }

      setGpuReady(true);
      return { localRenderer, localTextureManager, localDevice, backend, cancelled };
  }, [antialiasEnabled, clearClassificationMask, ensureReferenceImage, generateClassificationMaskTexture, deviceRef, rendererRef, textureManagerRef, setRendererBackend, setRendererFallbackReason, setImageList, setReferenceImage, setCurrentImageIndex, setImageAspect, setAvgLuminance, engineModeRef, previewOriginalRef, setGpuReady, setSpecificImageError, previewTracerRef]);

  useEffect(() => {
    const canvas = previewTracerRef.current;
    let localData: {
      localRenderer: ChromashiftRenderer | null;
      localTextureManager: ChromashiftTextureManager | null;
      localDevice: GPUDevice | null;
      backend: RendererBackend;
      cancelled: boolean;
    } | undefined;

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
      if (localData?.localTextureManager) localData.localTextureManager.destroy();
      if (localData?.localDevice) localData.localDevice.destroy();
      if (canvas && localData?.backend === 'webgpu') {
        const ctx = canvas.getContext('webgpu');
        if (ctx) ctx.unconfigure();
      }
    };
  }, [init, clearClassificationMask, ownedObjectUrlsRef, previewTracerRef, setError]);
}
