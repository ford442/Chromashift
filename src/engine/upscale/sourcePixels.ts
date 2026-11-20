/**
 * Pixels in and out of the upscaler, through the engine's 2D contexts
 * (`gpu/readbackContext.ts`) rather than ad hoc canvases in the UI. Kept out
 * of `Upscaler.ts`, whose model code loads only when Upscale is clicked.
 */
import { getReadback2DContext } from '../gpu/readbackContext';

export interface RgbaPixels {
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
}

function scratchCanvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/**
 * The full-resolution RGBA8 pixels of the image at `url`. Fetched with
 * `mode: 'cors'` — what the old `<img crossOrigin="anonymous">` asked for — so
 * a cross-origin source without CORS fails here, not as a tainted canvas.
 */
export async function readImagePixels(url: string): Promise<RgbaPixels> {
  const response = await fetch(url, { mode: 'cors', credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Failed to load image for upscaling (HTTP ${response.status})`);
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const canvas = scratchCanvas(bitmap.width, bitmap.height);
    const ctx = getReadback2DContext(canvas);
    if (!ctx) throw new Error('2D context unavailable');
    ctx.drawImage(bitmap, 0, 0);
    const image = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return { data: image.data, width: image.width, height: image.height };
  } finally {
    bitmap.close();
  }
}

/** Draw RGBA8 `pixels` into `target`, stretched to fill it (the Original preview). */
export function drawPixelsInto(
  target: HTMLCanvasElement,
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): void {
  const ctx = getReadback2DContext(target);
  const scratch = scratchCanvas(width, height);
  const scratchCtx = getReadback2DContext(scratch);
  if (!ctx || !scratchCtx) return;
  const data = new Uint8ClampedArray(pixels.byteLength);
  data.set(pixels);
  scratchCtx.putImageData(new ImageData(data, width, height), 0, 0);
  ctx.drawImage(scratch, 0, 0, target.width, target.height);
}
