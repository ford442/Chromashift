import { describe, expect, it } from 'vitest';
import { xrEyeViewports, xrRendererStateOverrides } from './WebXrPresenter';
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
