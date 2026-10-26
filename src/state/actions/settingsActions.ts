import type { ChromashiftSettingsInput } from '../chromashiftReducer';
import type { ParamPath } from '../params';
import type { ChromashiftDispatch } from './types';

export function createSettingsActions(dispatch: ChromashiftDispatch) {
  return {
    resetRenderDefaults: () => dispatch({ type: 'reset/renderDefaults' }),
    applySettings: (settings: ChromashiftSettingsInput, presetId?: string) =>
      dispatch({ type: 'settings/apply', settings, presetId }),
    /** Set any automatable parameter by path; the reducer coerces it into range. */
    setParam: (path: ParamPath, value: number) => dispatch({ type: 'param/set', path, value }),
  };
}
