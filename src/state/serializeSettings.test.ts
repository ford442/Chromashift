import { describe, expect, it } from 'vitest';
import { createInitialState } from './defaults';
import { chromashiftReducer } from './chromashiftReducer';
import { deserializeSettings, settingsToJson } from './serializeSettings';

describe('serializeSettings', () => {
  it('round-trips render settings through JSON', () => {
    const state = createInitialState();
    const mutated = chromashiftReducer(state, {
      type: 'layers/patch',
      patch: { opacity: 0.5, angles: [10, 20, 30] },
    });
    const json = settingsToJson(mutated);
    const doc = deserializeSettings(json);
    expect(doc?.settings.layers?.opacity).toBe(0.5);
    expect(doc?.settings.layers?.angles).toEqual([10, 20, 30]);
  });

  it('rejects invalid JSON payloads', () => {
    expect(deserializeSettings('not json')).toBeNull();
    expect(deserializeSettings('{"version":99}')).toBeNull();
  });
});
