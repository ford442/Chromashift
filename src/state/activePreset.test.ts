import { describe, expect, it } from 'vitest';
import { chromashiftReducer } from './chromashiftReducer';
import { createInitialState } from './defaults';
import { findBuiltinPreset } from './presetGallery';

describe('active gallery preset', () => {
  const cr0p = findBuiltinPreset('cr0p-reference')!;

  it('starts with no active preset', () => {
    expect(createInitialState().ui.activePresetId).toBeNull();
  });

  it('records the preset id on apply and clears it on a later settings edit', () => {
    const applied = chromashiftReducer(createInitialState(), {
      type: 'settings/apply', settings: cr0p.settings, presetId: cr0p.id,
    });
    expect(applied.ui.activePresetId).toBe('cr0p-reference');
    expect(applied.layers.colorMode).toBe(2);
    expect(applied.tracers.belowIntensity).toBe(0);

    const kept = chromashiftReducer(applied, { type: 'ui/patch', patch: { isImageStripOpen: true } });
    expect(kept.ui.activePresetId).toBe('cr0p-reference');

    const edited = chromashiftReducer(kept, { type: 'tracers/patch', patch: { belowIntensity: 0.3 } });
    expect(edited.ui.activePresetId).toBeNull();
  });

  it('clears the id when settings are applied without one', () => {
    const applied = chromashiftReducer(createInitialState(), {
      type: 'settings/apply', settings: cr0p.settings, presetId: cr0p.id,
    });
    const loaded = chromashiftReducer(applied, { type: 'settings/apply', settings: cr0p.settings });
    expect(loaded.ui.activePresetId).toBeNull();
  });
});
