import { useEffect } from 'react';
import { isTwoSlotCompareLayout } from '../engine/compareViews';
import { COMPARE_B_SLOT } from '../engine/render/RenderService';
import type { ChromashiftRefs, ChromashiftStore } from './useChromashiftStore';

/**
 * Lifecycle for the compare slot B renderer (dual / swipe layouts).
 *
 * Attaches canvas B to the render service, which binds it to the shared
 * device, hands it the source and mask, and draws it from the live loop with
 * its own angle clock. Must run after useAppWebGPUInit so a reboot attaches
 * the slot again once the GPU is ready.
 */
export function useCompareSlotRenderer(refs: ChromashiftRefs, store: ChromashiftStore): void {
  const { state } = store;
  const twoSlotActive = isTwoSlotCompareLayout(state.ui.compareView.layout);
  const gpuReady = state.engine.gpuReady;
  const backend = state.engine.backend;
  const { canvasBRef, renderHostRef } = refs;

  useEffect(() => {
    if (!twoSlotActive || !gpuReady || backend !== 'webgpu') return;
    const host = renderHostRef.current;
    const canvas = canvasBRef.current;
    if (!canvas) return;

    host.attach(COMPARE_B_SLOT, canvas);
    return () => host.detach(COMPARE_B_SLOT);
  }, [twoSlotActive, gpuReady, backend, canvasBRef, renderHostRef]);
}
