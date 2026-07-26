import { useCallback, useEffect, useRef } from 'react';
import {
  effectiveLayerScaleForMultiView,
  isQuadCompareLayout,
  quadLayerMainViewMode,
} from '../engine/compareViews';
import {
  buildStationaryRendererState,
  quadStationaryFingerprint,
  warmupTracerPersistence,
} from '../engine/stationaryPreview';
import type { RendererState } from '../engine/types/RendererState';
import { MAIN_VIEW_MODES } from '../engine/viewModes';
import type { ChromashiftState } from '../state/types';
import type { ChromashiftRefs, ChromashiftStore } from './useChromashiftStore';

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
  const { quadRenderersRef, renderStateRef, refreshQuadCellsRef } = refs;
  const lastFingerprintRef = useRef('');
  const refreshGenRef = useRef(0);
  const inFlightRef = useRef(false);

  const refreshQuadCells = useCallback(() => {
    const current = renderStateRef.current;
    if (!current.engine.gpuReady || current.ui.exportingVideo) return;
    if (!isQuadCompareLayout(current.ui.compareView.layout)) return;

    const quad = quadRenderersRef.current;
    if (!quad.a && !quad.b && !quad.c) return;
    if (inFlightRef.current) return;

    const gen = ++refreshGenRef.current;
    inFlightRef.current = true;
    try {
      const fps = current.engine.fps;
      const overrides = quadRenderOverrides(current);
      const baseStationary = buildStationaryRendererState(current, overrides);

      if (quad.a) {
        quad.a.render(buildStationaryRendererState(current, {
          ...overrides,
          mainViewMode: MAIN_VIEW_MODES.SOURCE_IMAGE,
        }), fps);
      }

      if (quad.b) {
        const layerMode = quadLayerMainViewMode(current.ui.compareView.quadLayerIndex);
        quad.b.render(buildStationaryRendererState(current, {
          ...overrides,
          mainViewMode: layerMode,
        }), fps);
      }

      if (quad.c) {
        warmupTracerPersistence(quad.c, baseStationary, fps);
        if (gen !== refreshGenRef.current) return;
        quad.c.render({
          ...baseStationary,
          mainViewMode: MAIN_VIEW_MODES.FULL_RES_TRACER,
          showTracerView: true,
          paused: true,
        }, fps);
      }
    } catch (error) {
      console.warn('Quad stationary refresh failed:', error);
    } finally {
      inFlightRef.current = false;
    }
  }, [quadRenderersRef, renderStateRef]);

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
