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

/**
 * Decode one stored entry, or null. The document is replaced by its decoded,
 * migrated form — what gets applied is what the schema accepted, never the raw
 * localStorage object.
 */
function readEntry(entry: unknown): StoredPreset | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const { name, savedAt, document } = entry as Record<string, unknown>;
  if (typeof name !== 'string' || !name) return null;
  const decoded = deserializeSettings(JSON.stringify(document ?? null));
  if (!decoded) return null;
  return {
    name,
    savedAt: typeof savedAt === 'number' && Number.isFinite(savedAt) ? savedAt : 0,
    document: decoded,
  };
}

function readAll(): StoredPreset[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(readEntry).filter((entry): entry is StoredPreset => entry !== null);
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
