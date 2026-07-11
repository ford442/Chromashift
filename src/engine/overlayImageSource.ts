import type { ImageEntry } from './TextureManager';
import type { OverlayImageSource } from '../components/overlay/types';

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

export function overlayImageSourceLabel(source: OverlayImageSource): string {
  switch (source) {
    case 'source':
      return 'Source';
    case 'reference':
      return 'Reference';
    case 'previous':
      return 'Previous';
    case 'separated':
      return 'Separated';
    default:
      return source;
  }
}
