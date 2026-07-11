import { useCallback, useState } from 'react';
import { BUILTIN_PRESETS, findBuiltinPreset } from '../state/presetGallery';
import {
  deleteStoredPreset,
  getStoredPreset,
  listStoredPresets,
  saveStoredPreset,
  type StoredPreset,
} from '../state/presetLibrary';
import { PRESET_URL_PARAM, buildPresetUrl, encodeSettingsParam } from '../state/presetUrl';
import { deserializeSettings, settingsToJson } from '../state/serializeSettings';
import type { ChromashiftStore } from './useChromashiftStore';

export function usePresets(store: ChromashiftStore) {
  const { state, actions } = store;
  const [savedPresets, setSavedPresets] = useState<StoredPreset[]>(() => listStoredPresets());
  const [presetStatus, setPresetStatus] = useState<string | null>(null);
  const [presetError, setPresetError] = useState<string | null>(state.ui.presetLoadError);

  const handleSavePreset = useCallback((name: string) => {
    const trimmed = name.trim();
    if (!trimmed) {
      setPresetError('Preset name cannot be empty.');
      return;
    }
    setSavedPresets(saveStoredPreset(trimmed, state));
    setPresetError(null);
    setPresetStatus(`Saved “${trimmed}”`);
  }, [state]);

  const handleLoadPreset = useCallback((name: string) => {
    const preset = getStoredPreset(name);
    if (!preset) {
      setPresetError(`Preset “${name}” was not found.`);
      return;
    }
    actions.applySettings(preset.document.settings);
    setPresetError(null);
    setPresetStatus(`Loaded “${name}”`);
  }, [actions]);

  const handleDeletePreset = useCallback((name: string) => {
    setSavedPresets(deleteStoredPreset(name));
    setPresetStatus(`Deleted “${name}”`);
  }, []);

  const handleApplyBuiltinPreset = useCallback((id: string) => {
    const preset = findBuiltinPreset(id);
    if (!preset) return;
    actions.applySettings(preset.settings);
    setPresetError(null);
    setPresetStatus(`Applied “${preset.name}”`);
  }, [actions]);

  const handleCopyPresetUrl = useCallback(async () => {
    const url = buildPresetUrl(state, window.location.href);
    // Keep the address bar in sync so a plain reload restores this look too.
    try {
      const current = new URL(window.location.href);
      current.searchParams.set(PRESET_URL_PARAM, encodeSettingsParam(state));
      window.history.replaceState(null, '', current.toString());
    } catch {
      // history can be unavailable in embedded contexts; the copy still works
    }
    try {
      await navigator.clipboard.writeText(url);
      setPresetStatus('Share URL copied to clipboard');
      setPresetError(null);
    } catch {
      setPresetError('Could not access the clipboard — the preset URL is in the address bar.');
    }
  }, [state]);

  const handleExportPresetFile = useCallback(() => {
    const blob = new Blob([settingsToJson(state)], { type: 'application/json' });
    const href = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = href;
    link.download = 'chromashift-preset.json';
    link.click();
    URL.revokeObjectURL(href);
    setPresetStatus('Preset exported');
  }, [state]);

  const handleImportPresetFile = useCallback(async (file: File) => {
    const text = await file.text();
    const doc = deserializeSettings(text);
    if (!doc) {
      setPresetError(`“${file.name}” is not a valid Chromashift preset (corrupted or incompatible version).`);
      return;
    }
    actions.applySettings(doc.settings);
    setPresetError(null);
    setPresetStatus(`Imported “${file.name}”`);
  }, [actions]);

  return {
    builtinPresets: BUILTIN_PRESETS,
    savedPresets,
    presetStatus,
    presetError,
    handleSavePreset,
    handleLoadPreset,
    handleDeletePreset,
    handleApplyBuiltinPreset,
    handleCopyPresetUrl,
    handleExportPresetFile,
    handleImportPresetFile,
  };
}
