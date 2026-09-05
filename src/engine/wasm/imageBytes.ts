/**
 * Canvas-backed helpers for reading pixel bytes out of a drawable image source.
 * Shared by both the WASM dispatch path (heap copy source) and the TS fallbacks.
 *
 * `PixelSource` covers both call sites that use these helpers:
 *  - `HTMLImageElement` on the main thread (the pre-worker call sites).
 *  - `ImageBitmap` inside `analysis.worker.ts`, which has no `document` and
 *    decodes an `ImageBitmap` transferred in from the main thread instead.
 *
 * A single canvas (2D on the main thread, `OffscreenCanvas` inside a worker)
 * is created once and reused across calls — resizing it to fit each source
 * rather than allocating a fresh canvas per call.
 */

export type PixelSource = HTMLImageElement | ImageBitmap;

type Canvas2DContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

let reusableCanvas: HTMLCanvasElement | OffscreenCanvas | null = null;
let reusableCtx: Canvas2DContext | null = null;
/**
 * The `document` the cached canvas was created against. Re-checked on every
 * call (rather than only creating once and never again) so that swapping the
 * global `document` — real navigation never does this, but `vi.stubGlobal`
 * in tests does, once per test — recreates the canvas instead of silently
 * replaying a previous test's stale mock.
 */
let canvasDocument: Document | null = null;

function isImageElement(source: PixelSource): source is HTMLImageElement {
  return 'naturalWidth' in source;
}

function sourceSize(source: PixelSource): { width: number; height: number } {
  if (isImageElement(source)) {
    return {
      width: Math.max(1, source.naturalWidth || source.width || 1),
      height: Math.max(1, source.naturalHeight || source.height || 1),
    };
  }
  return { width: Math.max(1, source.width || 1), height: Math.max(1, source.height || 1) };
}

/** Get (creating once per `document`) the shared canvas 2D context, resized to `width` × `height`. */
function getReusableCtx(width: number, height: number): Canvas2DContext | null {
  const currentDocument = typeof document !== 'undefined' ? document : null;
  if (!reusableCanvas || currentDocument !== canvasDocument) {
    reusableCanvas = currentDocument
      ? currentDocument.createElement('canvas')
      : new OffscreenCanvas(width, height);
    reusableCtx = reusableCanvas.getContext('2d') as Canvas2DContext | null;
    canvasDocument = currentDocument;
  }
  if (!reusableCtx) return null;
  if (reusableCanvas.width !== width) reusableCanvas.width = width;
  if (reusableCanvas.height !== height) reusableCanvas.height = height;
  return reusableCtx;
}

/** Downscale to ≤256 px on the longest edge and read RGBA bytes. */
export function getImageBytes(source: PixelSource): Uint8ClampedArray | null {
  const MAX_SIZE = 256;
  const { width: srcWidth, height: srcHeight } = sourceSize(source);
  const scale = Math.min(1, MAX_SIZE / Math.max(srcWidth, srcHeight));
  const width = Math.max(1, Math.floor(srcWidth * scale));
  const height = Math.max(1, Math.floor(srcHeight * scale));
  const ctx = getReusableCtx(width, height);
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height).data;
}

/** Read RGBA bytes at the source's natural resolution. */
export function getImageDataAtNaturalSize(source: PixelSource): ImageData | null {
  const { width, height } = sourceSize(source);
  const ctx = getReusableCtx(width, height);
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}
