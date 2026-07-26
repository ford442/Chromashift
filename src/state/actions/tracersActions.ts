import type { ChromashiftDispatch } from './types';

export function createTracersActions(dispatch: ChromashiftDispatch) {
  return {
    setTracerScale: (scale: number) =>
      dispatch({ type: 'tracers/patch', patch: { scale } }),
    setTracerAboveIntensity: (aboveIntensity: number) =>
      dispatch({ type: 'tracers/patch', patch: { aboveIntensity } }),
    setTracerBelowIntensity: (belowIntensity: number) =>
      dispatch({ type: 'tracers/patch', patch: { belowIntensity } }),
    setTracerAboveDuration: (aboveDuration: number) =>
      dispatch({ type: 'tracers/patch', patch: { aboveDuration } }),
    setTracerBelowDuration: (belowDuration: number) =>
      dispatch({ type: 'tracers/patch', patch: { belowDuration } }),
    setTracerMode: (mode: number) =>
      dispatch({ type: 'tracers/patch', patch: { mode } }),
    setLayerBlendMode: (layerBlendMode: number) =>
      dispatch({ type: 'tracers/patch', patch: { layerBlendMode } }),
    setTracerBlendMode: (tracerBlendMode: number) =>
      dispatch({ type: 'tracers/patch', patch: { tracerBlendMode } }),
  };
}
