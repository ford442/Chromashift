import { useCallback, useRef } from 'react';
import { classifyImageMaskWith, computeImageAverageLuminanceWith, isWasmReady } from '../engine/WasmEngine';
import type { ChromashiftTextureHandle } from '../engine/types/TextureHandle';
import { webGpuTextureFromHandle } from '../engine/types/TextureHandle';
import type { ChromashiftRefs } from './useChromashiftStore';
import { applyClassificationMaskToRenderers } from './useChromashiftStore';

type MaskOwner = 'gpu-analysis' | 'wasm-upload' | null;

export function useClassificationMask(refs: ChromashiftRefs) {
  const {
    rendererRef,
    maskTextureRef,
    engineModeRef,
    deviceRef,
    gpuImageAnalysisRef,
  } = refs;
  const maskOwnerRef = useRef<MaskOwner>(null);

  const clearClassificationMask = useCallback(() => {
    applyClassificationMaskToRenderers(refs, null);
    if (maskOwnerRef.current === 'wasm-upload') {
      maskTextureRef.current?.destroy();
    }
    maskTextureRef.current = null;
    maskOwnerRef.current = null;
  }, [refs, maskTextureRef]);

  const bindMaskTexture = useCallback((texture: GPUTexture, owner: MaskOwner) => {
    if (maskOwnerRef.current === 'wasm-upload' && maskTextureRef.current) {
      maskTextureRef.current.destroy();
    }
    maskTextureRef.current = texture;
    maskOwnerRef.current = owner;
    applyClassificationMaskToRenderers(refs, texture);
  }, [refs, maskTextureRef]);

  const generateClassificationMaskFromTexture = useCallback(async (
    source: GPUTexture,
    width: number,
    height: number,
    avgLumHint?: number,
  ): Promise<{ avgLuminance: number; usedGpu: boolean } | null> => {
    const renderer = rendererRef.current;
    if (!renderer || renderer.backend !== 'webgpu') return null;

    const analysis = gpuImageAnalysisRef.current;
    if (!analysis?.isSupported() || !analysis.canAnalyze(width, height)) {
      return null;
    }

    try {
      const result = await analysis.analyze(source, width, height, avgLumHint);
      if (!result) return null;

      bindMaskTexture(result.maskTexture, 'gpu-analysis');
      return { avgLuminance: result.avgLuminance, usedGpu: true };
    } catch (error) {
      console.warn('GPU classification mask failed, falling back:', error);
      return null;
    }
  }, [rendererRef, gpuImageAnalysisRef, bindMaskTexture]);

  const generateClassificationMaskFromImage = useCallback((
    image: HTMLImageElement,
    avgLumValue: number,
  ): boolean => {
    const device = deviceRef.current;
    const renderer = rendererRef.current;
    if (!device || !renderer || renderer.backend !== 'webgpu') return false;

    const useWasm = engineModeRef.current === 'wasm' && isWasmReady();
    const result = classifyImageMaskWith(image, avgLumValue, useWasm);
    if (!result) return false;

    const { mask, width, height } = result;
    const texture = device.createTexture({
      size: [width, height, 1],
      format: 'r8uint',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const bytes = new Uint8Array(mask.byteLength);
    bytes.set(mask);
    device.queue.writeTexture(
      { texture },
      bytes,
      { bytesPerRow: width, rowsPerImage: height },
      [width, height, 1],
    );
    bindMaskTexture(texture, 'wasm-upload');
    return true;
  }, [deviceRef, rendererRef, engineModeRef, bindMaskTexture]);

  const generateClassificationMaskTexture = useCallback(async (
    image: HTMLImageElement,
    _avgLumValue: number,
    sourceTexture?: ChromashiftTextureHandle | null,
  ): Promise<number> => {
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    const gpuSource = webGpuTextureFromHandle(sourceTexture);

    if (gpuSource && width > 0 && height > 0) {
      const gpu = await generateClassificationMaskFromTexture(
        gpuSource,
        width,
        height,
      );
      if (gpu) return gpu.avgLuminance;
    }

    const useWasm = engineModeRef.current === 'wasm' && isWasmReady();
    const avgLum = computeImageAverageLuminanceWith(image, useWasm);
    const usedCpu = generateClassificationMaskFromImage(image, avgLum);
    if (!usedCpu) clearClassificationMask();
    return avgLum;
  }, [
    generateClassificationMaskFromTexture,
    generateClassificationMaskFromImage,
    clearClassificationMask,
    engineModeRef,
  ]);

  return {
    clearClassificationMask,
    generateClassificationMaskTexture,
    generateClassificationMaskFromTexture,
  };
}
