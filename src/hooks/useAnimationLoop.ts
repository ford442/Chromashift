import { useEffect } from 'react';
import { WebGPURenderer } from '../engine/WebGPURenderer';
import { MAIN_VIEW_MODES } from '../engine/viewModes';
import type { RendererState } from '../engine/types/RendererState';
import type { ChromashiftRefs, ChromashiftStore } from './useChromashiftStore';

const PREVIEW_TARGET_LIVE = 1;
const PREVIEW_TARGET_SEPARATED = 2;

function buildRendererState(store: ChromashiftStore, angles: [number, number, number]): RendererState {
  const { state } = store;
  const { layers, tracers, output, engine } = state;
  const isViewingTracer = output.mainViewMode === MAIN_VIEW_MODES.FULL_RES_TRACER;
  const inspect = output.tracerInspect;

  return {
    layers: [
      { angleDeg: angles[0], flipX: false, flipY: false },
      { angleDeg: angles[1], flipX: false, flipY: true },
      { angleDeg: angles[2], flipX: false, flipY: false },
    ],
    avgLuminance: engine.avgLuminance,
    layerOpacity: layers.opacity,
    layerOpacities: layers.opacities,
    layerScale: layers.scale,
    tracerScale: tracers.scale,
    tracerAboveIntensity: tracers.aboveIntensity,
    tracerBelowIntensity: tracers.belowIntensity,
    tracerAboveDuration: tracers.aboveDuration * (60 / engine.fps),
    tracerBelowDuration: tracers.belowDuration * (60 / engine.fps),
    tracerMode: tracers.mode,
    colorMode: layers.colorMode,
    sobelEnabled: layers.sobelEnabled,
    softCropEnabled: layers.softCropEnabled,
    layerBlendMode: tracers.layerBlendMode,
    tracerBlendMode: tracers.tracerBlendMode,
    outputMode: output.outputMode,
    paused: engine.paused,
    mainViewMode: output.mainViewMode,
    showTracerView: isViewingTracer,
    tracerInspectZoom: inspect.zoom,
    tracerInspectPanX: inspect.pan.x,
    tracerInspectPanY: inspect.pan.y,
    tracerInspectHeatmap: inspect.heatmap,
    tracerInspectExposure: inspect.exposure,
    tracerInspectTonemap: inspect.tonemap,
    tracerInspectShowLayers: inspect.showLayers,
    diagnosticsMode: output.diagnosticsMode,
    diagnosticsOpacity: output.diagnosticsOpacity,
    stampBoost: output.stampBoost,
    peakCollisionsOnly: output.peakCollisionsOnly,
    webglDebugMode: output.webglDebugMode,
    viewportQuarterZoom: output.viewportQuarterZoom,
    viewportHalfOverlay: output.viewportHalfOverlay,
    halfOverlayAlpha: 0.5,
  };
}

export function useAnimationLoop(refs: ChromashiftRefs, store: ChromashiftStore): void {
  const { state, actions } = store;
  const gpuReady = state.engine.gpuReady;
  const frameRate = state.engine.fps;
  const layerExtensions = state.layers.extensions;
  const {
    animAnglesRef,
    lastAngleSyncRef,
    lastRenderMetricSyncRef,
    rendererRef,
    renderStateRef,
    capturePreviewAfterRender,
    pendingPreviewTargetsRef,
    lastReadbackMsRef,
    canvasRef,
    previewSeparatedRef,
    tracerScratchRef,
  } = refs;

  useEffect(() => {
    if (!gpuReady) return;

    const msPerFrame = 1000 / frameRate;
    let last = performance.now();
    let animFrame: number | null = null;

    function loop(now: number) {
      const current = renderStateRef.current;
      const delta = now - last;
      if (delta >= msPerFrame) {
        last = now - (delta % msPerFrame);

        const angles: [number, number, number] = [
          (animAnglesRef.current[0] + current.layers.extensions[0]) % 360,
          (animAnglesRef.current[1] + current.layers.extensions[1]) % 360,
          (animAnglesRef.current[2] + current.layers.extensions[2]) % 360,
        ];
        animAnglesRef.current = angles;

        if (now - lastAngleSyncRef.current > 200) {
          lastAngleSyncRef.current = now;
          actions.setLayerAngles(angles);
        }

        rendererRef.current?.render(buildRendererState(store, angles));

        if (now - lastRenderMetricSyncRef.current > 500) {
          lastRenderMetricSyncRef.current = now;
          const timing = rendererRef.current?.getRenderTiming();
          if (timing) {
            actions.setRenderCpuTiming({ last: timing.lastCpuMs, avg: timing.averageCpuMs });
          }
        }

        if (capturePreviewAfterRender.current) {
          pendingPreviewTargetsRef.current |= PREVIEW_TARGET_SEPARATED;
          capturePreviewAfterRender.current = false;
        }

        const readbackIntervalMs = 1000 / 5;
        const wantLiveReadback = current.output.livePreviewEnabled
          && !current.output.tracerPreviewFrozen
          && (now - lastReadbackMsRef.current >= readbackIntervalMs);
        if (wantLiveReadback) {
          lastReadbackMsRef.current = now;
          pendingPreviewTargetsRef.current |= PREVIEW_TARGET_LIVE;
        }

        if (pendingPreviewTargetsRef.current !== 0 && rendererRef.current) {
          const captureTargets = pendingPreviewTargetsRef.current;
          const thumbCanvas = canvasRef.current;
          const previewSep = previewSeparatedRef.current;
          const sz = WebGPURenderer.PREVIEW_SIZE;
          const queued = rendererRef.current.requestPreviewReadback((data) => {
            let scratch = tracerScratchRef.current;
            if (!scratch) {
              scratch = document.createElement('canvas');
              scratch.width = sz;
              scratch.height = sz;
              tracerScratchRef.current = scratch;
            }
            const sctx = scratch.getContext('2d');
            if (!sctx) return;
            sctx.putImageData(new ImageData(data, sz, sz), 0, 0);

            if ((captureTargets & PREVIEW_TARGET_LIVE) !== 0 && thumbCanvas) {
              const dctx = thumbCanvas.getContext('2d');
              dctx?.drawImage(scratch, 0, 0, thumbCanvas.width, thumbCanvas.height);
            }
            if ((captureTargets & PREVIEW_TARGET_SEPARATED) !== 0 && previewSep) {
              const dctx = previewSep.getContext('2d');
              dctx?.drawImage(scratch, 0, 0, previewSep.width, previewSep.height);
            }
          });
          if (queued) pendingPreviewTargetsRef.current = 0;
        }
      }

      animFrame = requestAnimationFrame(loop);
    }

    animFrame = requestAnimationFrame(loop);
    return () => {
      if (animFrame !== null) cancelAnimationFrame(animFrame);
    };
  }, [
    store,
    actions,
    gpuReady,
    frameRate,
    layerExtensions,
    animAnglesRef,
    lastAngleSyncRef,
    lastRenderMetricSyncRef,
    rendererRef,
    renderStateRef,
    capturePreviewAfterRender,
    pendingPreviewTargetsRef,
    lastReadbackMsRef,
    canvasRef,
    previewSeparatedRef,
    tracerScratchRef,
  ]);
}
