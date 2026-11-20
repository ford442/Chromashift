/**
 * The live source's average luminance, measured where its frames arrive: in
 * the render service (`render/RenderService.ts`), which on the worker
 * transport is off the page's thread. It used to be measured on the page and
 * dispatched into the reducer once a second, which re-rendered the whole tree.
 */
import { getReadback2DContext, type Readback2DContext } from '../gpu/readbackContext';
import { computeAverageLuminanceStridedWith } from '../WasmEngine';
import { liveFrameSize, type LiveFrameSource } from './liveSourceTexture';

/** Frames are downscaled to this on the longest edge before they are read. */
const MAX_DIMENSION = 256;

/** How often a live source is measured (ms). */
export const LIVE_LUMINANCE_INTERVAL_MS = 1000;

let canvas: OffscreenCanvas | HTMLCanvasElement | null = null;
let context: Readback2DContext | null = null;

function scratchContext(width: number, height: number): Readback2DContext | null {
  if (!canvas) {
    canvas = typeof OffscreenCanvas === 'function'
      ? new OffscreenCanvas(width, height)
      : typeof document !== 'undefined' ? document.createElement('canvas') : null;
    // Read back every second for as long as the source runs.
    context = canvas ? getReadback2DContext(canvas, { willReadFrequently: true }) : null;
  }
  if (!canvas || !context) return null;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  return context;
}

/**
 * Average ITU-R BT.709 luminance (0–255) of one live frame, downsampled to
 * ≤256 px on the longest edge. 128 — the neutral default — before a frame has
 * decoded, or where there is no 2D canvas.
 */
export function measureLiveFrameLuminance(frame: LiveFrameSource, useWasm: boolean): number {
  const { width, height } = liveFrameSize(frame);
  if (!width || !height) return 128;
  const scale = Math.min(1, MAX_DIMENSION / Math.max(width, height));
  const w = Math.max(1, Math.floor(width * scale));
  const h = Math.max(1, Math.floor(height * scale));
  const ctx = scratchContext(w, h);
  if (!ctx) return 128;
  ctx.drawImage(frame, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  return computeAverageLuminanceStridedWith(data, w, h, 1, useWasm);
}
