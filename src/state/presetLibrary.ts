import {
  deserializeSettings,
  serializeSettings,
  type ChromashiftSettingsDocument,
} from './serializeSettings';
import type { ChromashiftState } from './types';

const STORAGE_KEY = 'chromashift.presets';

export interface StoredPreset {
  name: string;
  savedAt: number;
  document: ChromashiftSettingsDocument;
}

function readAll(): StoredPreset[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StoredPreset[];
    if (!Array.isArray(parsed)) return [];
    // Re-validate each document so a stale schema version can't be applied.
    return parsed.filter(
      (entry) => typeof entry?.name === 'string'
        && deserializeSettings(JSON.stringify(entry.document)) !== null,
    );
  } catch {
    return [];
  }
}

function writeAll(presets: StoredPreset[]): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
    return true;
  } catch {
    return false;
  }
}

export function listStoredPresets(): StoredPreset[] {
  return readAll().sort((a, b) => b.savedAt - a.savedAt);
}

export function saveStoredPreset(name: string, state: ChromashiftState): StoredPreset[] {
  const trimmed = name.trim();
  if (!trimmed) return listStoredPresets();
  const entry: StoredPreset = {
    name: trimmed,
    savedAt: Date.now(),
    document: serializeSettings(state),
  };
  const others = readAll().filter((preset) => preset.name !== trimmed);
  writeAll([entry, ...others]);
  return listStoredPresets();
}

export function deleteStoredPreset(name: string): StoredPreset[] {
  writeAll(readAll().filter((preset) => preset.name !== name));
  return listStoredPresets();
}

export function getStoredPreset(name: string): StoredPreset | null {
  return readAll().find((preset) => preset.name === name) ?? null;
}
