import { useEffect } from 'react';
import { isQuadCompareLayout } from '../engine/compareViews';
import type { ChromashiftRefs, ChromashiftStore } from './useChromashiftStore';

export const QUAD_SLOT_IDS = {
  a: 'quad-a',
  b: 'quad-b',
  c: 'quad-c',
} as const;

/**
 * Lifecycle for quad layout stationary cells (Original, Layers, Tracer).
 *
 * Cell D (Composite) is the primary slot. Must run after useAppWebGPUInit so
 * a reboot attaches the cells again once the GPU is ready.
 */
export function useCompareQuadSlots(refs: ChromashiftRefs, store: ChromashiftStore): void {
  const { state } = store;
  const quadActive = isQuadCompareLayout(state.ui.compareView.layout);
  const gpuReady = state.engine.gpuReady;
  const backend = state.engine.backend;
  const { canvasARef, canvasBRef, canvasCRef, renderHostRef, refreshQuadCellsRef } = refs;

  useEffect(() => {
    if (!quadActive || !gpuReady || backend !== 'webgpu') return;
    const host = renderHostRef.current;
    const canvasByCell = {
      a: canvasARef.current,
      b: canvasBRef.current,
      c: canvasCRef.current,
    } as const;

    const attached: string[] = [];
    for (const cell of ['a', 'b', 'c'] as const) {
      const canvas = canvasByCell[cell];
      if (!canvas) continue;
      host.attach(QUAD_SLOT_IDS[cell], canvas);
      attached.push(QUAD_SLOT_IDS[cell]);
    }

    refreshQuadCellsRef.current?.();

    return () => {
      for (const slot of attached) host.detach(slot);
    };
  }, [
    quadActive,
    gpuReady,
    backend,
    canvasARef,
    canvasBRef,
    canvasCRef,
    renderHostRef,
    refreshQuadCellsRef,
  ]);
}
