import { useEffect } from 'react';
import { isQuadCompareLayout } from '../engine/compareViews';
import type { ChromashiftRefs, ChromashiftStore } from './useChromashiftStore';

const QUAD_SLOT_IDS = {
  a: 'quad-a',
  b: 'quad-b',
  c: 'quad-c',
} as const;

/**
 * Lifecycle for quad layout stationary cells (Original, Layers, Tracer).
 *
 * Cell D (Composite) uses the primary orchestrator slot via useAppWebGPUInit.
 * Must run after useAppWebGPUInit so cleanup destroys quad slots before the device.
 */
export function useCompareQuadSlots(refs: ChromashiftRefs, store: ChromashiftStore): void {
  const { state } = store;
  const quadActive = isQuadCompareLayout(state.ui.compareView.layout);
  const gpuReady = state.engine.gpuReady;
  const backend = state.engine.backend;
  const {
    canvasARef,
    canvasBRef,
    canvasCRef,
    quadRenderersRef,
    orchestratorRef,
    sourceTextureRef,
    maskTextureRef,
    refreshQuadCellsRef,
  } = refs;

  useEffect(() => {
    if (!quadActive || !gpuReady || backend !== 'webgpu') return;
    const orchestrator = orchestratorRef.current;
    if (!orchestrator) return;

    const renderers = quadRenderersRef.current;

    const canvasByCell = {
      a: canvasARef.current,
      b: canvasBRef.current,
      c: canvasCRef.current,
    } as const;

    for (const cell of ['a', 'b', 'c'] as const) {
      const canvas = canvasByCell[cell];
      if (!canvas) continue;
      const slot = orchestrator.createSlot(QUAD_SLOT_IDS[cell], canvas);
      if (sourceTextureRef.current) slot.renderer.setTexture(sourceTextureRef.current);
      if (maskTextureRef.current) slot.renderer.setClassificationMaskTexture(maskTextureRef.current);
      renderers[cell] = slot.renderer;
    }

    refreshQuadCellsRef.current?.();

    return () => {
      for (const cell of ['a', 'b', 'c'] as const) {
        orchestrator.destroySlot(QUAD_SLOT_IDS[cell]);
      }
      renderers.a = null;
      renderers.b = null;
      renderers.c = null;
    };
  }, [
    quadActive,
    gpuReady,
    backend,
    canvasARef,
    canvasBRef,
    canvasCRef,
    quadRenderersRef,
    orchestratorRef,
    sourceTextureRef,
    maskTextureRef,
    refreshQuadCellsRef,
  ]);
}
