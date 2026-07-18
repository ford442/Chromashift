import { useEffect } from 'react';
import { WebGPURenderer } from '../engine/WebGPURenderer';
import { configureWebGpuCanvas } from '../engine/gpuBootstrap';
import type { ChromashiftRefs, ChromashiftStore } from './useChromashiftStore';

/**
 * Lifecycle for the compare slot B renderer (dual layout).
 *
 * Creates a second WebGPURenderer on the *shared* GPUDevice/TextureManager from
 * the main bootstrap; owns only the slot B canvas context and renderer. Must be
 * invoked after useAppWebGPUInit so its cleanup runs before the device is
 * destroyed. Never destroys the device, session, or shared textures.
 */
export function useCompareSlotRenderer(refs: ChromashiftRefs, store: ChromashiftStore): void {
  const { state } = store;
  const dualActive = state.ui.compareView.layout === 'dual';
  const gpuReady = state.engine.gpuReady;
  const backend = state.engine.backend;
  const antialiasEnabled = state.output.antialiasEnabled;
  const {
    canvasBRef,
    rendererBRef,
    webGpuSessionRef,
    sourceTextureRef,
    maskTextureRef,
    animAnglesRef,
    animAnglesBRef,
  } = refs;

  useEffect(() => {
    if (!dualActive || !gpuReady || backend !== 'webgpu') return;
    const session = webGpuSessionRef.current;
    const canvas = canvasBRef.current;
    if (!session || !canvas) return;

    const ctx = canvas.getContext('webgpu');
    if (!ctx) return;

    // Guard against a 0×0 canvas before the resize observer has sized it.
    if (canvas.width === 0) canvas.width = 1;
    if (canvas.height === 0) canvas.height = 1;
    configureWebGpuCanvas(ctx, session.device, session.format);

    const rendererB = new WebGPURenderer(session.device, ctx, session.format, antialiasEnabled);
    if (sourceTextureRef.current) rendererB.setTexture(sourceTextureRef.current);
    if (maskTextureRef.current) rendererB.setClassificationMaskTexture(maskTextureRef.current);
    animAnglesBRef.current = [...animAnglesRef.current];
    rendererBRef.current = rendererB;

    return () => {
      rendererBRef.current = null;
      rendererB.destroy();
      ctx.unconfigure();
    };
  }, [
    dualActive,
    gpuReady,
    backend,
    antialiasEnabled,
    canvasBRef,
    rendererBRef,
    webGpuSessionRef,
    sourceTextureRef,
    maskTextureRef,
    animAnglesRef,
    animAnglesBRef,
  ]);
}
