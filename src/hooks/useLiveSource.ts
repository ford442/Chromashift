import { useCallback, useEffect, useRef } from 'react';
import type { FrameTick } from '../engine/frame/FrameClock';
import { computeVideoAverageLuminance, LiveSourceManager, type LiveSourceKind } from '../engine/live/LiveSource';
import { publishLiveSourceBreadcrumbs } from '../engine/live/liveSourceBreadcrumbs';
import { createChromashiftCpuHost } from '../engine/compute/chores/chromashiftHost';
import {
  publishMotionFieldBreadcrumbs,
  publishMotionFieldEnergy,
  publishMotionFieldFlow,
  publishMotionFieldHasFlow,
} from '../engine/compute/chores';
import { LiveMotionSampler } from '../engine/live/liveMotionField';
import type { ChromashiftRefs, ChromashiftStore } from './useChromashiftStore';

/** How often to resample average luminance from the live frame (ms). */
const ANALYSIS_INTERVAL_MS = 1000;

/**
 * How often the WebGL backend resamples the motion field (ms).
 *
 * The field is a *tracer* input, not a display frame: a trail that holds for
 * hundreds of milliseconds does not need a fresh difference 60 times a second,
 * and the CPU lane's `getImageData` is the one part of this loop that is not
 * free. WebGPU is unaffected — there the field is a compute dispatch inside
 * the frame's own encoder, every frame.
 */
const MOTION_INTERVAL_MS = 66;

export interface LiveSourceHandlers {
  handleStartCamera: () => Promise<void>;
  handleStartScreenShare: () => Promise<void>;
  handleLoadVideoFile: (file: File) => Promise<void>;
  handleStopLiveSource: () => void;
}

/**
 * Owns a `LiveSourceManager` and wires it to `media.liveSource` state plus a
 * per-frame upload task in the frame clock's `sources` phase — registered only
 * while a source is active, and independent of the render loop's tasks.
 * Texture upload is throttled to the display's refresh rate; luminance
 * analysis is throttled further to `ANALYSIS_INTERVAL_MS`.
 */
export function useLiveSource(refs: ChromashiftRefs, store: ChromashiftStore): LiveSourceHandlers {
  const { state, actions } = store;
  const {
    liveSourceManagerRef, renderHostRef, engineModeRef, renderStateRef, frameClockRef,
  } = refs;
  const liveSource = state.media.liveSource;

  const ensureManager = useCallback((): LiveSourceManager => {
    liveSourceManagerRef.current ??= new LiveSourceManager(() => {
      actions.setLiveSource({ active: false, kind: null, error: null });
    });
    return liveSourceManagerRef.current;
  }, [liveSourceManagerRef, actions]);

  const activate = useCallback((kind: LiveSourceKind, label: string) => {
    renderHostRef.current.clearPersistence();
    const size = liveSourceManagerRef.current?.frameSize;
    actions.setLiveSource({
      active: true,
      kind,
      label,
      error: null,
      width: size?.width ?? 0,
      height: size?.height ?? 0,
    });
  }, [actions, liveSourceManagerRef, renderHostRef]);

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
    renderHostRef.current.releaseVideo();
    actions.setLiveSource({ active: false, kind: null, label: null, width: 0, height: 0, error: null });
  }, [liveSourceManagerRef, renderHostRef, actions]);

  // Tear down capture on unmount (route change, HMR, etc).
  useEffect(() => () => {
    liveSourceManagerRef.current?.stop();
  }, [liveSourceManagerRef]);

  // Per-frame texture upload + throttled luminance analysis while active.
  const lastAnalysisRef = useRef(0);
  const frameCountRef = useRef(0);
  const lastFpsSyncRef = useRef(0);
  // WebGL has no compute lane, so the motion field is sampled here from the
  // video element and handed to the renderer. On WebGPU the renderer runs the
  // `motion-field` chore's GPU lane itself, and this sampler is constructed
  // only when that lane declines (`?no_gpu_compute`) — the renderer says so
  // in its `motion-demand` event (`host.motionDemand`).
  const motionSamplerRef = useRef<LiveMotionSampler | null>(null);
  const lastMotionAtRef = useRef(0);
  useEffect(() => {
    if (!liveSource.active) {
      publishLiveSourceBreadcrumbs(false, null, 0);
      return;
    }

    const clock = frameClockRef.current;
    lastAnalysisRef.current = 0;
    frameCountRef.current = 0;
    lastFpsSyncRef.current = performance.now();
    // Publish immediately so `window.liveSourceActive` flips the instant
    // activation happens, rather than waiting for the first 1s FPS window.
    publishLiveSourceBreadcrumbs(true, liveSourceManagerRef.current?.kind ?? null, 0);

    /**
     * Refresh the CPU-lane motion field (WebGL, or WebGPU when its GPU lane declines). A no-op with
     * `motionMode: 'off'` — nothing is sampled, nothing is uploaded, and the
     * persistence pass keeps running the pre-motion program.
     */
    const sampleMotion = (now: number, element: HTMLVideoElement) => {
      const host = renderHostRef.current;
      const demand = host.motionDemand;
      const { tracers } = renderStateRef.current;
      if (!demand.wantsCpu) {
        // The renderer's GPU lane is serving the field (and its breadcrumbs).
        if (motionSamplerRef.current) {
          motionSamplerRef.current.destroy();
          motionSamplerRef.current = null;
          host.setMotionField(null);
        }
        return;
      }
      // A graph that steers by the field (`?graph=smear`'s `displace`) wants it
      // — and its flow — whatever the motion mode.
      const graphUse = demand.use;
      if (tracers.motionMode === 'off' && !graphUse.reads) {
        if (motionSamplerRef.current) {
          motionSamplerRef.current.destroy();
          motionSamplerRef.current = null;
          host.setMotionField(null);
          publishMotionFieldBreadcrumbs(null, 'motionMode is off');
          publishMotionFieldEnergy(0);
          publishMotionFieldHasFlow(false);
          publishMotionFieldFlow(null);
        }
        return;
      }

      if (now - lastMotionAtRef.current < MOTION_INTERVAL_MS) return;
      lastMotionAtRef.current = now;

      motionSamplerRef.current ??= new LiveMotionSampler(
        createChromashiftCpuHost(() => engineModeRef.current === 'wasm'),
      );
      // Only `direction` (and a graph steering by the flow) reads the vector,
      // so only they pay for the Lucas–Kanade solve behind it.
      const wantFlow = tracers.motionMode === 'direction' || graphUse.needsFlow;
      void motionSamplerRef.current.sample(element, tracers.motionThreshold, wantFlow)
        .then((output) => {
          host.setMotionField(output);
        });
    };

    // sources: upload this frame's video before `modulate` / `render` read it.
    const upload = ({ now }: FrameTick) => {
      const manager = liveSourceManagerRef.current;
      if (manager?.active) {
        if (renderHostRef.current.uploadVideo(manager.element)) {
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

          sampleMotion(now, manager.element);
        }
      }

      if (now - lastFpsSyncRef.current >= 1000) {
        const elapsedSec = (now - lastFpsSyncRef.current) / 1000;
        publishLiveSourceBreadcrumbs(true, manager?.kind ?? null, Math.round(frameCountRef.current / elapsedSec));
        frameCountRef.current = 0;
        lastFpsSyncRef.current = now;
      }
    };

    const unregister = clock.register('sources', upload, 'live-source-upload');
    return () => {
      unregister();
      motionSamplerRef.current?.destroy();
      motionSamplerRef.current = null;
      lastMotionAtRef.current = 0;
      publishMotionFieldBreadcrumbs(null, 'No live source');
      publishMotionFieldEnergy(0);
      publishMotionFieldHasFlow(false);
      publishMotionFieldFlow(null);
    };
  }, [
    liveSource.active, actions, liveSourceManagerRef, renderHostRef,
    engineModeRef, renderStateRef, frameClockRef,
  ]);

  return { handleStartCamera, handleStartScreenShare, handleLoadVideoFile, handleStopLiveSource };
}
