import { chromashiftReducer } from '../state/chromashiftReducer';
import { createInitialState } from '../state/defaults';
import { PRESET_URL_PARAM, fromBase64Url } from '../state/presetUrl';
import { decodeSettingsDocument, type ChromashiftSettingsDocument } from '../state/serializeSettings';
import type { ChromashiftState } from '../state/types';

export interface LoadedSettings {
  state: ChromashiftState;
  /** Fields the schema decoder clamped, rounded or dropped, as `path: message`. */
  corrections: string[];
}

/**
 * The `?preset=` value inside `text`: a whole share URL, a `?preset=…` query,
 * or the bare base64url value.
 */
function presetParamValue(text: string): string {
  const trimmed = text.trim();
  const query = trimmed.includes('?') ? trimmed.slice(trimmed.indexOf('?')) : null;
  if (query) {
    const value = new URLSearchParams(query).get(PRESET_URL_PARAM);
    if (value) return value;
  }
  return trimmed.startsWith(`${PRESET_URL_PARAM}=`) ? trimmed.slice(PRESET_URL_PARAM.length + 1) : trimmed;
}

/**
 * A session's state from a settings document — the JSON the Presets panel
 * exports — or a `?preset=` share string, through the page's own decoder and
 * reducer (`settings/apply`), so a preset means here exactly what it means in
 * a tab. No argument: the session defaults.
 */
export function loadSettings(input?: string): LoadedSettings {
  const base = createInitialState();
  if (input === undefined || input.trim() === '') return { state: base, corrections: [] };

  const json = input.trimStart().startsWith('{') ? input : decodePresetParam(input);
  const { document, issues } = decodeSettingsDocument(json);
  if (!document) {
    throw new Error(`Unusable settings: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`);
  }
  return {
    state: applySettings(base, document),
    corrections: issues.map((issue) => `${issue.path}: ${issue.message}`),
  };
}

function decodePresetParam(text: string): string {
  try {
    return fromBase64Url(presetParamValue(text));
  } catch {
    throw new Error('Settings are neither a JSON document nor a ?preset= value.');
  }
}

function applySettings(state: ChromashiftState, document: ChromashiftSettingsDocument): ChromashiftState {
  return chromashiftReducer(state, { type: 'settings/apply', settings: document.settings });
}
