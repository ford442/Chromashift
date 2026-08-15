/**
 * Canvas-backed helpers for reading pixel bytes out of an `HTMLImageElement`.
 * Shared by both the WASM dispatch path (heap copy source) and the TS fallbacks.
 */

/** Downscale to ≤256 px on the longest edge and read RGBA bytes. */
export function getImageBytes(image: HTMLImageElement): Uint8ClampedArray | null {
  const canvas = document.createElement('canvas');
  const MAX_SIZE = 256;
  const scale = Math.min(1, MAX_SIZE / Math.max(image.naturalWidth, image.naturalHeight));
  canvas.width  = Math.max(1, Math.floor(image.naturalWidth  * scale));
  canvas.height = Math.max(1, Math.floor(image.naturalHeight * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
}

/** Read RGBA bytes at the image's natural resolution. */
export function getImageDataAtNaturalSize(image: HTMLImageElement): ImageData | null {
  const width = Math.max(1, image.naturalWidth || image.width || 1);
  const height = Math.max(1, image.naturalHeight || image.height || 1);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}
