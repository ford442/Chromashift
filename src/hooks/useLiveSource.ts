import { useCallback, useEffect, useRef } from 'react';
import { computeVideoAverageLuminance, LiveSourceManager, type LiveSourceKind } from '../engine/LiveSource';
import { publishLiveSourceBreadcrumbs } from '../engine/liveSourceBreadcrumbs';
import { LIVE_SOURCE_CACHE_KEY } from '../engine/liveSourceTexture';
import { applySourceTexture, type ChromashiftRefs, type ChromashiftStore } from './useChromashiftStore';

/** How often to resample average luminance from the live frame (ms). */
const ANALYSIS_INTERVAL_MS = 1000;

export interface LiveSourceHandlers {
  handleStartCamera: () => Promise<void>;
  handleStartScreenShare: () => Promise<void>;
  handleLoadVideoFile: (file: File) => Promise<void>;
  handleStopLiveSource: () => void;
}

/**
 * Owns a `LiveSourceManager` and wires it to `media.liveSource` state plus a
 * dedicated per-frame upload loop (mirrors `useReactiveInput`'s own
 * `requestAnimationFrame` loop rather than reusing `useAnimationLoop`, so a
 * live source works whether or not the render loop happens to be running).
 * Texture upload is throttled to the display's refresh rate; luminance
 * analysis is throttled further to `ANALYSIS_INTERVAL_MS`.
 */
export function useLiveSource(refs: ChromashiftRefs, store: ChromashiftStore): LiveSourceHandlers {
  const { state, actions } = store;
  const { liveSourceManagerRef, textureManagerRef, rendererRef, engineModeRef, renderStateRef } = refs;
  const liveSource = state.media.liveSource;

  // `refs` (the composed bundle) gets a new object identity every App render
  // even though its individual ref objects are stable — mirror it into a
  // stable ref so the tick effect below doesn't need `refs` itself in its
  // dependency array (which would restart the rAF loop on every render, as
  // `useAnimationLoop`/`useReactiveInput` avoid by depending on individual
  // refs instead of the whole bundle).
  const refsRef = useRef(refs);
  refsRef.current = refs;

  const ensureManager = useCallback((): LiveSourceManager => {
    liveSourceManagerRef.current ??= new LiveSourceManager(() => {
      actions.setLiveSource({ active: false, kind: null, error: null });
    });
    return liveSourceManagerRef.current;
  }, [liveSourceManagerRef, actions]);

  const activate = useCallback((kind: LiveSourceKind, label: string) => {
    rendererRef.current?.clearPersistence();
    const size = liveSourceManagerRef.current?.frameSize;
    actions.setLiveSource({
      active: true,
      kind,
      label,
      error: null,
      width: size?.width ?? 0,
      height: size?.height ?? 0,
    });
  }, [actions, liveSourceManagerRef, rendererRef]);

  const fail = useCallback((e: unknown, fallback: string) => {
    actions.setLiveSource({
      active: false,
      kind: null,
      error: e instanceof Error ? e.message : fallback,
    });
  }, [actions]);

  const handleStartCamera = useCallback(async () => {
    try {
      const { label } = await ensureManager().startCamera();
      activate('camera', label);
    } catch (e) {
      fail(e, 'Camera permission denied');
    }
  }, [ensureManager, activate, fail]);

  const handleStartScreenShare = useCallback(async () => {
    try {
      const { label } = await ensureManager().startScreenShare();
      activate('screen', label);
    } catch (e) {
      fail(e, 'Screen share cancelled');
    }
  }, [ensureManager, activate, fail]);

  const handleLoadVideoFile = useCallback(async (file: File) => {
    try {
      const { label } = await ensureManager().loadVideoFile(file);
      activate('video-file', label);
    } catch (e) {
      fail(e, 'Failed to load video file');
    }
  }, [ensureManager, activate, fail]);

  const handleStopLiveSource = useCallback(() => {
    liveSourceManagerRef.current?.stop();
    textureManagerRef.current?.releaseVideoTexture(LIVE_SOURCE_CACHE_KEY);
    actions.setLiveSource({ active: false, kind: null, label: null, width: 0, height: 0, error: null });
  }, [liveSourceManagerRef, textureManagerRef, actions]);

  // Tear down capture on unmount (route change, HMR, etc).
  useEffect(() => () => {
    liveSourceManagerRef.current?.stop();
  }, [liveSourceManagerRef]);

  // Per-frame texture upload + throttled luminance analysis while active.
  const lastAnalysisRef = useRef(0);
  const frameCountRef = useRef(0);
  const lastFpsSyncRef = useRef(0);
  useEffect(() => {
    if (!liveSource.active) {
      publishLiveSourceBreadcrumbs(false, null, 0);
      return;
    }

    let raf = 0;
    lastAnalysisRef.current = 0;
    frameCountRef.current = 0;
    lastFpsSyncRef.current = performance.now();
    // Publish immediately so `window.liveSourceActive` flips the instant
    // activation happens, rather than waiting for the first 1s FPS window.
    publishLiveSourceBreadcrumbs(true, liveSourceManagerRef.current?.kind ?? null, 0);

    const tick = (now: number) => {
      const manager = liveSourceManagerRef.current;
      const textureManager = textureManagerRef.current;
      if (manager?.active && textureManager) {
        const handle = textureManager.updateVideoTexture(LIVE_SOURCE_CACHE_KEY, manager.element);
        if (handle) {
          applySourceTexture(refsRef.current, handle);
          frameCountRef.current += 1;

          const size = manager.frameSize;
          const current = renderStateRef.current.media.liveSource;
          if (size && (current.width !== size.width || current.height !== size.height)) {
            actions.setLiveSource({ width: size.width, height: size.height });
          }

          if (now - lastAnalysisRef.current >= ANALYSIS_INTERVAL_MS) {
            lastAnalysisRef.current = now;
            const avgLum = computeVideoAverageLuminance(manager.element, engineModeRef.current === 'wasm');
            actions.setAvgLuminance(Math.round(avgLum));
          }
        }
      }

      if (now - lastFpsSyncRef.current >= 1000) {
        const elapsedSec = (now - lastFpsSyncRef.current) / 1000;
        publishLiveSourceBreadcrumbs(true, manager?.kind ?? null, Math.round(frameCountRef.current / elapsedSec));
        frameCountRef.current = 0;
        lastFpsSyncRef.current = now;
      }

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [liveSource.active, actions, liveSourceManagerRef, textureManagerRef, engineModeRef, renderStateRef]);

  return { handleStartCamera, handleStartScreenShare, handleLoadVideoFile, handleStopLiveSource };
}
