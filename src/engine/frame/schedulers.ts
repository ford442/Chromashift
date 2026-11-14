/**
 * Frame sources for a `FrameClock` that does not live on the page (#253).
 *
 * The render worker drives its clock from the worker's own
 * `requestAnimationFrame` where the browser has one — Chromium and Firefox
 * expose it in dedicated workers, ticking with the display the worker's
 * `OffscreenCanvas` presents to — and otherwise from a `setTimeout` pacer with
 * the same contract: one callback per frame, a monotonic timestamp, cancel by
 * handle. Either way the page's thread is not involved, so a long task there
 * does not delay a frame.
 */

import type { FrameScheduler } from './FrameClock';

/** What a scheduler needs of its global scope — a page, a worker, or a test fake. */
export interface FrameScope {
  requestAnimationFrame?: (callback: (now: number) => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: never) => void;
  performance: { now(): number };
}

/** The scope's own `requestAnimationFrame`, or `null` where it has none. */
export function animationFrameScheduler(scope: FrameScope): FrameScheduler | null {
  const request = scope.requestAnimationFrame;
  const cancel = scope.cancelAnimationFrame;
  if (typeof request !== 'function' || typeof cancel !== 'function') return null;
  return {
    request: (callback) => request.call(scope, (now) => callback(now)),
    cancel: (handle) => cancel.call(scope, handle),
  };
}

/**
 * A `setTimeout` pacer at `hz`: each callback is due one period after the
 * previous one was *due* (not after it ran), so a late tick does not push
 * every later one back, and a tick that is already overdue runs at once.
 */
export function timeoutFrameScheduler(scope: FrameScope, hz = 60): FrameScheduler {
  const period = 1000 / hz;
  let nextDue: number | null = null;
  let nextHandle = 1;
  const timers = new Map<number, unknown>();
  return {
    request(callback) {
      const now = scope.performance.now();
      const due = nextDue === null || nextDue < now - period ? now : nextDue;
      const handle = nextHandle++;
      timers.set(handle, scope.setTimeout(() => {
        timers.delete(handle);
        nextDue = due + period;
        callback(scope.performance.now());
      }, Math.max(0, due - now)));
      return handle;
    },
    cancel(handle) {
      const timer = timers.get(handle);
      if (timer === undefined) return;
      timers.delete(handle);
      scope.clearTimeout(timer as never);
    },
  };
}

/** Which frame source a worker's clock gets, and what to call it in the breadcrumbs. */
export function workerFrameScheduler(scope: FrameScope): { scheduler: FrameScheduler; kind: 'raf' | 'timeout' } {
  const raf = animationFrameScheduler(scope);
  return raf ? { scheduler: raf, kind: 'raf' } : { scheduler: timeoutFrameScheduler(scope), kind: 'timeout' };
}
