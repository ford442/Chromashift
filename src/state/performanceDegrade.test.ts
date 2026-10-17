import { describe, expect, it } from 'vitest';
import { MOTION_MODES, type MotionMode } from '../engine/motionModes';
import { chromashiftReducer, createInitialState } from './chromashiftReducer';

function degradeFrom(mode: MotionMode) {
  const state = createInitialState();
  const start = { ...state, tracers: { ...state.tracers, motionMode: mode } };
  return chromashiftReducer(start, { type: 'ui/applyPerformanceDegrade' });
}

describe('ui/applyPerformanceDegrade motion step', () => {
  it('maps direction to boost', () => {
    expect(degradeFrom('direction').tracers.motionMode).toBe('boost');
  });

  it('leaves every other motion mode untouched', () => {
    for (const mode of MOTION_MODES.filter((m) => m !== 'direction')) {
      expect(degradeFrom(mode).tracers.motionMode).toBe(mode);
    }
  });

  it('still applies the existing degrade steps', () => {
    const next = degradeFrom('direction');
    expect(next.output.antialiasEnabled).toBe(false);
    expect(next.output.livePreviewEnabled).toBe(false);
  });

  it('lets the user switch back to direction afterwards', () => {
    const degraded = degradeFrom('direction');
    const back = chromashiftReducer(degraded, {
      type: 'tracers/patch',
      patch: { motionMode: 'direction' },
    });
    expect(back.tracers.motionMode).toBe('direction');
  });
});
