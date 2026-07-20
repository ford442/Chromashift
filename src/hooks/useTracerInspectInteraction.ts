import { useEffect } from 'react';
import { MAIN_VIEW_MODES } from '../engine/viewModes';
import type { ChromashiftRefs, ChromashiftStore } from './useChromashiftStore';

export function useTracerInspectInteraction(refs: ChromashiftRefs, store: ChromashiftStore): void {
  const { state, actions } = store;
  const { paused } = state.engine;
  const { mainViewMode } = state.output;
  const { mainCanvasRef, tracerDragRef, renderStateRef } = refs;

  useEffect(() => {
    const canvas = mainCanvasRef.current;
    if (!canvas || !paused || mainViewMode !== MAIN_VIEW_MODES.FULL_RES_TRACER) return;

    const clampPan = (x: number, y: number, zoom: number) => {
      const limit = (zoom - 1) / (2 * zoom);
      return {
        x: Math.max(-limit, Math.min(limit, x)),
        y: Math.max(-limit, Math.min(limit, y)),
      };
    };

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const zoom = renderStateRef.current.output.tracerInspect.zoom;
      actions.setTracerInspectZoom(
        Math.max(1, Math.min(12, zoom * (event.deltaY > 0 ? 0.9 : 1.1))),
      );
    };

    const handlePointerDown = (event: PointerEvent) => {
      tracerDragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
    };

    const handlePointerMove = (event: PointerEvent) => {
      const drag = tracerDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      drag.x = event.clientX;
      drag.y = event.clientY;
      const zoom = renderStateRef.current.output.tracerInspect.zoom;
      const pan = renderStateRef.current.output.tracerInspect.pan;
      actions.setTracerInspectPan(clampPan(
        pan.x - dx / (canvas.clientWidth * zoom),
        pan.y - dy / (canvas.clientHeight * zoom),
        zoom,
      ));
    };

    const releasePointer = (event: PointerEvent) => {
      if (tracerDragRef.current?.pointerId === event.pointerId) {
        tracerDragRef.current = null;
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const zoom = renderStateRef.current.output.tracerInspect.zoom;
      const pan = renderStateRef.current.output.tracerInspect.pan;
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        actions.setTracerInspectZoom(Math.min(12, zoom * 1.15));
      } else if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        actions.setTracerInspectZoom(Math.max(1, zoom / 1.15));
      } else if (event.key === '0') {
        actions.resetInspectView();
      } else if (event.key === 'h' || event.key === 'H') {
        actions.setTracerInspectHeatmap(!renderStateRef.current.output.tracerInspect.heatmap);
      } else if (event.key.startsWith('Arrow')) {
        event.preventDefault();
        const step = 0.03 / zoom;
        const deltaX = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
        const deltaY = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
        actions.setTracerInspectPan(clampPan(pan.x + deltaX, pan.y + deltaY, zoom));
      }
    };

    canvas.addEventListener('wheel', handleWheel, { passive: false });
    canvas.addEventListener('pointerdown', handlePointerDown);
    canvas.addEventListener('pointermove', handlePointerMove);
    canvas.addEventListener('pointerup', releasePointer);
    canvas.addEventListener('pointercancel', releasePointer);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      canvas.removeEventListener('wheel', handleWheel);
      canvas.removeEventListener('pointerdown', handlePointerDown);
      canvas.removeEventListener('pointermove', handlePointerMove);
      canvas.removeEventListener('pointerup', releasePointer);
      canvas.removeEventListener('pointercancel', releasePointer);
      window.removeEventListener('keydown', handleKeyDown);
      tracerDragRef.current = null;
    };
  }, [mainCanvasRef, tracerDragRef, renderStateRef, actions, paused, mainViewMode]);
}
