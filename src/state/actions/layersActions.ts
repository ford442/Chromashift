import type { ColorProfile } from '../../engine/color/colorProfile';
import type { LayerTriple } from '../types';
import type { ChromashiftDispatch } from './types';

export function createLayersActions(dispatch: ChromashiftDispatch) {
  return {
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
    /**
     * Select a colour profile. `profile` is embedded in state (and therefore in
     * exported presets) for user profiles; pass `null` for built-ins.
     */
    setColorProfile: (colorProfileId: string, colorProfile: ColorProfile | null = null) =>
      dispatch({ type: 'layers/patch', patch: { colorProfileId, colorProfile } }),
  };
}
