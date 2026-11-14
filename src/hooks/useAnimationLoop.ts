import { useEffect } from 'react';
import { buildRendererState } from '../engine/buildRendererState';
import { effectiveLayerScaleForMultiView, isTwoSlotCompareLayout } from '../engine/compareViews';
import type { RenderLoopInput } from '../engine/render/protocol';
import { renderTelemetry } from '../engine/telemetryStore';
import { applySettingsToState } from '../state/chromashiftReducer';
import type { ChromashiftState } from '../state/types';
import type { ChromashiftRefs, ChromashiftStore } from './useChromashiftStore';

/**
 * What the live loop draws, from the store: the main canvas's frame and
 * compare slot B's, built here with every override that does not depend on
 * the tick. The render service writes the angles (and the reactive and
 * multi-view overrides) each frame (`engine/render/RenderService.ts`).
 */
function buildRenderLoopInput(state: ChromashiftState, running: boolean): RenderLoopInput {
  const compareView = state.ui.compareView;
  const layout = compareView.layout;
  let compareB: RenderLoopInput['compareB'] = null;
  if (isTwoSlotCompareLayout(layout)) {
    const stateB = applySettingsToState(state, compareView.slotB.settings);
    compareB = {
      state: buildRendererState(stateB, stateB.layers.angles, {
        layerScale: effectiveLayerScaleForMultiView(stateB.layers.scale, layout).scale,
        tracerScale: effectiveLayerScaleForMultiView(stateB.tracers.scale, layout).scale,
        livePreviewEnabled: false,
        profilePerformance: false,
      }),
      extensions: stateB.layers.extensions,
      fps: stateB.engine.fps,
      syncPlay: compareView.syncPlay,
    };
  }
  return {
    running,
    fps: state.engine.fps,
    extensions: state.layers.extensions,
    reactive: state.reactive.enabled,
    main: buildRendererState(state, state.layers.angles),
    layout,
    compareB,
    hud: { enabled: state.output.performanceHudEnabled, autoDegrade: state.output.performanceAutoDegrade },
  };
}

/**
 * The page's half of the render loop. The loop itself — the angle clock, the
 * main and compare-B draws, the timings — runs in the render service on its
 * own clock (`animation-angles` / `main-render` / `render-telemetry`). This
 * hook tells it what to draw on every store change, forwards reactive input
 * each page frame, and brings its telemetry back into `renderTelemetry` and
 * its auto-degrade back into the store.
 */
export function useAnimationLoop(refs: ChromashiftRefs, store: ChromashiftStore): void {
  const { state, actions } = store;
  const running = state.engine.gpuReady && !state.ui.exportingVideo;
  const reactiveEnabled = state.reactive.enabled;
  const { renderHostRef, reactiveModRef, frameClockRef } = refs;

  useEffect(() => {
    renderHostRef.current.setLoop(buildRenderLoopInput(state, running));
  }, [renderHostRef, state, running]);

  // Unmounted: nothing draws until a loop owner asks again.
  useEffect(() => {
    const host = renderHostRef.current;
    return () => host.stopLoop();
  }, [renderHostRef]);

  useEffect(() => {
    if (!state.output.performanceHudEnabled) renderTelemetry.setFrameTimeHistory([]);
  }, [state.output.performanceHudEnabled]);

  useEffect(() => {
    const host = renderHostRef.current;
    const offTelemetry = host.on('telemetry', (telemetry) => {
      if (telemetry.angles) renderTelemetry.setAngles(telemetry.angles);
      if (telemetry.cpu) renderTelemetry.setRenderCpuTiming(telemetry.cpu);
      if (telemetry.gpu) renderTelemetry.setRenderGpuTiming(telemetry.gpu);
      if (telemetry.frameHistory) renderTelemetry.setFrameTimeHistory(telemetry.frameHistory);
      if (telemetry.overBudget !== undefined) renderTelemetry.setPerformanceBudgetExceeded(telemetry.overBudget);
    });
    const offDegrade = host.on('perf-degrade', () => actions.applyPerformanceDegrade());
    return () => {
      offTelemetry();
      offDegrade();
    };
  }, [renderHostRef, actions]);

  // sources: hand this frame's reactive modulation (written by the `input`
  // phase) to the renderer before its `modulate` reads it. In-process it
  // lands at once; the render worker keeps the latest it was sent.
  useEffect(() => {
    if (!running || !reactiveEnabled) return;
    const host = renderHostRef.current;
    const unregister = frameClockRef.current.register('sources', () => {
      host.setModulation(reactiveModRef.current);
    }, 'reactive-forward');
    return () => {
      unregister();
      host.setModulation(null);
    };
  }, [running, reactiveEnabled, renderHostRef, frameClockRef, reactiveModRef]);
}
