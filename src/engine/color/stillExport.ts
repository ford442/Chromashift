/**
 * Still (PNG) export, tagged with the presentation space its pixels were
 * actually encoded for. The pixels come from the renderer's export readback
 * (`exportFrame` / `exportTracerView`); the 2D context comes from the shared
 * helper, so the tag and the conversion are decided in one place
 * (`presentation.ts`, `gpu/readbackContext.ts`).
 */
import type { DisplayColorSpace } from '../gpu/gpuOptions';
import { getReadback2DContext, readback2DColorSpace } from '../gpu/readbackContext';

export interface StillPixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface StillPng {
  blob: Blob;
  /** What the PNG is tagged with — `srgb` if the UA could not tag a 2D canvas. */
  colorSpace: DisplayColorSpace;
}

/**
 * Encode `pixels` (already in `space`) as a PNG tagged `space`. Resolves
 * `null` when the browser gives no 2D context or no blob.
 */
export function encodeStillPng(pixels: StillPixels, space: DisplayColorSpace): Promise<StillPng | null> {
  const canvas = document.createElement('canvas');
  canvas.width = pixels.width;
  canvas.height = pixels.height;
  const ctx = getReadback2DContext(canvas, { colorSpace: space });
  if (!ctx) return Promise.resolve(null);
  const applied = readback2DColorSpace(ctx);
  const data = new Uint8ClampedArray(pixels.data.length);
  data.set(pixels.data);
  // ImageData in the context's own space: putImageData then copies bytes as-is.
  const image = applied === 'srgb'
    ? new ImageData(data, pixels.width, pixels.height)
    : new ImageData(data, pixels.width, pixels.height, { colorSpace: applied });
  ctx.putImageData(image, 0, 0);
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob ? { blob, colorSpace: applied } : null), 'image/png');
  });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(href);
}

/**
 * The space a still can honestly be exported in: `requested`, unless this UA
 * cannot tag a 2D canvas `display-p3` — then `srgb`, and the caller renders
 * the frame for sRGB rather than writing P3 values into an sRGB file.
 */
export function stillExportSpace(requested: DisplayColorSpace): DisplayColorSpace {
  if (requested === 'srgb') return 'srgb';
  const probe = document.createElement('canvas');
  probe.width = 1;
  probe.height = 1;
  const ctx = getReadback2DContext(probe, { colorSpace: requested });
  return ctx ? readback2DColorSpace(ctx) : 'srgb';
}
