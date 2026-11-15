import { useEffect } from 'react';
import { loadWasmEngine } from '../engine/WasmEngine';
import type { ChromashiftRefs } from './useChromashiftStore';
import type { CollisionStats } from '../engine/types/RendererState';
import { isQuadCompareLayout, isTwoSlotCompareLayout } from '../engine/compareViews';

export function useCanvasResize(
  refs: ChromashiftRefs,
  squareCanvas: boolean,
  imageAspect: number,
  compareLayout: import('../engine/compareViews').CompareLayoutMode = 'single',
): void {
  const { containerRef, mainCanvasRef, mainViewportRef, renderHostRef, canvasARef, canvasBRef, canvasCRef } = refs;
  const dual = compareLayout === 'dual';
  const quad = isQuadCompareLayout(compareLayout);
  const twoSlot = isTwoSlotCompareLayout(compareLayout);
  const multiCell = dual || quad;

  useEffect(() => {
    const mainCanvas = mainCanvasRef.current;
    const container = containerRef.current;
    const mainViewport = mainViewportRef.current;
    if (!mainCanvas || !container || !mainViewport) return;

    function resizeCanvas() {
      const containerEl = containerRef.current;
      const mainCanvasEl = mainCanvasRef.current;
      const mainViewportEl = mainViewportRef.current;
      if (!mainCanvasEl || !containerEl || !mainViewportEl) return;

      const maxSize = window.innerHeight * 0.95;
      const containerW = containerEl.clientWidth;
      const containerH = containerEl.clientHeight;

      const boxW = containerW;
      const boxH = Math.floor(Math.min(maxSize, containerH));

      const fitW = multiCell ? Math.floor((boxW - 2) / 2) : boxW;
      const fitH = quad ? Math.floor((boxH - 2) / 2) : boxH;

      let cellW = fitW;
      let cellH = fitH;

      if (squareCanvas) {
        const side = Math.floor(Math.min(fitW, fitH));
        cellW = side;
        cellH = side;
      } else if (fitW / fitH > imageAspect) {
        cellH = fitH;
        cellW = Math.floor(cellH * imageAspect);
      } else {
        cellW = fitW;
        cellH = Math.floor(cellW / imageAspect);
      }

      let viewportW = cellW;
      let viewportH = cellH;
      if (dual) viewportW = cellW * 2 + 2;
      if (quad) {
        viewportW = cellW * 2 + 2;
        viewportH = cellH * 2 + 2;
      }

      const cssW = Math.floor(viewportW);
      const cssH = Math.floor(viewportH);
      const cssLeft = Math.floor((containerW - cssW) / 2);
      const cssTop = Math.floor((containerH - cssH) / 2);

      mainViewportEl.style.width = `${cssW}px`;
      mainViewportEl.style.height = `${cssH}px`;
      mainViewportEl.style.left = `${cssLeft}px`;
      mainViewportEl.style.top = `${cssTop}px`;

      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const canvasCssW = multiCell ? (cssW - 2) / 2 : cssW;
      const canvasCssH = quad ? (cssH - 2) / 2 : cssH;

      let gpuResizeNeeded = false;
      const host = renderHostRef.current;

      // Through the host: a canvas handed to the render worker cannot be
      // sized from here, so the new size is a message (and the host tracks it).
      const resizeOne = (canvas: HTMLCanvasElement | null, w: number, h: number) => {
        if (!canvas) return;
        if (host.sizeCanvas(canvas, Math.floor(w * dpr), Math.floor(h * dpr))) gpuResizeNeeded = true;
      };

      if (quad) {
        resizeOne(canvasARef.current, canvasCssW, canvasCssH);
        resizeOne(canvasBRef.current, canvasCssW, canvasCssH);
        resizeOne(canvasCRef.current, canvasCssW, canvasCssH);
        resizeOne(mainCanvasEl, canvasCssW, canvasCssH);
      } else {
        resizeOne(mainCanvasEl, canvasCssW, cssH);
        if (twoSlot) {
          resizeOne(canvasBRef.current, canvasCssW, cssH);
        }
      }

      if (gpuResizeNeeded) host.flushResize();
    }

    resizeCanvas();
    const observer = new ResizeObserver(resizeCanvas);
    observer.observe(container);
    window.addEventListener('resize', resizeCanvas);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', resizeCanvas);
    };
  }, [containerRef, mainCanvasRef, mainViewportRef, renderHostRef, canvasARef, canvasBRef, canvasCRef, squareCanvas, imageAspect, dual, quad, twoSlot, multiCell]);
}

export function useWasmEngineLoader(
  setWasmAvailable: (available: boolean) => void,
): void {
  useEffect(() => {
    // Never rejects: a module that fails to load resolves false.
    void loadWasmEngine().then((ok) => {
      setWasmAvailable(ok);
      if (ok) console.info('[Chromashift] C++ WASM engine loaded successfully.');
      else console.info('[Chromashift] C++ WASM engine unavailable — using TypeScript engine.');
    });
  }, [setWasmAvailable]);
}

export function useCollisionStatsPoll(
  refs: ChromashiftRefs,
  gpuReady: boolean,
  backend: import('../engine/types/RendererContracts').RendererBackend,
  setCollisionStats: (stats: CollisionStats) => void,
): void {
  const { renderHostRef } = refs;

  useEffect(() => {
    // A WebGL pixel-pack map drains every pass still queued on this context.
    // On a deferred driver that is a multi-second hitch on the animation
    // thread, so the live collision poll stays on the WebGPU readback path.
    if (!gpuReady || backend === 'webgl') return;
    const host = renderHostRef.current;
    let cancelled = false;

    const requestStats = () => {
      void host.collisionStats().then((stats) => {
        if (stats && !cancelled) setCollisionStats(stats);
      }, () => {});
    };

    requestStats();
    const interval = window.setInterval(requestStats, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [renderHostRef, gpuReady, backend, setCollisionStats]);
}
