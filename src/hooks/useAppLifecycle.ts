import { useEffect } from 'react';
import { loadWasmEngine } from '../engine/WasmEngine';
import type { ChromashiftRefs } from './useChromashiftStore';
import type { ChromashiftState } from '../state/types';

export function useCanvasResize(
  refs: ChromashiftRefs,
  squareCanvas: boolean,
  imageAspect: number,
): void {
  const { containerRef, previewTracerRef, mainViewportRef, webGpuSessionRef } = refs;

  useEffect(() => {
    const mainCanvas = previewTracerRef.current;
    const container = containerRef.current;
    const mainViewport = mainViewportRef.current;
    if (!mainCanvas || !container || !mainViewport) return;

    function resizeCanvas() {
      const containerEl = containerRef.current;
      const mainCanvasEl = previewTracerRef.current;
      const mainViewportEl = mainViewportRef.current;
      if (!mainCanvasEl || !containerEl || !mainViewportEl) return;

      const maxSize = window.innerHeight * 0.95;
      const containerW = containerEl.clientWidth;
      const containerH = containerEl.clientHeight;

      const boxW = containerW;
      const boxH = Math.floor(Math.min(maxSize, containerH));

      let targetW = boxW;
      let targetH = boxH;

      if (squareCanvas) {
        const side = Math.floor(Math.min(boxW, boxH));
        targetW = side;
        targetH = side;
      } else if (boxW / boxH > imageAspect) {
        targetH = boxH;
        targetW = Math.floor(targetH * imageAspect);
      } else {
        targetW = boxW;
        targetH = Math.floor(targetW / imageAspect);
      }

      const cssW = Math.floor(targetW);
      const cssH = Math.floor(targetH);
      const cssLeft = Math.floor((containerW - cssW) / 2);
      const cssTop = Math.floor((containerH - cssH) / 2);

      mainViewportEl.style.width = `${cssW}px`;
      mainViewportEl.style.height = `${cssH}px`;
      mainViewportEl.style.left = `${cssLeft}px`;
      mainViewportEl.style.top = `${cssTop}px`;

      const dpr = Math.max(1, window.devicePixelRatio || 1);
      mainCanvasEl.width = Math.floor(cssW * dpr);
      mainCanvasEl.height = Math.floor(cssH * dpr);
      webGpuSessionRef.current?.reconfigure();
    }

    resizeCanvas();
    const observer = new ResizeObserver(resizeCanvas);
    observer.observe(container);
    window.addEventListener('resize', resizeCanvas);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', resizeCanvas);
    };
  }, [containerRef, previewTracerRef, mainViewportRef, webGpuSessionRef, squareCanvas, imageAspect]);
}

export function useWasmEngineLoader(
  setWasmAvailable: (available: boolean) => void,
): void {
  useEffect(() => {
    loadWasmEngine().then((ok) => {
      setWasmAvailable(ok);
      if (ok) console.info('[Chromashift] C++ WASM engine loaded successfully.');
      else console.info('[Chromashift] C++ WASM engine unavailable — using TypeScript engine.');
    });
  }, [setWasmAvailable]);
}

export function useCollisionStatsPoll(
  refs: ChromashiftRefs,
  gpuReady: boolean,
  setCollisionStats: (stats: ChromashiftState['ui']['collisionStats']) => void,
): void {
  const { rendererRef } = refs;

  useEffect(() => {
    if (!gpuReady || !rendererRef.current) return;
    let cancelled = false;

    const requestStats = () => {
      const renderer = rendererRef.current;
      if (!renderer) return;
      renderer.requestCollisionStats((stats) => {
        if (!cancelled) setCollisionStats(stats);
      });
    };

    requestStats();
    const interval = window.setInterval(requestStats, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [rendererRef, gpuReady, setCollisionStats]);
}
