import type { ColorProfile } from '../../engine/color/colorProfile';
import type { ChromashiftDispatch } from './types';

export function createLayersActions(dispatch: ChromashiftDispatch) {
  return {
    /** Change how many band layers the session renders (1–`MAX_LAYER_COUNT`). */
    setLayerCount: (count: number) =>
      dispatch({ type: 'layers/setCount', count }),
    setLayerExtensions: (extensions: number[]) =>
      dispatch({ type: 'layers/patch', patch: { extensions } }),
    setLayerOpacity: (opacity: number) =>
      dispatch({ type: 'layers/patch', patch: { opacity } }),
    setLayerOpacities: (opacities: number[]) =>
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
