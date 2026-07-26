import type { CompareLayoutMode, QuadLayerIndex } from '../../engine/compareViews';
import type { ChromashiftSettingsInput } from '../chromashiftReducer';
import type { ChromashiftDispatch } from './types';

export function createCompareActions(dispatch: ChromashiftDispatch) {
  return {
    setCompareLayout: (layout: CompareLayoutMode) =>
      dispatch({ type: 'compare/setLayout', layout }),
    setCompareSyncPlay: (syncPlay: boolean) =>
      dispatch({ type: 'compare/setSyncPlay', syncPlay }),
    setCompareSlotB: (label: string, settings: ChromashiftSettingsInput) =>
      dispatch({ type: 'compare/setSlotB', label, settings }),
    setCompareSwipePosition: (swipePosition: number) =>
      dispatch({ type: 'compare/setSwipePosition', swipePosition }),
    cycleQuadLayer: () => dispatch({ type: 'compare/cycleQuadLayer' }),
    setQuadLayerIndex: (quadLayerIndex: QuadLayerIndex) =>
      dispatch({ type: 'compare/setQuadLayerIndex', quadLayerIndex }),
  };
}
