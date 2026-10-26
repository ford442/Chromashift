import { useEffect, useRef } from 'react';
import { GPU_TIMING_HISTORY_SIZE } from '../engine/webgpu/GpuTimestampProfiler';
import { buildRendererState } from '../engine/buildRendererState';
import { advanceAngles, effectiveLayerScaleForMultiView, isQuadCompareLayout, isTwoSlotCompareLayout } from '../engine/compareViews';
import { renderTelemetry } from '../engine/telemetryStore';
import { MAIN_VIEW_MODES } from '../engine/viewModes';
import { isXrImmersiveActive } from '../engine/xr/xrSupport';
import { applySettingsToState } from '../state/chromashiftReducer';
import type { ReactiveModulation } from '../engine/reactive/types';
import type { ChromashiftRefs, ChromashiftStore } from './useChromashiftStore';

export function useAnimationLoop(refs: ChromashiftRefs, store: ChromashiftStore): void {
  const { state, actions } = store;
  const gpuReady = state.engine.gpuReady;
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
    frameClockRef,
  } = refs;

  useEffect(() => {
    autoDegradeAppliedRef.current = false;
  }, [state.output.performanceAutoDegrade]);

  useEffect(() => {
    if (!state.output.performanceHudEnabled) {
      frameHistoryRef.current = [];
      renderTelemetry.setFrameTimeHistory([]);
    }
  }, [state.output.performanceHudEnabled]);

  useEffect(() => {
    if (!gpuReady || exportingVideo) return;
    const clock = frameClockRef.current;

    // What `modulate` decided for this tick, for `render` and `telemetry` to use.
    let last: number | null = null;
    let due = false;
    let angles = animAnglesRef.current;
    let mod: ReactiveModulation | null = null;

    // modulate: is a frame due at the session fps, and where are the layers?
    const unregisterModulate = clock.register('modulate', ({ now }) => {
      const current = renderStateRef.current;
      due = false;
      if (current.ui.exportingVideo) return;

      const msPerFrame = 1000 / current.engine.fps;
      // The first tick renders: `now - (now - msPerFrame)` can round to a hair
      // under a frame, so compute it rather than seeding `last` with it.
      const delta = last === null ? msPerFrame : now - last;
      if (delta < msPerFrame) return;
      last = now - (delta % msPerFrame);
      due = true;

      // Written by reactive input's `input` task, so it is this tick's.
      mod = current.reactive.enabled ? reactiveModRef.current : null;
      const extensions = mod?.extensions ?? current.layers.extensions;
      angles = advanceAngles(animAnglesRef.current, extensions, current.engine.fps);
      animAnglesRef.current = angles;
    }, 'animation-angles');

    const unregisterRender = clock.register('render', () => {
      if (!due) return;
      const current = renderStateRef.current;
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
      // While immersive, the headset is the output: `useWebXr` registers its own render task.
      if (isXrImmersiveActive()) return;

      orchestratorRef.current?.reconfigureIfNeeded();
      rendererRef.current?.render(buildRendererState(current, angles, renderOverrides, 'main'));

      if (twoSlotActive && rendererB) {
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
        }, 'compareB'));
      }
    }, 'main-render');

    const unregisterTelemetry = clock.register('telemetry', ({ now }) => {
      if (!due) return;
      const current = renderStateRef.current;
      if (now - lastAngleSyncRef.current > 200) {
        lastAngleSyncRef.current = now;
        renderTelemetry.setAngles(angles);
      }

      if (now - lastRenderMetricSyncRef.current <= 200) return;
      lastRenderMetricSyncRef.current = now;
      const timing = rendererRef.current?.getRenderTiming();
      if (!timing) return;
      renderTelemetry.setRenderCpuTiming({ last: timing.lastCpuMs, avg: timing.averageCpuMs });
      renderTelemetry.setRenderGpuTiming(timing.gpu);
      if (!current.output.performanceHudEnabled) return;

      const gpuTotal = timing.gpu.last?.totalGpuMs ?? 0;
      const frameMs = Math.max(timing.lastCpuMs, gpuTotal);
      frameHistoryRef.current.push(frameMs);
      if (frameHistoryRef.current.length > GPU_TIMING_HISTORY_SIZE) {
        frameHistoryRef.current.shift();
      }
      renderTelemetry.setFrameTimeHistory([...frameHistoryRef.current]);

      const budgetMs = 1000 / current.engine.fps;
      const overBudget = frameMs > budgetMs;
      renderTelemetry.setPerformanceBudgetExceeded(overBudget);

      if (overBudget && current.output.performanceAutoDegrade && !autoDegradeAppliedRef.current) {
        autoDegradeAppliedRef.current = true;
        rendererRef.current?.setAntialiasing(false);
        actions.applyPerformanceDegrade();
      }
    }, 'render-telemetry');

    return () => {
      unregisterModulate();
      unregisterRender();
      unregisterTelemetry();
    };
  }, [
    actions,
    gpuReady,
    exportingVideo,
    frameClockRef,
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
