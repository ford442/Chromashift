import type { MotionMode } from '../../engine/motionModes';
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
    setMotionMode: (motionMode: MotionMode) =>
      dispatch({ type: 'tracers/patch', patch: { motionMode } }),
    setMotionGain: (motionGain: number) =>
      dispatch({ type: 'tracers/patch', patch: { motionGain } }),
    setMotionDecayBias: (motionDecayBias: number) =>
      dispatch({ type: 'tracers/patch', patch: { motionDecayBias } }),
    setMotionThreshold: (motionThreshold: number) =>
      dispatch({ type: 'tracers/patch', patch: { motionThreshold } }),
  };
}
