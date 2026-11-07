import type { DisplayColorSpace } from '../gpu/gpuOptions';

/**
 * Set `drawingBufferColorSpace` (Chrome 104+, Safari 15.2+) and report whether
 * the default framebuffer now carries `space`. `false` where the property does
 * not exist or the UA ignored the value.
 */
export function tagWebGLDrawingBuffer(gl: WebGL2RenderingContext, space: DisplayColorSpace): boolean {
  if (!('drawingBufferColorSpace' in gl)) return space === 'srgb';
  try {
    gl.drawingBufferColorSpace = space;
  } catch {
    return false;
  }
  return gl.drawingBufferColorSpace === space;
}

/** The one-line diagnostics note; `null` for plain sRGB. */
export function webglPresentationNote(requested: DisplayColorSpace, tagged: boolean): string | null {
  if (requested === 'srgb') return null;
  return tagged
    ? 'WebGL Display P3: sRGB→P3 converted in the blit; drawing buffer tagged display-p3'
    : 'WebGL cannot tag the default framebuffer Display P3 — presenting sRGB, no conversion in the blit';
}
