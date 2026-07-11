import { describe, expect, it } from 'vitest';
import type { ImageEntry } from './TextureManager';
import { isOverlayImageSourceAvailable } from './overlayImageSource';

const entry: ImageEntry = { url: 'https://example.com/a.jpg' };

describe('isOverlayImageSourceAvailable', () => {
  it('requires a current image for source overlay', () => {
    expect(isOverlayImageSourceAvailable('source', null, entry, entry)).toBe(false);
    expect(isOverlayImageSourceAvailable('source', entry, null, null)).toBe(true);
  });

  it('requires a reference for reference overlay', () => {
    expect(isOverlayImageSourceAvailable('reference', entry, null, entry)).toBe(false);
    expect(isOverlayImageSourceAvailable('reference', entry, entry, null)).toBe(true);
  });

  it('always allows separated overlay', () => {
    expect(isOverlayImageSourceAvailable('separated', null, null, null)).toBe(true);
  });
});
