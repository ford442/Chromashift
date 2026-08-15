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
