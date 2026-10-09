import { BLIT_FRAGMENT_SOURCE, PASSTHROUGH_VERTEX_SOURCE } from './shaders';
import {
  activateProgram,
  bindTexture,
  createProgram,
  destroyProgram,
  type ProgramInfo,
} from './programUtils';

/** One-texture upsample from the internal composite onto the canvas. */
export class WebGLBlit {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: ProgramInfo;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = createProgram(gl, PASSTHROUGH_VERTEX_SOURCE, BLIT_FRAGMENT_SOURCE);
  }

  draw(texture: WebGLTexture, width: number, height: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    activateProgram(gl, this.program);
    bindTexture(gl, this.program, 'u_source', 0, texture);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  destroy(): void {
    destroyProgram(this.gl, this.program);
  }
}
