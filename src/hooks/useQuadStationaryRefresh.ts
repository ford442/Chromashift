import { useCallback, useEffect, useRef } from 'react';
import {
  effectiveLayerScaleForMultiView,
  isQuadCompareLayout,
  quadLayerMainViewMode,
} from '../engine/compareViews';
import { buildStationaryRendererState, quadStationaryFingerprint } from '../engine/stationaryPreview';
import type { RendererState } from '../engine/types/RendererState';
import { MAIN_VIEW_MODES } from '../engine/viewModes';
import type { ChromashiftState } from '../state/types';
import type { RenderCellRequest } from '../engine/render/protocol';
import type { ChromashiftRefs, ChromashiftStore } from './useChromashiftStore';
import { QUAD_SLOT_IDS } from './useCompareQuadSlots';

function quadRenderOverrides(state: ChromashiftState): Partial<RendererState> {
  const { scale: layerScale } = effectiveLayerScaleForMultiView(state.layers.scale, 'quad');
  const { scale: tracerScale } = effectiveLayerScaleForMultiView(state.tracers.scale, 'quad');
  return {
    layerScale,
    tracerScale,
    livePreviewEnabled: false,
    profilePerformance: false,
    viewportQuarterZoom: false,
    viewportHalfOverlay: false,
  };
}

/**
 * Refresh quad stationary cells (Original, Layers, Tracer) on settings fingerprint changes.
 * Cell D (Composite) is driven by useAnimationLoop.
 */
export function useQuadStationaryRefresh(refs: ChromashiftRefs, store: ChromashiftStore): void {
  const { state } = store;
  const { renderHostRef, renderStateRef, refreshQuadCellsRef } = refs;
  const lastFingerprintRef = useRef('');

  const refreshQuadCells = useCallback(() => {
    const current = renderStateRef.current;
    if (!current.engine.gpuReady || current.ui.exportingVideo) return;
    if (!isQuadCompareLayout(current.ui.compareView.layout)) return;

    // One message: the renderer draws each cell once with its own state; a
    // cell whose slot is not attached is skipped there.
    const fps = current.engine.fps;
    const overrides = quadRenderOverrides(current);
    const baseStationary = buildStationaryRendererState(current, overrides);
    const cells: RenderCellRequest[] = [
      {
        slot: QUAD_SLOT_IDS.a,
        fps,
        state: buildStationaryRendererState(current, { ...overrides, mainViewMode: MAIN_VIEW_MODES.SOURCE_IMAGE }),
      },
      {
        slot: QUAD_SLOT_IDS.b,
        fps,
        state: buildStationaryRendererState(current, {
          ...overrides,
          mainViewMode: quadLayerMainViewMode(current.ui.compareView.quadLayerIndex),
        }),
      },
      {
        slot: QUAD_SLOT_IDS.c,
        fps,
        warmup: baseStationary,
        state: {
          ...baseStationary,
          mainViewMode: MAIN_VIEW_MODES.FULL_RES_TRACER,
          showTracerView: true,
          paused: true,
        },
      },
    ];
    renderHostRef.current.renderCells(cells);
  }, [renderHostRef, renderStateRef]);

  useEffect(() => {
    refreshQuadCellsRef.current = refreshQuadCells;
    return () => {
      refreshQuadCellsRef.current = null;
    };
  }, [refreshQuadCellsRef, refreshQuadCells]);

  const quadActive = isQuadCompareLayout(state.ui.compareView.layout);
  const gpuReady = state.engine.gpuReady;
  const exportingVideo = state.ui.exportingVideo;
  const fingerprint = quadActive ? quadStationaryFingerprint(state) : '';

  useEffect(() => {
    if (!quadActive || !gpuReady || exportingVideo) return;
    if (fingerprint === lastFingerprintRef.current) return;
    lastFingerprintRef.current = fingerprint;
    refreshQuadCells();
  }, [quadActive, gpuReady, exportingVideo, fingerprint, refreshQuadCells]);

  useEffect(() => {
    if (quadActive && gpuReady && !exportingVideo) {
      lastFingerprintRef.current = '';
    }
  }, [quadActive, gpuReady, exportingVideo]);
}
