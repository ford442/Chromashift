import { PASSTHROUGH_VERTEX_SOURCE, PERSISTENCE_FRAGMENT_SOURCE } from './shaders';
import {
  bindTexture,
  createProgram,
  destroyProgram,
  type ProgramInfo,
  uniform1f,
  uniform1i,
  activateProgram,
} from './programUtils';
import { createTarget, destroyTarget, type RenderTarget } from './resources';
import type { RendererState } from '../types/RendererState';

export class WebGLPersistencePass {
  readonly tracerAbove: [RenderTarget | null, RenderTarget | null] = [null, null];
  readonly tracerBelow: [RenderTarget | null, RenderTarget | null] = [null, null];
  pingPong: 0 | 1 = 0;

  private readonly gl: WebGL2RenderingContext;
  private readonly program: ProgramInfo;
  private width = 0;
  private height = 0;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = createProgram(gl, PASSTHROUGH_VERTEX_SOURCE, PERSISTENCE_FRAGMENT_SOURCE);
  }

  ensureTextures(width: number, height: number): void {
    if (this.width === width && this.height === height && this.tracerAbove[0] !== null) return;
    this.destroyTextures();
    this.tracerAbove[0] = createTarget(this.gl, width, height);
    this.tracerAbove[1] = createTarget(this.gl, width, height);
    this.tracerBelow[0] = createTarget(this.gl, width, height);
    this.tracerBelow[1] = createTarget(this.gl, width, height);
    this.width = width;
    this.height = height;
    this.clear();
  }

  clear(): void {
    const gl = this.gl;
    for (const target of [...this.tracerAbove, ...this.tracerBelow]) {
      if (!target) continue;
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.viewport(0, 0, target.width, target.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.pingPong = 0;
  }

  render(
    write: RenderTarget,
    read: RenderTarget,
    layerTextures: readonly RenderTarget[],
    decay: number,
    state: RendererState,
  ): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, write.framebuffer);
    gl.viewport(0, 0, write.width, write.height);
    activateProgram(gl, this.program);
    bindTexture(gl, this.program, 'u_layer0', 0, layerTextures[0].texture);
    bindTexture(gl, this.program, 'u_layer1', 1, layerTextures[1].texture);
    bindTexture(gl, this.program, 'u_layer2', 2, layerTextures[2].texture);
    bindTexture(gl, this.program, 'u_previous', 3, read.texture);
    uniform1f(gl, this.program, 'u_decay', state.paused ? 1 : decay);
    uniform1f(gl, this.program, 'u_stampBoost', state.stampBoost ?? 1.8);
    uniform1i(gl, this.program, 'u_tracerMode', state.tracerMode ?? 0);
    uniform1i(gl, this.program, 'u_peakMode', state.peakCollisionsOnly ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  advancePingPong(paused: boolean | undefined): void {
    if (!paused) this.pingPong = (1 - this.pingPong) as 0 | 1;
  }

  destroy(): void {
    this.destroyTextures();
    destroyProgram(this.gl, this.program);
  }

  private destroyTextures(): void {
    for (const slot of [0, 1] as const) {
      if (this.tracerAbove[slot]) {
        destroyTarget(this.gl, this.tracerAbove[slot]!);
        this.tracerAbove[slot] = null;
      }
      if (this.tracerBelow[slot]) {
        destroyTarget(this.gl, this.tracerBelow[slot]!);
        this.tracerBelow[slot] = null;
      }
    }
    this.width = 0;
    this.height = 0;
  }
}
