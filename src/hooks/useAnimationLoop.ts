import { useEffect, useRef } from 'react';
import { WebGPURenderer } from '../engine/WebGPURenderer';
import { GPU_TIMING_HISTORY_SIZE } from '../engine/GpuTimestampProfiler';
import { buildRendererState } from '../engine/buildRendererState';
import type { ChromashiftRefs, ChromashiftStore } from './useChromashiftStore';

const PREVIEW_TARGET_LIVE = 1;
const PREVIEW_TARGET_SEPARATED = 2;

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

        const renderOverrides = mod
          ? {
              tracerAboveIntensity: mod.tracerAboveIntensity,
              tracerBelowIntensity: mod.tracerBelowIntensity,
              avgLuminance: mod.avgLuminance,
            }
          : {};
        rendererRef.current?.render(buildRendererState(current, angles, renderOverrides));

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
    exportingVideo,
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
    reactiveModRef,
  ]);
}
