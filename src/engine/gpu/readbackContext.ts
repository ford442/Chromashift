/**
 * The one place a 2D canvas context for *readback or export* is created, so
 * its `colorSpace` is decided next to the WebGPU configure
 * (`webgpu/canvasConfig.ts`) instead of at each call site.
 *
 * A 2D canvas defaults to `srgb`; asking for `display-p3` both keeps P3 pixel
 * values as written (no conversion on `putImageData`) and makes `toBlob`
 * embed a Display-P3 profile in the PNG.
 */
import type { DisplayColorSpace } from './gpuOptions';

export interface Readback2DOptions {
  colorSpace?: DisplayColorSpace;
  willReadFrequently?: boolean;
}

type Readback2DCanvas = HTMLCanvasElement | OffscreenCanvas;
type Readback2DContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function readback2DAttributes(options: Readback2DOptions = {}): CanvasRenderingContext2DSettings {
  return {
    colorSpace: options.colorSpace ?? 'srgb',
    ...(options.willReadFrequently ? { willReadFrequently: true } : {}),
  };
}

export function getReadback2DContext(
  canvas: HTMLCanvasElement,
  options?: Readback2DOptions,
): CanvasRenderingContext2D | null;
export function getReadback2DContext(
  canvas: OffscreenCanvas,
  options?: Readback2DOptions,
): OffscreenCanvasRenderingContext2D | null;
export function getReadback2DContext(
  canvas: Readback2DCanvas,
  options?: Readback2DOptions,
): Readback2DContext | null {
  return canvas.getContext('2d', readback2DAttributes(options)) as Readback2DContext | null;
}

/** The space a context actually ended up in (a UA without 2D colour spaces reports none: `srgb`). */
export function readback2DColorSpace(ctx: Readback2DContext): DisplayColorSpace {
  const read = (ctx as { getContextAttributes?: () => CanvasRenderingContext2DSettings }).getContextAttributes;
  const attrs = typeof read === 'function' ? read.call(ctx) : undefined;
  return attrs?.colorSpace === 'display-p3' ? 'display-p3' : 'srgb';
}
