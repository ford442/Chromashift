import { useEffect, useRef } from 'react';
import { GPU_TIMING_HISTORY_SIZE } from '../engine/GpuTimestampProfiler';
import { buildRendererState } from '../engine/buildRendererState';
import { advanceAngles, effectiveLayerScaleForMultiView } from '../engine/compareViews';
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

        const angles: [number, number, number] = [
          (animAnglesRef.current[0] + extensions[0]) % 360,
          (animAnglesRef.current[1] + extensions[1]) % 360,
          (animAnglesRef.current[2] + extensions[2]) % 360,
        ];
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
        const dualActive = compareView.layout === 'dual' && rendererB !== null;
        if (dualActive) {
          renderOverrides.layerScale = effectiveLayerScaleForMultiView(current.layers.scale, 'dual').scale;
          renderOverrides.tracerScale = effectiveLayerScaleForMultiView(current.tracers.scale, 'dual').scale;
        }
        const xrImmersive = isXrImmersiveActive();
        if (!xrImmersive) {
          orchestratorRef.current?.reconfigureIfNeeded();
          rendererRef.current?.render(buildRendererState(current, angles, renderOverrides));
        }

        if (!xrImmersive && dualActive && rendererB) {
          const stateB = applySettingsToState(current, compareView.slotB.settings);
          const anglesB = compareView.syncPlay
            ? angles
            : (animAnglesBRef.current = advanceAngles(animAnglesBRef.current, stateB.layers.extensions));
          rendererB.render(buildRendererState(stateB, anglesB, {
            layerScale: effectiveLayerScaleForMultiView(stateB.layers.scale, 'dual').scale,
            tracerScale: effectiveLayerScaleForMultiView(stateB.tracers.scale, 'dual').scale,
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
