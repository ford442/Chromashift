import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MOTION_MODE,
  MOTION_MODES,
  motionModeIndex,
  parseMotionMode,
} from './motionModes';

describe('motion modes', () => {
  it('keeps `off` first so the shader encoding of 0 means "no temporal term"', () => {
    expect(MOTION_MODES[0]).toBe('off');
    expect(motionModeIndex('off')).toBe(0);
    expect(DEFAULT_MOTION_MODE).toBe('off');
  });

  it('encodes every mode to its index', () => {
    expect(MOTION_MODES.map(motionModeIndex)).toEqual([0, 1, 2, 3]);
  });

  it('narrows an untrusted value, defaulting to off', () => {
    expect(parseMotionMode('gate')).toBe('gate');
    expect(parseMotionMode('wormhole')).toBe('off');
    expect(parseMotionMode(undefined)).toBe('off');
    expect(parseMotionMode(2)).toBe('off');
    expect(parseMotionMode(null)).toBe('off');
  });
});
