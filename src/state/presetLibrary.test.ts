import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getStoredPreset, listStoredPresets, saveStoredPreset } from './presetLibrary';
import { createInitialState } from './defaults';

const STORAGE_KEY = 'chromashift.presets';

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('presetLibrary', () => {
  it('round-trips a saved preset', () => {
    saveStoredPreset('  mine ', createInitialState());
    expect(listStoredPresets().map((preset) => preset.name)).toEqual(['mine']);
    expect(getStoredPreset('mine')?.document.version).toBe(8);
  });

  it('hands back the decoded document, not the raw stored one', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([
      {
        name: 'crafted',
        savedAt: 'yesterday',
        document: { version: 8, settings: { engine: { fps: 0, gpuReady: true }, ui: { exportingVideo: true } } },
      },
    ]));
    const preset = getStoredPreset('crafted');
    expect(preset?.savedAt).toBe(0);
    expect(preset?.document.settings.engine).toEqual({ fps: 1 });
    expect(preset?.document.settings.ui).toEqual({});
  });

  it('skips entries it cannot use and survives a corrupt store', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([
      null,
      { name: '', document: { version: 8, settings: {} } },
      { name: 'old', document: { version: 99, settings: {} } },
      { name: 'ok', savedAt: 5, document: { version: 8, settings: {} } },
    ]));
    expect(listStoredPresets().map((preset) => preset.name)).toEqual(['ok']);

    localStorage.setItem(STORAGE_KEY, '{not json');
    expect(listStoredPresets()).toEqual([]);
  });
});
