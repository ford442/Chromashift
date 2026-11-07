import { BLIT_FRAGMENT_SOURCE, PASSTHROUGH_VERTEX_SOURCE } from './shaders';
import { emitPresentBlitGlsl } from './shaders/presentBlit';
import { SRGB_TO_DISPLAY_P3 } from '../color/presentation';
import type { DisplayColorSpace } from '../gpu/gpuOptions';
import {
  activateProgram,
  bindTexture,
  createProgram,
  destroyProgram,
  type ProgramInfo,
} from './programUtils';

/**
 * One-texture upsample from the internal composite onto the canvas — and, for
 * `display-p3`, the presentation conversion: the WebGL compositor writes
 * sRGB-encoded values, so the blit decodes, applies the same
 * `SRGB_TO_DISPLAY_P3` the WebGPU compositor uses, and re-encodes. The `srgb`
 * program is the plain passthrough it always was.
 */
export class WebGLBlit {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: ProgramInfo;
  private p3Program: ProgramInfo | null = null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = createProgram(gl, PASSTHROUGH_VERTEX_SOURCE, BLIT_FRAGMENT_SOURCE);
  }

  draw(texture: WebGLTexture, width: number, height: number, space: DisplayColorSpace = 'srgb'): void {
    const gl = this.gl;
    const program = space === 'display-p3' ? this.displayP3Program() : this.program;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    activateProgram(gl, program);
    bindTexture(gl, program, 'u_source', 0, texture);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  private displayP3Program(): ProgramInfo {
    this.p3Program ??= createProgram(this.gl, PASSTHROUGH_VERTEX_SOURCE, emitPresentBlitGlsl(SRGB_TO_DISPLAY_P3));
    return this.p3Program;
  }

  destroy(): void {
    destroyProgram(this.gl, this.program);
    if (this.p3Program) destroyProgram(this.gl, this.p3Program);
  }
}

