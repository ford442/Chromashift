import { useCallback } from 'react';
import { classifyImageMaskWith, isWasmReady } from '../engine/WasmEngine';
import type { ChromashiftRefs } from './useChromashiftStore';

export function useClassificationMask(refs: ChromashiftRefs) {
  const { rendererRef, maskTextureRef, engineModeRef, deviceRef } = refs;

  const clearClassificationMask = useCallback(() => {
    rendererRef.current?.setClassificationMaskTexture(null);
    maskTextureRef.current?.destroy();
    maskTextureRef.current = null;
  }, [rendererRef, maskTextureRef]);

  const generateClassificationMaskTexture = useCallback((image: HTMLImageElement, avgLumValue: number) => {
    if (engineModeRef.current !== 'wasm' || !isWasmReady()) {
      clearClassificationMask();
      return;
    }

    const device = deviceRef.current;
    const renderer = rendererRef.current;
    if (!device || !renderer) return;

    const result = classifyImageMaskWith(image, avgLumValue, true);
    if (!result) {
      clearClassificationMask();
      return;
    }

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
    maskTextureRef.current?.destroy();
    maskTextureRef.current = texture;
    renderer.setClassificationMaskTexture(texture);
  }, [deviceRef, rendererRef, maskTextureRef, engineModeRef, clearClassificationMask]);

  return { clearClassificationMask, generateClassificationMaskTexture };
}
