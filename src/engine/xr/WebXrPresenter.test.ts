import { describe, expect, it, vi } from 'vitest';
import { FrameClock } from '../frame/FrameClock';
import { xrEyeViewports, xrRendererStateOverrides, xrSessionScheduler } from './WebXrPresenter';
import type { RendererState } from '../types/RendererState';

const state = (paused: boolean) => ({ paused } as RendererState);

describe('xrRendererStateOverrides', () => {
  // The executor skips the accumulator passes and the flip on a paused frame,
  // and the compositor reads the previous frame's accumulation either way —
  // so pausing every eye but the last advances the tracers once per XR frame
  // and shows both eyes the same tracers.
  it('advances the tracers on the last eye only', () => {
    expect(xrRendererStateOverrides(state(false), false).paused).toBe(true);
    expect(xrRendererStateOverrides(state(false), true).paused).toBe(false);
  });

  it('keeps a paused session paused on every eye', () => {
    expect(xrRendererStateOverrides(state(true), true).paused).toBe(true);
  });

  it('no longer rescales layers: the layer framebuffer is already half size', () => {
    const overrides = xrRendererStateOverrides(state(false));
    expect(overrides).not.toHaveProperty('layerScale');
    expect(overrides).not.toHaveProperty('tracerScale');
  });
});

describe('xrEyeViewports', () => {
  it('draws each eye\'s whole viewport, not a centred patch', () => {
    const left = { x: 0, y: 0, width: 960, height: 1080 } as XRViewport;
    const right = { x: 960, y: 0, width: 960, height: 1080 } as XRViewport;
    expect(xrEyeViewports([left, null, right])).toEqual([
      { x: 0, y: 0, width: 960, height: 1080 },
      { x: 960, y: 0, width: 960, height: 1080 },
    ]);
  });
});

describe('xrSessionScheduler', () => {
  it('ticks the frame clock on the session loop and hands tasks the XR frame', () => {
    let pending: ((time: number, frame: XRFrame) => void) | null = null;
    const session = {
      requestAnimationFrame: vi.fn((callback: (time: number, frame: XRFrame) => void) => {
        pending = callback;
        return 7;
      }),
      cancelAnimationFrame: vi.fn(),
    } as unknown as XRSession;
    const clock = new FrameClock({ scheduler: { request: () => 1, cancel: () => {} } });
    const seen: (XRFrame | null)[] = [];
    clock.register('render', (tick) => { seen.push(tick.xrFrame); });

    const restore = clock.useScheduler(xrSessionScheduler(session));
    const frame = { session } as unknown as XRFrame;
    pending!(1000, frame);
    expect(seen).toEqual([frame]);
    expect(session.requestAnimationFrame).toHaveBeenCalledTimes(2);

    restore();
    expect(session.cancelAnimationFrame).toHaveBeenCalledWith(7);
  });
});
