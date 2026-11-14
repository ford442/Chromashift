import { afterEach, describe, expect, it, vi } from 'vitest';
import { FrameClock } from './FrameClock';
import { animationFrameScheduler, timeoutFrameScheduler, workerFrameScheduler, type FrameScope } from './schedulers';

function timerScope(): FrameScope {
  return {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle),
    performance: { now: () => Date.now() },
  };
}

describe('frame schedulers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the scope's own requestAnimationFrame when it has one", () => {
    const request = vi.fn(() => 7);
    const cancel = vi.fn();
    const scope: FrameScope = { ...timerScope(), requestAnimationFrame: request, cancelAnimationFrame: cancel };
    const picked = workerFrameScheduler(scope);
    expect(picked.kind).toBe('raf');
    const callback = vi.fn();
    expect(picked.scheduler.request(callback)).toBe(7);
    picked.scheduler.cancel(7);
    expect(cancel).toHaveBeenCalledWith(7);
    expect(animationFrameScheduler(timerScope())).toBeNull();
  });

  it('falls back to a setTimeout pacer that keeps its period when a tick runs late', () => {
    vi.useFakeTimers({ now: 0 });
    const scheduler = timeoutFrameScheduler(timerScope(), 50); // 20 ms
    const ticks: number[] = [];
    const loop = () => {
      scheduler.request((now) => {
        ticks.push(now);
        if (ticks.length === 2) vi.setSystemTime(Date.now() + 5); // this tick ran 5 ms long
        if (ticks.length < 5) loop();
      });
    };
    loop();
    vi.advanceTimersByTime(200);
    // Due at 0, 20, 40, 60, 80 — the long second tick does not shift the rest.
    expect(ticks).toEqual([0, 20, 40, 60, 80]);
  });

  it('cancels a pending pacer tick by handle', () => {
    vi.useFakeTimers({ now: 0 });
    const scheduler = timeoutFrameScheduler(timerScope());
    const callback = vi.fn();
    scheduler.cancel(scheduler.request(callback));
    vi.advanceTimersByTime(100);
    expect(callback).not.toHaveBeenCalled();
  });

  it('drives a FrameClock with the FrameClock contract', () => {
    vi.useFakeTimers({ now: 1000 });
    const clock = new FrameClock({ scheduler: timeoutFrameScheduler(timerScope(), 50) });
    const dts: number[] = [];
    const off = clock.register('render', ({ dt }) => { dts.push(dt); });
    vi.advanceTimersByTime(100);
    off();
    expect(dts[0]).toBe(0);
    expect(dts.slice(1).every((dt) => dt === 20)).toBe(true);
    expect(dts.length).toBeGreaterThanOrEqual(5);
  });
});
