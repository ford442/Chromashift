import { useEffect, useRef } from 'react';
import { GPU_TIMING_HISTORY_SIZE } from '../engine/GpuTimestampProfiler';
import { buildRendererState } from '../engine/buildRendererState';
import { advanceAngles, effectiveLayerScaleForMultiView, isQuadCompareLayout, isTwoSlotCompareLayout } from '../engine/compareViews';
import { MAIN_VIEW_MODES } from '../engine/viewModes';
import { isXrImmersiveActive } from '../engine/xr/xrSupport';
import { applySettingsToState } from '../state/chromashiftReducer';
import type { ChromashiftRefs, ChromashiftStore } from './useChromashiftStore';

export function useAnimationLoop(refs: ChromashiftRefs, store: ChromashiftStore): void {
  const { state, actions } = store;
  const gpuReady = state.engine.gpuReady;
  const frameRate = state.engine.fps;
  const layerExtensions = state.layers.extensions;
  const exportingVideo = state.ui.exportingVideo;
  const autoDegradeAppliedRef = useRef(false);
  const frameHistoryRef = useRef<number[]>([]);
  const {
    animAnglesRef,
    animAnglesBRef,
    rendererBRef,
    lastAngleSyncRef,
    lastRenderMetricSyncRef,
    rendererRef,
    orchestratorRef,
    renderStateRef,
    reactiveModRef,
  } = refs;

  useEffect(() => {
    autoDegradeAppliedRef.current = false;
  }, [state.output.performanceAutoDegrade]);

  useEffect(() => {
    if (!state.output.performanceHudEnabled) {
      frameHistoryRef.current = [];
    }
  }, [state.output.performanceHudEnabled]);

  useEffect(() => {
    if (!gpuReady || exportingVideo) return;

    const msPerFrame = 1000 / frameRate;
    let last = performance.now();
    let animFrame: number | null = null;

    function loop(now: number) {
      const current = renderStateRef.current;
      if (current.ui.exportingVideo) {
        animFrame = requestAnimationFrame(loop);
        return;
      }

      const delta = now - last;
      if (delta >= msPerFrame) {
        last = now - (delta % msPerFrame);

        const mod = current.reactive.enabled ? reactiveModRef.current : null;
        const extensions = mod?.extensions ?? current.layers.extensions;
        const fps = current.engine.fps;
        const angles = advanceAngles(animAnglesRef.current, extensions, fps);
        animAnglesRef.current = angles;

        if (now - lastAngleSyncRef.current > 200) {
          lastAngleSyncRef.current = now;
          actions.setLayerAngles(angles);
        }

        const renderOverrides: Partial<import('../engine/types/RendererState').RendererState> = mod
          ? {
              tracerAboveIntensity: mod.tracerAboveIntensity,
              tracerBelowIntensity: mod.tracerBelowIntensity,
              avgLuminance: mod.avgLuminance,
            }
          : {};

        const compareView = current.ui.compareView;
        const rendererB = rendererBRef.current;
        const compareLayout = compareView.layout;
        const twoSlotActive = isTwoSlotCompareLayout(compareLayout) && rendererB !== null;
        const quadActive = isQuadCompareLayout(compareLayout);
        if (twoSlotActive || quadActive) {
          renderOverrides.layerScale = effectiveLayerScaleForMultiView(current.layers.scale, compareLayout).scale;
          renderOverrides.tracerScale = effectiveLayerScaleForMultiView(current.tracers.scale, compareLayout).scale;
        }
        if (quadActive) {
          renderOverrides.mainViewMode = MAIN_VIEW_MODES.PROCESSED_COMPOSITE;
          renderOverrides.showTracerView = false;
          renderOverrides.livePreviewEnabled = false;
          renderOverrides.profilePerformance = false;
        }
        const xrImmersive = isXrImmersiveActive();
        if (!xrImmersive) {
          orchestratorRef.current?.reconfigureIfNeeded();
          rendererRef.current?.render(buildRendererState(current, angles, renderOverrides));
        }

        if (!xrImmersive && twoSlotActive && rendererB) {
          const stateB = applySettingsToState(current, compareView.slotB.settings);
          const anglesB = compareView.syncPlay
            ? angles
            : (animAnglesBRef.current = advanceAngles(
                animAnglesBRef.current,
                stateB.layers.extensions,
                stateB.engine.fps,
              ));
          rendererB.render(buildRendererState(stateB, anglesB, {
            layerScale: effectiveLayerScaleForMultiView(stateB.layers.scale, compareLayout).scale,
            tracerScale: effectiveLayerScaleForMultiView(stateB.tracers.scale, compareLayout).scale,
            livePreviewEnabled: false,
            profilePerformance: false,
          }));
        }

        if (now - lastRenderMetricSyncRef.current > 200) {
          lastRenderMetricSyncRef.current = now;
          const timing = rendererRef.current?.getRenderTiming();
          if (timing) {
            actions.setRenderCpuTiming({ last: timing.lastCpuMs, avg: timing.averageCpuMs });
            actions.setRenderGpuTiming(timing.gpu);

            if (current.output.performanceHudEnabled) {
              const gpuTotal = timing.gpu.last?.totalGpuMs ?? 0;
              const frameMs = Math.max(timing.lastCpuMs, gpuTotal);
              frameHistoryRef.current.push(frameMs);
              if (frameHistoryRef.current.length > GPU_TIMING_HISTORY_SIZE) {
                frameHistoryRef.current.shift();
              }
              actions.setFrameTimeHistory([...frameHistoryRef.current]);

              const budgetMs = 1000 / current.engine.fps;
              const overBudget = frameMs > budgetMs;
              actions.setPerformanceBudgetExceeded(overBudget);

              if (
                overBudget
                && current.output.performanceAutoDegrade
                && !autoDegradeAppliedRef.current
              ) {
                autoDegradeAppliedRef.current = true;
                rendererRef.current?.setAntialiasing(false);
                actions.applyPerformanceDegrade();
              }
            }
          }
        }
      }

      animFrame = requestAnimationFrame(loop);
    }

    animFrame = requestAnimationFrame(loop);
    return () => {
      if (animFrame !== null) cancelAnimationFrame(animFrame);
    };
  }, [
    actions,
    gpuReady,
    frameRate,
    layerExtensions,
    exportingVideo,
    animAnglesRef,
    animAnglesBRef,
    rendererBRef,
    lastAngleSyncRef,
    lastRenderMetricSyncRef,
    rendererRef,
    orchestratorRef,
    renderStateRef,
    reactiveModRef,
  ]);
}
