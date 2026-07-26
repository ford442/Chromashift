import { createCompareActions } from './compareActions';
import { createEngineActions } from './engineActions';
import { createLayersActions } from './layersActions';
import { createMediaActions } from './mediaActions';
import { createOutputActions } from './outputActions';
import { createReactiveActions } from './reactiveActions';
import { createSettingsActions } from './settingsActions';
import { createTracersActions } from './tracersActions';
import { createUiActions } from './uiActions';
import type { ChromashiftDispatch } from './types';

export type { ChromashiftDispatch } from './types';

export function createChromashiftActions(dispatch: ChromashiftDispatch) {
  return {
    dispatch,
    ...createSettingsActions(dispatch),
    ...createMediaActions(dispatch),
    ...createLayersActions(dispatch),
    ...createTracersActions(dispatch),
    ...createOutputActions(dispatch),
    ...createEngineActions(dispatch),
    ...createUiActions(dispatch),
    ...createCompareActions(dispatch),
    ...createReactiveActions(dispatch),
  };
}

export type ChromashiftActions = ReturnType<typeof createChromashiftActions>;
