import type { LayerTriple } from '../types';
import type { ChromashiftDispatch } from './types';

export function createLayersActions(dispatch: ChromashiftDispatch) {
  return {
    setLayerAngles: (angles: LayerTriple<number>) =>
      dispatch({ type: 'layers/patch', patch: { angles } }),
    setLayerExtensions: (extensions: LayerTriple<number>) =>
      dispatch({ type: 'layers/patch', patch: { extensions } }),
    setLayerOpacity: (opacity: number) =>
      dispatch({ type: 'layers/patch', patch: { opacity } }),
    setLayerOpacities: (opacities: LayerTriple<number>) =>
      dispatch({ type: 'layers/patch', patch: { opacities } }),
    setLayerScale: (scale: number) =>
      dispatch({ type: 'layers/patch', patch: { scale } }),
    setColorMode: (colorMode: number) =>
      dispatch({ type: 'layers/patch', patch: { colorMode } }),
    setSobelEnabled: (sobelEnabled: boolean) =>
      dispatch({ type: 'layers/patch', patch: { sobelEnabled } }),
    setSoftCropEnabled: (softCropEnabled: boolean) =>
      dispatch({ type: 'layers/patch', patch: { softCropEnabled } }),
  };
}
