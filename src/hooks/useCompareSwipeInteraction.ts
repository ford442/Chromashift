import { useEffect } from 'react';
import { publishCompareBreadcrumbs } from '../engine/compareBreadcrumbs';
import type { ChromashiftRefs, ChromashiftStore } from './useChromashiftStore';

const SWIPE_HANDLE_SELECTOR = '[data-testid="compare-swipe-handle"]';
const SWIPE_NUDGE = 0.02;

/**
 * Drag handle + keyboard nudge for swipe compare layout.
 * Publishes window breadcrumbs for automation (see compareBreadcrumbs.ts).
 */
export function useCompareSwipeInteraction(refs: ChromashiftRefs, store: ChromashiftStore): void {
  const { state, actions } = store;
  const { layout, swipePosition } = state.ui.compareView;
  const { mainViewportRef, renderStateRef } = refs;

  useEffect(() => {
    publishCompareBreadcrumbs(layout, swipePosition);
  }, [layout, swipePosition]);

  useEffect(() => {
    if (layout !== 'swipe') return;

    const viewport = mainViewportRef.current;
    if (!viewport) return;

    let activePointerId: number | null = null;

    const positionFromClientX = (clientX: number) => {
      const rect = viewport.getBoundingClientRect();
      if (rect.width <= 0) return renderStateRef.current.ui.compareView.swipePosition;
      return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    };

    const handlePointerDown = (event: PointerEvent) => {
      const handle = (event.target as HTMLElement | null)?.closest(SWIPE_HANDLE_SELECTOR);
      if (!handle || !viewport.contains(handle)) return;
      event.preventDefault();
      activePointerId = event.pointerId;
      (handle as HTMLElement).setPointerCapture(event.pointerId);
      actions.setCompareSwipePosition(positionFromClientX(event.clientX));
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (activePointerId === null || event.pointerId !== activePointerId) return;
      actions.setCompareSwipePosition(positionFromClientX(event.clientX));
    };

    const releasePointer = (event: PointerEvent) => {
      if (activePointerId !== event.pointerId) return;
      activePointerId = null;
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      event.preventDefault();
      const delta = event.key === 'ArrowLeft' ? -SWIPE_NUDGE : SWIPE_NUDGE;
      const current = renderStateRef.current.ui.compareView.swipePosition;
      actions.setCompareSwipePosition(current + delta);
    };

    viewport.addEventListener('pointerdown', handlePointerDown);
    viewport.addEventListener('pointermove', handlePointerMove);
    viewport.addEventListener('pointerup', releasePointer);
    viewport.addEventListener('pointercancel', releasePointer);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      viewport.removeEventListener('pointerdown', handlePointerDown);
      viewport.removeEventListener('pointermove', handlePointerMove);
      viewport.removeEventListener('pointerup', releasePointer);
      viewport.removeEventListener('pointercancel', releasePointer);
      window.removeEventListener('keydown', handleKeyDown);
      activePointerId = null;
    };
  }, [layout, mainViewportRef, renderStateRef, actions]);
}
