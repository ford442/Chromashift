import { useCallback } from 'react';
import type { MutableRefObject } from 'react';
import type { ImageEntry } from '../../engine/TextureManager';
import type { ChromashiftDispatch } from '../../state/actions';
import type { LayerTriple } from '../../state/types';

export function ensureReferenceImage(list: ImageEntry[], preferredCurrentIndex: number): ImageEntry | null {
  if (list.length <= 1) return null;
  return preferredCurrentIndex === 0 ? list[1] : list[0];
}

export function useSelectSourceIndex(
  dispatch: ChromashiftDispatch,
  imageListRef: MutableRefObject<ImageEntry[]>,
  currentImageIndexRef: MutableRefObject<number>,
) {
  return useCallback((nextIndex: number) => {
    const list = imageListRef.current;
    const currentIndexValue = currentImageIndexRef.current;
    if (nextIndex < 0 || nextIndex >= list.length || nextIndex === currentIndexValue) return;
    const currentEntry = list[currentIndexValue];
    dispatch({
      type: 'media/selectIndex',
      index: nextIndex,
      previous: currentEntry ?? null,
    });
  }, [dispatch, imageListRef, currentImageIndexRef]);
}

export function useHandleAngleChange(
  dispatch: ChromashiftDispatch,
  animAnglesRef: MutableRefObject<LayerTriple<number>>,
) {
  return useCallback((layer: 0 | 1 | 2, angle: number) => {
    animAnglesRef.current[layer] = angle;
    dispatch({ type: 'layers/setTriple', field: 'angles', layer, value: angle });
  }, [dispatch, animAnglesRef]);
}

export function useHandleExtensionChange(dispatch: ChromashiftDispatch) {
  return useCallback((layer: 0 | 1 | 2, extension: number) => {
    dispatch({ type: 'layers/setTriple', field: 'extensions', layer, value: extension });
  }, [dispatch]);
}
