import type { ImageEntry } from '../../engine/TextureManager';
import type { LiveSourceState } from '../types';
import type { ChromashiftDispatch } from './types';

export function createMediaActions(dispatch: ChromashiftDispatch) {
  return {
    setImageList: (imageList: ImageEntry[]) =>
      dispatch({ type: 'media/patch', patch: { imageList } }),
    setCurrentImageIndex: (currentIndex: number) =>
      dispatch({ type: 'media/patch', patch: { currentIndex } }),
    setReferenceImage: (reference: ImageEntry | null) =>
      dispatch({ type: 'media/patch', patch: { reference } }),
    setPreviousImage: (previous: ImageEntry | null) =>
      dispatch({ type: 'media/patch', patch: { previous } }),
    setImageAspect: (aspect: number) =>
      dispatch({ type: 'media/patch', patch: { aspect } }),
    setSpecificImageError: (specificError: string | null) =>
      dispatch({ type: 'media/patch', patch: { specificError } }),
    setLiveSource: (patch: Partial<LiveSourceState>) =>
      dispatch({ type: 'media/patchLiveSource', patch }),
  };
}
