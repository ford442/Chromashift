import { createInitialState } from './defaults';
import { chromashiftReducer } from './chromashiftReducer';
import {
  deserializeSettings,
  serializeSettings,
  type ChromashiftSettingsDocument,
} from './serializeSettings';
import type { ChromashiftState } from './types';

export const PRESET_URL_PARAM = 'preset';

/** UTF-8 string → base64url (RFC 4648 §5, no padding). */
export function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url → UTF-8 string. Throws on malformed input. */
export function fromBase64Url(encoded: string): string {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

/** Encode the current render settings as a compact ?preset= parameter value. */
export function encodeSettingsParam(state: ChromashiftState): string {
  return toBase64Url(JSON.stringify(serializeSettings(state)));
}

/** Decode a ?preset= parameter value. Returns null when malformed or wrong version. */
export function decodeSettingsParam(param: string): ChromashiftSettingsDocument | null {
  try {
    return deserializeSettings(fromBase64Url(param));
  } catch {
    return null;
  }
}

/** Build a shareable URL carrying the current settings. */
export function buildPresetUrl(state: ChromashiftState, baseUrl: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set(PRESET_URL_PARAM, encodeSettingsParam(state));
  return url.toString();
}

export interface UrlPresetResult {
  document: ChromashiftSettingsDocument | null;
  /** Friendly error when a preset param was present but unusable. */
  error: string | null;
}

/** Read and validate the preset parameter from a location search string. */
export function readPresetFromSearch(search: string): UrlPresetResult {
  let param: string | null = null;
  try {
    param = new URLSearchParams(search).get(PRESET_URL_PARAM);
  } catch {
    param = null;
  }
  if (!param) return { document: null, error: null };

  const document = decodeSettingsParam(param);
  if (!document) {
    return {
      document: null,
      error: 'The preset in this URL could not be read (corrupted or from an incompatible version). Default settings were loaded instead.',
    };
  }
  return { document, error: null };
}

/**
 * Build the app's initial state, applying a ?preset= URL parameter when
 * present. Runs inside useReducer's lazy initializer, so the preset is in
 * effect before the first frame renders — no flash of default settings.
 * Invalid presets fall back to defaults with ui.presetLoadError set.
 */
export function createInitialStateFromUrl(search?: string): ChromashiftState {
  const base = createInitialState();
  const effectiveSearch = search ?? (typeof window !== 'undefined' ? window.location.search : '');
  if (!effectiveSearch) return base;

  const { document, error } = readPresetFromSearch(effectiveSearch);
  if (error) {
    return { ...base, ui: { ...base.ui, presetLoadError: error } };
  }
  if (!document) return base;

  return chromashiftReducer(base, { type: 'settings/apply', settings: document.settings });
}
