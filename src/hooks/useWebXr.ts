import { useCallback, useEffect, useRef, useState } from 'react';
import { buildRendererState } from '../engine/buildRendererState';
import { detectXrSupport, publishXrBreadcrumbs, publishXrImmersiveBreadcrumb } from '../engine/xr/xrSupport';
import { WebXrPresenter, xrRendererStateOverrides } from '../engine/xr/WebXrPresenter';
import type { ChromashiftRefs, ChromashiftStore } from './useChromashiftStore';

export interface WebXrControls {
  xrAvailable: boolean;
  xrReason: string | null;
  xrImmersive: boolean;
  xrBusy: boolean;
  xrError: string | null;
  xrEnterAllowed: boolean;
  enterXr: () => Promise<void>;
  exitXr: () => void;
}

export function useWebXr(refs: ChromashiftRefs, store: ChromashiftStore): WebXrControls {
  const { state } = store;
  const { renderStateRef, animAnglesRef } = refs;
  const presenterRef = useRef<WebXrPresenter | null>(null);

  const [xrAvailable, setXrAvailable] = useState(false);
  const [xrReason, setXrReason] = useState<string | null>(null);
  const [xrImmersive, setXrImmersive] = useState(false);
  const [xrBusy, setXrBusy] = useState(false);
  const [xrError, setXrError] = useState<string | null>(null);

  const backend = state.engine.backend;
  const kioskEnabled = state.ui.kioskEnabled;
  const gpuReady = state.engine.gpuReady;
  const xrEnterAllowed = xrAvailable && backend === 'webgl' && gpuReady && !kioskEnabled;

  useEffect(() => {
    let cancelled = false;
    void detectXrSupport().then((snap) => {
      if (cancelled) return;
      setXrAvailable(snap.immersiveVrSupported);
      setXrReason(snap.reason);
      publishXrBreadcrumbs(snap.immersiveVrSupported, snap.reason);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      presenterRef.current?.destroy();
      presenterRef.current = null;
    };
  }, []);

  const exitXr = useCallback(() => {
    presenterRef.current?.exit();
    publishXrImmersiveBreadcrumb(false);
    setXrImmersive(false);
  }, []);

  const enterXr = useCallback(async () => {
    if (!xrEnterAllowed || xrBusy || xrImmersive) return;
    setXrBusy(true);
    setXrError(null);
    try {
      const presenter = presenterRef.current ?? new WebXrPresenter();
      presenterRef.current = presenter;

      const current = renderStateRef.current;
      const image = current.media.imageList[current.media.currentIndex];
      if (image?.url) {
        await presenter.syncTexture(image.url);
      }

      presenter.setFrameRenderer((renderer, viewport, fps) => {
        const live = renderStateRef.current;
        const imageUrl = live.media.imageList[live.media.currentIndex]?.url;
        if (imageUrl) {
          void presenter.syncTexture(imageUrl);
        }
        const angles: [number, number, number] = [
          animAnglesRef.current[0],
          animAnglesRef.current[1],
          animAnglesRef.current[2],
        ];
        const built = buildRendererState(live, angles);
        renderer.render({ ...built, ...xrRendererStateOverrides(built) }, fps, viewport);
      }, current.engine.fps);

      await presenter.enter(() => {
        publishXrImmersiveBreadcrumb(false);
        setXrImmersive(false);
        setXrBusy(false);
      });
      publishXrImmersiveBreadcrumb(true);
      setXrImmersive(true);
    } catch (err) {
      setXrError(err instanceof Error ? err.message : String(err));
      setXrImmersive(false);
    } finally {
      setXrBusy(false);
    }
  }, [animAnglesRef, renderStateRef, xrBusy, xrEnterAllowed, xrImmersive]);

  return {
    xrAvailable,
    xrReason,
    xrImmersive,
    xrBusy,
    xrError,
    xrEnterAllowed,
    enterXr,
    exitXr,
  };
}
