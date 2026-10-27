import { describe, expect, it, vi } from 'vitest';
import { FRAME_PHASES, FrameClock, type FrameScheduler, type FrameTick } from './FrameClock';

/** A scheduler the test fires by hand, standing in for `requestAnimationFrame`. */
function fakeScheduler() {
  let next = 1;
  const callbacks = new Map<number, (now: number, xrFrame?: XRFrame) => void>();
  const scheduler: FrameScheduler & { fire: (now: number, xrFrame?: XRFrame) => void; pending: () => number } = {
    request: vi.fn((callback) => {
      const handle = next++;
      callbacks.set(handle, callback);
      return handle;
    }),
    cancel: vi.fn((handle: number) => {
      callbacks.delete(handle);
    }),
    fire(now, xrFrame) {
      const due = [...callbacks.values()];
      callbacks.clear();
      for (const callback of due) callback(now, xrFrame);
    },
    pending: () => callbacks.size,
  };
  return scheduler;
}

describe('FrameClock phases', () => {
  it('runs input → sources → modulate → render → telemetry whatever the registration order', () => {
    const scheduler = fakeScheduler();
    const clock = new FrameClock({ scheduler });
    const order: string[] = [];
    for (const phase of [...FRAME_PHASES].reverse()) {
      clock.register(phase, () => { order.push(phase); }, phase);
    }
    scheduler.fire(16);
    expect(order).toEqual([...FRAME_PHASES]);
  });

  it('keeps registration order within a phase', () => {
    const scheduler = fakeScheduler();
    const clock = new FrameClock({ scheduler });
    const order: string[] = [];
    clock.register('render', () => { order.push('main'); }, 'main');
    clock.register('render', () => { order.push('xr'); }, 'xr');
    scheduler.fire(16);
    expect(order).toEqual(['main', 'xr']);
    expect(clock.describe().render).toEqual(['main', 'xr']);
  });

  it('passes now, dt and a running index', () => {
    const scheduler = fakeScheduler();
    const clock = new FrameClock({ scheduler });
    const ticks: FrameTick[] = [];
    clock.register('render', (tick) => { ticks.push(tick); });
    scheduler.fire(100);
    scheduler.fire(116);
    expect(ticks.map(({ now, dt, index, mode }) => ({ now, dt, index, mode }))).toEqual([
      { now: 100, dt: 0, index: 0, mode: 'realtime' },
      { now: 116, dt: 16, index: 1, mode: 'realtime' },
    ]);
  });
});

describe('FrameClock registration', () => {
  it('requests no frames with nothing registered, and exactly one per tick otherwise', () => {
    const scheduler = fakeScheduler();
    const clock = new FrameClock({ scheduler });
    expect(scheduler.request).not.toHaveBeenCalled();

    const a = clock.register('input', () => {});
    clock.register('render', () => {});
    expect(scheduler.request).toHaveBeenCalledTimes(1);
    scheduler.fire(1);
    scheduler.fire(2);
    expect(scheduler.request).toHaveBeenCalledTimes(3);
    expect(scheduler.pending()).toBe(1);
    a();
    expect(scheduler.pending()).toBe(1);
  });

  it('cancels the pending frame when the last task unregisters', () => {
    const scheduler = fakeScheduler();
    const clock = new FrameClock({ scheduler });
    const off = clock.register('render', () => {});
    off();
    off();
    expect(scheduler.pending()).toBe(0);
    expect(clock.size).toBe(0);
  });

  it('skips a task unregistered earlier in the same tick, and starts a new one next tick', () => {
    const scheduler = fakeScheduler();
    const clock = new FrameClock({ scheduler });
    const ran: string[] = [];
    let offRender: () => void = () => {};
    clock.register('input', () => {
      ran.push('input');
      offRender();
      clock.register('render', () => { ran.push('late'); }, 'late');
    });
    offRender = clock.register('render', () => { ran.push('render'); });
    scheduler.fire(1);
    expect(ran).toEqual(['input']);
    scheduler.fire(2);
    expect(ran).toEqual(['input', 'input', 'late']);
  });

  it('lets a task unregister itself without disturbing the rest of its phase', () => {
    const scheduler = fakeScheduler();
    const clock = new FrameClock({ scheduler });
    const ran: string[] = [];
    const off = clock.register('render', () => { ran.push('once'); off(); });
    clock.register('render', () => { ran.push('always'); });
    scheduler.fire(1);
    scheduler.fire(2);
    expect(ran).toEqual(['once', 'always', 'always']);
  });

  it('reports a throwing task and still runs the others and the next tick', () => {
    const scheduler = fakeScheduler();
    const onError = vi.fn();
    const clock = new FrameClock({ scheduler, onError });
    const ran: number[] = [];
    clock.register('modulate', () => { throw new Error('boom'); }, 'bad');
    clock.register('render', (tick) => { ran.push(tick.index); });
    scheduler.fire(1);
    scheduler.fire(2);
    expect(ran).toEqual([0, 1]);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls[0]!.slice(1)).toEqual(['modulate', 'bad']);
  });
});

describe('FrameClock schedulers', () => {
  it('moves to an XR session scheduler and back, passing the XR frame through', () => {
    const windowScheduler = fakeScheduler();
    const xrScheduler = fakeScheduler();
    const clock = new FrameClock({ scheduler: windowScheduler });
    const frames: (XRFrame | null)[] = [];
    clock.register('render', (tick) => { frames.push(tick.xrFrame); });

    const restore = clock.useScheduler(xrScheduler);
    expect(windowScheduler.pending()).toBe(0);
    const xrFrame = {} as XRFrame;
    xrScheduler.fire(10, xrFrame);
    windowScheduler.fire(11);
    restore();
    expect(xrScheduler.pending()).toBe(0);
    windowScheduler.fire(12);
    expect(frames).toEqual([xrFrame, null]);
  });
});

describe('FrameClock offline', () => {
  it('requests no frames, and steps with a fixed dt through every phase', async () => {
    const scheduler = fakeScheduler();
    const clock = new FrameClock({ scheduler });
    const log: string[] = [];
    clock.register('modulate', (tick) => { log.push(`modulate@${tick.now}`); });
    clock.register('render', async (tick) => {
      await Promise.resolve();
      log.push(`render@${tick.now}`);
    });
    clock.register('telemetry', (tick) => { log.push(`telemetry@${tick.now}/${tick.mode}`); });

    const exit = clock.enterOffline(1000);
    expect(scheduler.pending()).toBe(0);
    await clock.step(40);
    await clock.step(40);
    expect(log).toEqual([
      'modulate@1040', 'render@1040', 'telemetry@1040/offline',
      'modulate@1080', 'render@1080', 'telemetry@1080/offline',
    ]);

    exit();
    expect(clock.mode).toBe('realtime');
    expect(scheduler.pending()).toBe(1);
  });

  it('is deterministic: the same steps give the same ticks', async () => {
    const run = async () => {
      const clock = new FrameClock({ scheduler: fakeScheduler() });
      const seen: [number, number][] = [];
      clock.register('render', (tick) => { seen.push([tick.now, tick.dt]); });
      const exit = clock.enterOffline();
      for (let i = 0; i < 30; i += 1) await clock.step(1000 / 24);
      exit();
      return seen;
    };
    const [a, b] = [await run(), await run()];
    expect(a).toEqual(b);
    expect(a).toHaveLength(30);
    expect(a[29]![0]).toBeCloseTo(1250, 9);
  });

  it('refuses to step in realtime or while a step is running', async () => {
    const clock = new FrameClock({ scheduler: fakeScheduler() });
    await expect(clock.step(16)).rejects.toThrow(/offline/);

    const exit = clock.enterOffline();
    let release: () => void = () => {};
    clock.register('render', () => new Promise<void>((resolve) => { release = resolve; }));
    const first = clock.step(16);
    await expect(clock.step(16)).rejects.toThrow(/still running/);
    release();
    await first;
    exit();
  });

  it('propagates an offline task error to the stepper', async () => {
    const clock = new FrameClock({ scheduler: fakeScheduler() });
    clock.register('render', () => { throw new Error('export failed'); });
    const exit = clock.enterOffline();
    await expect(clock.step(16)).rejects.toThrow('export failed');
    exit();
  });
});
