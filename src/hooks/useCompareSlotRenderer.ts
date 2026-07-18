import { useEffect } from 'react';
import type { ChromashiftRefs, ChromashiftStore } from './useChromashiftStore';

const COMPARE_SLOT_ID = 'compare-b';

/**
 * Lifecycle for the compare slot B renderer (dual layout).
 *
 * Delegates to RendererOrchestrator so slot B shares the bootstrapped device
 * and texture manager without duplicating init/teardown. Must run after
 * useAppWebGPUInit so orchestrator cleanup destroys slot B before the device.
 */
export function useCompareSlotRenderer(refs: ChromashiftRefs, store: ChromashiftStore): void {
  const { state } = store;
  const dualActive = state.ui.compareView.layout === 'dual';
  const gpuReady = state.engine.gpuReady;
  const backend = state.engine.backend;
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

    const slot = orchestrator.createSlot(COMPARE_SLOT_ID, canvas);
    if (sourceTextureRef.current) slot.renderer.setTexture(sourceTextureRef.current);
    if (maskTextureRef.current) slot.renderer.setClassificationMaskTexture(maskTextureRef.current);
    animAnglesBRef.current = [...animAnglesRef.current];
    rendererBRef.current = slot.renderer;

    return () => {
      orchestrator.destroySlot(COMPARE_SLOT_ID);
      rendererBRef.current = null;
    };
  }, [
    dualActive,
    gpuReady,
    backend,
    canvasBRef,
    rendererBRef,
    orchestratorRef,
    sourceTextureRef,
    maskTextureRef,
    animAnglesRef,
    animAnglesBRef,
  ]);
}
