import { useCallback, useEffect, useRef } from 'react';
import {
  STATIONARY_PREVIEW_SIZE,
  buildStationaryRendererState,
  stationaryPreviewFingerprint,
} from '../engine/stationaryPreview';
import type { ChromashiftRefs, ChromashiftStore } from './useChromashiftStore';

const TRACER_REFRESH_INTERVAL_MS = 2000;

function blitPreviewPixels(
  data: Uint8ClampedArray<ArrayBuffer>,
  target: HTMLCanvasElement,
  scratch: HTMLCanvasElement,
  size: number,
): void {
  const sctx = scratch.getContext('2d');
  if (!sctx) return;
  sctx.putImageData(new ImageData(data, size, size), 0, 0);
  const dctx = target.getContext('2d');
  dctx?.drawImage(scratch, 0, 0, target.width, target.height);
}

export function useStationaryPreviews(refs: ChromashiftRefs, store: ChromashiftStore): void {
  const { state } = store;
  const {
    rendererRef,
    renderStateRef,
    previewSeparatedRef,
    previewTracerRef,
    overlaySeparatedRef,
    tracerScratchRef,
    capturePreviewAfterRender,
  } = refs;

  const lastFingerprintRef = useRef('');
  const refreshGenRef = useRef(0);
  const inFlightRef = useRef(false);

  const applyPreviewResult = useCallback((
    separated: Uint8ClampedArray<ArrayBuffer> | null,
    tracer: Uint8ClampedArray<ArrayBuffer> | null,
  ) => {
    const size = STATIONARY_PREVIEW_SIZE;
    let scratch = tracerScratchRef.current;
    if (!scratch) {
      scratch = document.createElement('canvas');
      scratch.width = size;
      scratch.height = size;
      tracerScratchRef.current = scratch;
    }

    const previewSep = previewSeparatedRef.current;
    if (separated && previewSep) {
      blitPreviewPixels(separated, previewSep, scratch, size);
      const current = renderStateRef.current;
      const overlayWantsSeparated = current.ui.referenceBlendMode !== 'hidden'
        && current.ui.overlayImageSource === 'separated';
      const overlaySep = overlaySeparatedRef.current;
      if (overlayWantsSeparated && overlaySep) {
        blitPreviewPixels(separated, overlaySep, scratch, size);
      }
    }

    const previewTr = previewTracerRef.current;
    if (tracer && previewTr) {
      blitPreviewPixels(tracer, previewTr, scratch, size);
    }
  }, [
    previewSeparatedRef,
    previewTracerRef,
    overlaySeparatedRef,
    tracerScratchRef,
    renderStateRef,
  ]);

  const refreshPreviews = useCallback(async (
    options: { separated?: boolean; tracer?: boolean } = {},
  ) => {
    const renderer = rendererRef.current;
    if (!renderer || inFlightRef.current) return;

    const wantSeparated = options.separated !== false;
    const wantTracer = options.tracer !== false;
    if (!wantSeparated && !wantTracer) return;

    const current = renderStateRef.current;
    if (!current.engine.gpuReady || current.ui.exportingVideo) return;

    const gen = ++refreshGenRef.current;
    inFlightRef.current = true;
    try {
      const previewState = buildStationaryRendererState(current);
      const result = await renderer.renderStationaryPreviews(previewState, {
        fps: current.engine.fps,
        separated: wantSeparated,
        tracer: wantTracer,
      });
      if (gen !== refreshGenRef.current) return;
      applyPreviewResult(result.separated, result.tracer);
    } catch (error) {
      console.warn('Stationary preview refresh failed:', error);
    } finally {
      inFlightRef.current = false;
    }
  }, [rendererRef, renderStateRef, applyPreviewResult]);

  const gpuReady = state.engine.gpuReady;
  const exportingVideo = state.ui.exportingVideo;
  const livePreviewEnabled = state.output.livePreviewEnabled;
  const tracerPreviewFrozen = state.output.tracerPreviewFrozen;
  const settingsFingerprint = stationaryPreviewFingerprint(state);

  useEffect(() => {
    if (!gpuReady || exportingVideo) return;

    const forced = capturePreviewAfterRender.current;
    if (forced) capturePreviewAfterRender.current = false;

    if (!forced && settingsFingerprint === lastFingerprintRef.current) return;
    lastFingerprintRef.current = settingsFingerprint;

    void refreshPreviews({ separated: true, tracer: true });
  }, [
    gpuReady,
    exportingVideo,
    settingsFingerprint,
    refreshPreviews,
    capturePreviewAfterRender,
  ]);

  useEffect(() => {
    if (!gpuReady || exportingVideo || !livePreviewEnabled || tracerPreviewFrozen) return;

    const interval = window.setInterval(() => {
      void refreshPreviews({ separated: false, tracer: true });
    }, TRACER_REFRESH_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [
    gpuReady,
    exportingVideo,
    livePreviewEnabled,
    tracerPreviewFrozen,
    refreshPreviews,
  ]);
}
