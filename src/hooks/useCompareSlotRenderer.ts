import { useEffect } from 'react';
import type { WebGPURenderer } from '../engine/WebGPURenderer';
import type { ChromashiftRefs, ChromashiftStore } from './useChromashiftStore';

/** Slot id for compare layout slot B (dual 2-up). */
export const COMPARE_SLOT_B_ID = 'compare-b';

/**
 * Lifecycle for the compare slot B renderer (dual layout).
 *
 * Delegates to RendererOrchestrator on the shared GPUDevice/TextureManager from
 * the main bootstrap. Must run after useAppWebGPUInit so cleanup order keeps the
 * orchestrator alive while slot B is torn down.
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
    orchestratorRef,
    sourceTextureRef,
    maskTextureRef,
    animAnglesRef,
    animAnglesBRef,
  } = refs;

  useEffect(() => {
    if (!dualActive || !gpuReady || backend !== 'webgpu') return;
    const orchestrator = orchestratorRef.current;
    const canvas = canvasBRef.current;
    if (!orchestrator || !canvas) return;

    const slot = orchestrator.createSlot(COMPARE_SLOT_B_ID, canvas);
    const rendererB = slot.renderer as WebGPURenderer;
    if (sourceTextureRef.current) rendererB.setTexture(sourceTextureRef.current);
    if (maskTextureRef.current) rendererB.setClassificationMaskTexture(maskTextureRef.current);
    animAnglesBRef.current = [...animAnglesRef.current];
    rendererBRef.current = rendererB;

    return () => {
      rendererBRef.current = null;
      orchestrator.destroySlot(COMPARE_SLOT_B_ID);
    };
  }, [
    dualActive,
    gpuReady,
    backend,
    antialiasEnabled,
    canvasBRef,
    rendererBRef,
    orchestratorRef,
    sourceTextureRef,
    maskTextureRef,
    animAnglesRef,
    animAnglesBRef,
  ]);
}
