import type { ImageEntry } from './imageEntry';
import type { OverlayImageSource } from '../../components/overlay/types';

export function isOverlayImageSourceAvailable(
  source: OverlayImageSource,
  currentImage: ImageEntry | null,
  reference: ImageEntry | null,
  previous: ImageEntry | null,
): boolean {
  switch (source) {
    case 'source':
      return currentImage !== null;
    case 'reference':
      return reference !== null;
    case 'previous':
      return previous !== null;
    case 'separated':
      return true;
    default:
      return false;
  }
}
