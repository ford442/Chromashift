import { useCallback, useEffect, useRef, useState } from 'react';
import { publishKioskBreadcrumbs } from '../engine/kioskMode';
import type { ChromashiftRefs, ChromashiftStore } from './useChromashiftStore';

const ATTRACT_TICK_MS = 2000;

export function useKioskMode(refs: ChromashiftRefs, store: ChromashiftStore): {
  isFullscreen: boolean;
  toggleFullscreen: () => Promise<void>;
} {
  const { state, actions } = store;
  const { containerRef } = refs;
  const {
    kioskEnabled,
    kioskUiHidden,
    kioskAttractMode,
    shortcutsOverlayVisible,
  } = state.ui;

  const [isFullscreen, setIsFullscreen] = useState(false);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const attractStartRef = useRef(0);

  useEffect(() => {
    attractStartRef.current = performance.now();
  }, []);

  useEffect(() => {
    publishKioskBreadcrumbs(kioskEnabled);
  }, [kioskEnabled]);

  const releaseWakeLock = useCallback(() => {
    void wakeLockRef.current?.release();
    wakeLockRef.current = null;
  }, []);

  const requestWakeLock = useCallback(async () => {
    if (!('wakeLock' in navigator)) return;
    try {
      wakeLockRef.current = await navigator.wakeLock.request('screen');
    } catch {
      wakeLockRef.current = null;
    }
  }, []);

  const toggleFullscreen = useCallback(async () => {
    const el = containerRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await el.requestFullscreen();
      }
    } catch {
      // Fullscreen may be blocked without a user gesture.
    }
  }, [containerRef]);

  useEffect(() => {
    const onFullscreenChange = () => {
      const active = document.fullscreenElement === containerRef.current;
      setIsFullscreen(active);
      if (active) {
        void requestWakeLock();
      } else {
        releaseWakeLock();
      }
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    onFullscreenChange();
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, [containerRef, requestWakeLock, releaseWakeLock]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && document.fullscreenElement === containerRef.current) {
        void requestWakeLock();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [containerRef, requestWakeLock]);

  useEffect(() => () => releaseWakeLock(), [releaseWakeLock]);

  // Kiosk keeps the show running — no paused frames while chrome is hidden.
  useEffect(() => {
    if (kioskEnabled && kioskUiHidden && state.engine.paused) {
      actions.setIsPaused(false);
    }
  }, [kioskEnabled, kioskUiHidden, state.engine.paused, actions]);

  useEffect(() => {
    if (!kioskEnabled || !kioskUiHidden || !kioskAttractMode) return;

    const id = window.setInterval(() => {
      const t = (performance.now() - attractStartRef.current) / 1000;
      actions.setTracerAboveIntensity(0.78 + 0.12 * Math.sin(t / 45));
      actions.setTracerBelowIntensity(0.28 + 0.08 * Math.sin(t / 62 + 1));
      actions.setStampBoost(1.6 + 0.6 * Math.sin(t / 90 + 2));
      actions.setAvgLuminance(Math.round(120 + 18 * Math.sin(t / 75 + 0.5)));
    }, ATTRACT_TICK_MS);

    return () => window.clearInterval(id);
  }, [kioskEnabled, kioskUiHidden, kioskAttractMode, actions]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName;
      if (target?.isContentEditable || tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') {
        return;
      }

      if (event.key === 'Escape') {
        if (shortcutsOverlayVisible) {
          event.preventDefault();
          actions.setShortcutsOverlayVisible(false);
          return;
        }
        if (kioskUiHidden) {
          event.preventDefault();
          actions.setKioskUiHidden(false);
          void document.exitFullscreen().catch(() => undefined);
        }
        return;
      }

      if (event.key === '?' || (event.key === '/' && event.shiftKey)) {
        event.preventDefault();
        actions.setShortcutsOverlayVisible(!shortcutsOverlayVisible);
        return;
      }

      if (event.key === 'f' || event.key === 'F') {
        event.preventDefault();
        void toggleFullscreen();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    actions,
    kioskUiHidden,
    shortcutsOverlayVisible,
    toggleFullscreen,
  ]);

  return { isFullscreen, toggleFullscreen };
}
