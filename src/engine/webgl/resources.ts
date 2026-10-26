import { flipRgbaRows } from './asyncReadback';
import {
  WEBGL_INTERNAL_FORMAT_HDR,
  WEBGL_INTERNAL_FORMAT_LDR,
  type WebGLInternalFormat,
} from '../gpu/gpuOptions';

export interface RenderTarget {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
}

/**
 * A multisample colour renderbuffer behind its own framebuffer. It cannot be
 * sampled: a pass draws into it and `resolveMultisampleTarget` blits it into a
 * single-sample `RenderTarget` of the same format.
 */
export interface MultisampleTarget {
  renderbuffer: WebGLRenderbuffer;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
  samples: number;
  format: WebGLInternalFormat;
}

/** Sized internal format, upload format and type for each target format. */
function glFormat(gl: WebGL2RenderingContext, format: WebGLInternalFormat) {
  return format === WEBGL_INTERNAL_FORMAT_HDR
    ? { internal: gl.RGBA16F, type: gl.HALF_FLOAT }
    : { internal: gl.RGBA8, type: gl.UNSIGNED_BYTE };
}

/**
 * A sampled colour target. `rgba8` (the default) is what every readback path
 * needs — `readTargetPixels` reads `UNSIGNED_BYTE`; `rgba16f` is for the
 * executor's pool, on a context `selectWebGLInternalFormat` cleared for it.
 * The internal format is always sized, so a multisample renderbuffer of the
 * same format can be blitted into it.
 */
export function createTarget(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  format: WebGLInternalFormat = WEBGL_INTERNAL_FORMAT_LDR,
): RenderTarget {
  const texture = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  if (!texture || !framebuffer) throw new Error('Failed to create WebGL render target.');
  const { internal, type } = glFormat(gl, format);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, gl.RGBA, type, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteTexture(texture);
    gl.deleteFramebuffer(framebuffer);
    throw new Error('WebGL framebuffer is incomplete.');
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { texture, framebuffer, width, height };
}

export function destroyTarget(gl: WebGL2RenderingContext, target: RenderTarget): void {
  gl.deleteTexture(target.texture);
  gl.deleteFramebuffer(target.framebuffer);
}

/**
 * The most samples the context supports for a `format` renderbuffer, capped at
 * `requested`. `1` means no multisampling is available for it.
 */
export function supportedSampleCount(
  gl: WebGL2RenderingContext,
  format: WebGLInternalFormat,
  requested: number,
): number {
  const counts = gl.getInternalformatParameter(gl.RENDERBUFFER, glFormat(gl, format).internal, gl.SAMPLES) as
    Int32Array | null;
  // Listed in descending order; take the largest that does not exceed the request.
  const best = counts ? [...counts].find((count) => count <= requested) : undefined;
  return Math.max(1, best ?? 1);
}

export function createMultisampleTarget(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  samples: number,
  format: WebGLInternalFormat,
): MultisampleTarget {
  const renderbuffer = gl.createRenderbuffer();
  const framebuffer = gl.createFramebuffer();
  if (!renderbuffer || !framebuffer) throw new Error('Failed to create WebGL multisample target.');
  gl.bindRenderbuffer(gl.RENDERBUFFER, renderbuffer);
  gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, glFormat(gl, format).internal, width, height);
  gl.bindRenderbuffer(gl.RENDERBUFFER, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, renderbuffer);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteRenderbuffer(renderbuffer);
    gl.deleteFramebuffer(framebuffer);
    throw new Error('WebGL multisample framebuffer is incomplete.');
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { renderbuffer, framebuffer, width, height, samples, format };
}

export function destroyMultisampleTarget(gl: WebGL2RenderingContext, target: MultisampleTarget): void {
  gl.deleteRenderbuffer(target.renderbuffer);
  gl.deleteFramebuffer(target.framebuffer);
}

/** Resolve `source` into `target` — the WebGL form of a WebGPU `resolveTarget`. */
export function resolveMultisampleTarget(
  gl: WebGL2RenderingContext,
  source: MultisampleTarget,
  target: RenderTarget,
): void {
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, source.framebuffer);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target.framebuffer);
  gl.blitFramebuffer(
    0, 0, source.width, source.height,
    0, 0, target.width, target.height,
    gl.COLOR_BUFFER_BIT,
    gl.NEAREST,
  );
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

/**
 * The format of the executor's pool on this context — the WebGL twin of
 * `selectInternalColorFormat`. `rgba16f` when `EXT_color_buffer_half_float`
 * (or `EXT_color_buffer_float`, which covers it) is granted *and* an
 * `RGBA16F` framebuffer is actually complete; `rgba8` otherwise.
 *
 * Enabling the extension is what makes the format renderable, and a restored
 * context comes back with every extension disabled — so this is asked by each
 * executor that allocates, never remembered per context object.
 */
export function selectWebGLInternalFormat(gl: WebGL2RenderingContext): WebGLInternalFormat {
  const extension = gl.getExtension('EXT_color_buffer_half_float') ?? gl.getExtension('EXT_color_buffer_float');
  if (!extension) return WEBGL_INTERNAL_FORMAT_LDR;
  try {
    destroyTarget(gl, createTarget(gl, 1, 1, WEBGL_INTERNAL_FORMAT_HDR));
    return WEBGL_INTERNAL_FORMAT_HDR;
  } catch {
    // Extension present, RGBA16F still not renderable here: stay 8-bit.
    return WEBGL_INTERNAL_FORMAT_LDR;
  }
}

export function readTargetPixels(
  gl: WebGL2RenderingContext,
  target: RenderTarget,
  width: number,
  height: number,
): Uint8ClampedArray<ArrayBuffer> {
  const data = new Uint8Array(width * height * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
  return flipRgbaRows(data, width, height);
}
