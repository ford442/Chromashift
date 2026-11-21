/** The Original thumbnail's size, for the renderer to decode it at (`load-source`'s `preview`). */
import { getReadback2DContext } from '../engine/gpu/readbackContext';

export function previewSizeOf(canvas: HTMLCanvasElement | null): { width: number; height: number } | undefined {
  if (!canvas || canvas.width <= 0 || canvas.height <= 0) return undefined;
  return { width: canvas.width, height: canvas.height };
}

/** Draw the decoded thumbnail into the Original preview, stretched to fill it, and release it. */
export function drawOriginalPreview(target: HTMLCanvasElement | null, bitmap: ImageBitmap | null): void {
  if (!bitmap) return;
  try {
    if (target) getReadback2DContext(target)?.drawImage(bitmap, 0, 0, target.width, target.height);
  } finally {
    bitmap.close();
  }
}
