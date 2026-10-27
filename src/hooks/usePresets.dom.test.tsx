import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_PRESETS } from '../state/presetGallery';
import { PRESET_URL_PARAM } from '../state/presetUrl';
import { settingsToJson } from '../state/serializeSettings';
import { renderAppHook } from '../test/renderAppHook';
import { usePresets } from './usePresets';

const render = () => renderAppHook((_refs, store) => usePresets(store));

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard');
});

function stubClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}

describe('usePresets', () => {
  it('saves the current look under a trimmed name, and refuses an empty one', () => {
    const { result } = render();
    act(() => result.current.value.handleSavePreset('   '));
    expect(result.current.value.presetError).toBe('Preset name cannot be empty.');
    expect(result.current.value.savedPresets).toEqual([]);

    act(() => result.current.value.handleSavePreset('  Night  '));
    expect(result.current.value.savedPresets.map((p) => p.name)).toEqual(['Night']);
    expect(result.current.value.presetStatus).toBe('Saved “Night”');
    expect(result.current.value.presetError).toBeNull();
  });

  it('loads a saved preset back into the store, and names one it cannot find', () => {
    const { result } = render();
    act(() => result.current.store.actions.setParam('tracers.aboveIntensity', 0.25));
    act(() => result.current.value.handleSavePreset('Dim'));
    act(() => result.current.store.actions.setParam('tracers.aboveIntensity', 0.9));

    act(() => result.current.value.handleLoadPreset('Dim'));
    expect(result.current.store.state.tracers.aboveIntensity).toBe(0.25);
    expect(result.current.value.presetStatus).toBe('Loaded “Dim”');

    act(() => result.current.value.handleLoadPreset('Missing'));
    expect(result.current.value.presetError).toBe('Preset “Missing” was not found.');
  });

  it('deletes a saved preset', () => {
    const { result } = render();
    act(() => result.current.value.handleSavePreset('Gone'));
    act(() => result.current.value.handleDeletePreset('Gone'));
    expect(result.current.value.savedPresets).toEqual([]);
    expect(result.current.value.presetStatus).toBe('Deleted “Gone”');
  });

  it('applies a built-in preset and marks it active', () => {
    const { result } = render();
    const preset = BUILTIN_PRESETS[1]!;
    act(() => result.current.value.handleApplyBuiltinPreset(preset.id));
    expect(result.current.value.activePresetId).toBe(preset.id);
    expect(result.current.value.presetStatus).toBe(`Applied “${preset.name}”`);

    // An unknown id is a no-op, not an error.
    act(() => result.current.value.handleApplyBuiltinPreset('no-such-preset'));
    expect(result.current.value.activePresetId).toBe(preset.id);
  });

  it('compares with a built-in preset in the dual layout', () => {
    const { result } = render();
    const preset = BUILTIN_PRESETS[0]!;
    act(() => result.current.value.handleCompareWithBuiltin(preset.id));
    const compare = result.current.store.state.ui.compareView;
    expect(compare.layout).toBe('dual');
    expect(compare.slotB.label).toBe(preset.name);
  });

  it('imports a preset file, and rejects one that does not decode', async () => {
    const { result } = render();
    const source = render().result.current.store;
    act(() => source.actions.setParam('tracers.belowIntensity', 0.05));
    const good = new File([settingsToJson(source.getState())], 'look.json', { type: 'application/json' });

    await act(() => result.current.value.handleImportPresetFile(good));
    expect(result.current.store.state.tracers.belowIntensity).toBe(0.05);
    expect(result.current.value.presetStatus).toBe('Imported “look.json”');

    const bad = new File(['{"version": 99}'], 'broken.json');
    await act(() => result.current.value.handleImportPresetFile(bad));
    expect(result.current.value.presetError).toMatch(/“broken\.json” is not a valid Chromashift preset/);
  });

  it('copies a share URL and keeps the address bar in sync with it', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    stubClipboard(writeText);
    const { result } = render();

    await act(() => result.current.value.handleCopyPresetUrl());
    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = new URL(writeText.mock.calls[0]![0]);
    expect(copied.searchParams.get(PRESET_URL_PARAM)).toBeTruthy();
    expect(new URL(window.location.href).searchParams.get(PRESET_URL_PARAM))
      .toBe(copied.searchParams.get(PRESET_URL_PARAM));
    expect(result.current.value.presetStatus).toBe('Share URL copied to clipboard');
  });

  it('falls back to the address bar when the clipboard is refused', async () => {
    stubClipboard(() => Promise.reject(new Error('denied')));
    const { result } = render();
    await act(() => result.current.value.handleCopyPresetUrl());
    expect(result.current.value.presetError).toMatch(/the preset URL is in the address bar/);
    expect(new URL(window.location.href).searchParams.has(PRESET_URL_PARAM)).toBe(true);
  });

  it('starts with the error from a ?preset= that did not decode', () => {
    window.history.replaceState(null, '', `/?${PRESET_URL_PARAM}=not-a-preset`);
    const { result } = render();
    expect(result.current.value.presetError).toBeTruthy();
    expect(result.current.value.presetError).toBe(result.current.store.state.ui.presetLoadError);
  });
});
