import { describe, expect, it } from 'vitest';
import { buildRendererState } from './buildRendererState';
import { createInitialState } from '../state/defaults';
import { chromashiftReducer } from '../state/chromashiftReducer';
import { PROFILE_LUT_BYTES } from './color/colorProfile';

const ANGLES: [number, number, number] = [0, 0, 0];

describe('buildRendererState colour profiles', () => {
  it('keeps the classic branchy path with no LUT', () => {
    const state = buildRendererState(createInitialState(), ANGLES);
    expect(state.colorProfileMode).toBe(0);
    expect(state.colorProfileLut).toBeNull();
  });

  it('bakes a LUT for a built-in alternate profile', () => {
    const app = chromashiftReducer(createInitialState(), {
      type: 'layers/patch',
      patch: { colorProfileId: 'diagnostic-grey' },
    });
    const state = buildRendererState(app, ANGLES);
    expect(state.colorProfileMode).toBe(1);
    expect(state.colorProfileLut).toHaveLength(PROFILE_LUT_BYTES);
    expect(state.colorProfileLightDark).toBe(1);
  });

  it('reports the raw lookup mode for profiles that skip the lightDark lift', () => {
    const app = chromashiftReducer(createInitialState(), {
      type: 'layers/patch',
      patch: { colorProfileId: 'cr0p-soft-gradient' },
    });
    expect(buildRendererState(app, ANGLES).colorProfileLightDark).toBe(0);
  });

  it('falls back to classic for an unknown profile id', () => {
    const app = chromashiftReducer(createInitialState(), {
      type: 'layers/patch',
      patch: { colorProfileId: 'does-not-exist' },
    });
    const state = buildRendererState(app, ANGLES);
    expect(state.colorProfileMode).toBe(0);
    expect(state.colorProfileLut).toBeNull();
  });

  it('reuses the baked LUT across frames at the same average luminance', () => {
    const app = chromashiftReducer(createInitialState(), {
      type: 'layers/patch',
      patch: { colorProfileId: 'diagnostic-grey' },
    });
    const first = buildRendererState(app, ANGLES).colorProfileLut;
    expect(buildRendererState(app, ANGLES).colorProfileLut).toBe(first);
  });
});

describe('buildRendererState per-slot object reuse', () => {
  it('returns the same object (and layers tuple) across calls with the same slot', () => {
    const state = createInitialState();
    const first = buildRendererState(state, ANGLES, {}, 'test-slot-a');
    const second = buildRendererState(state, [10, 20, 30], {}, 'test-slot-a');
    expect(second).toBe(first);
    expect(second.layers).toBe(first.layers);
    expect(second.layers[0].angleDeg).toBe(10);
  });

  it('does not share state between different slots', () => {
    const state = createInitialState();
    const a = buildRendererState(state, [1, 2, 3], {}, 'test-slot-b');
    const b = buildRendererState(state, [4, 5, 6], {}, 'test-slot-c');
    expect(a).not.toBe(b);
    expect(a.layers[0].angleDeg).toBe(1);
    expect(b.layers[0].angleDeg).toBe(4);
  });

  it('allocates a fresh object every call when no slot is given', () => {
    const state = createInitialState();
    const first = buildRendererState(state, ANGLES);
    const second = buildRendererState(state, ANGLES);
    expect(second).not.toBe(first);
  });

  it('applies overrides on top of the reused object without leaking stale overrides', () => {
    const state = createInitialState();
    const withOverride = buildRendererState(state, ANGLES, { paused: true }, 'test-slot-d');
    expect(withOverride.paused).toBe(true);
    const withoutOverride = buildRendererState(state, ANGLES, {}, 'test-slot-d');
    expect(withoutOverride.paused).toBe(state.engine.paused);
  });
});
