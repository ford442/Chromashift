import type { ChromashiftSettingsInput } from '../chromashiftReducer';
import type { ChromashiftDispatch } from './types';

export function createSettingsActions(dispatch: ChromashiftDispatch) {
  return {
    resetRenderDefaults: () => dispatch({ type: 'reset/renderDefaults' }),
    applySettings: (settings: ChromashiftSettingsInput) =>
      dispatch({ type: 'settings/apply', settings }),
  };
}
