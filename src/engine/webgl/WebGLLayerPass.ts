import { LAYER_FRAGMENT_SOURCE, ROTATION_VERTEX_SOURCE } from './shaders';
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
import { WebGLDebugPasses } from './WebGLDebugPasses';
import type { RendererState } from '../types/RendererState';
import { layerRotationUniforms } from '../math/rotation';

export class WebGLLayerPass {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: ProgramInfo;
  private readonly debugPasses: WebGLDebugPasses;
  private layerTargets: RenderTarget[] = [];
  private width = 0;
  private height = 0;

  constructor(gl: WebGL2RenderingContext, debugPasses: WebGLDebugPasses) {
    this.gl = gl;
    this.debugPasses = debugPasses;
    this.program = createProgram(gl, ROTATION_VERTEX_SOURCE, LAYER_FRAGMENT_SOURCE);
  }

  get targets(): readonly RenderTarget[] {
    return this.layerTargets;
  }

  ensureTextures(width: number, height: number): void {
    if (this.width === width && this.height === height && this.layerTargets.length === 3) return;
    for (const target of this.layerTargets) {
      destroyTarget(this.gl, target);
    }
    this.layerTargets = [0, 1, 2].map(() => createTarget(this.gl, width, height));
    this.width = width;
    this.height = height;
  }

  render(
    sourceTexture: WebGLTexture,
    state: RendererState,
    debugMode: number,
    canvasAspect: number,
  ): void {
    const gl = this.gl;
    for (let layerIndex = 0; layerIndex < 3; layerIndex += 1) {
      const target = this.layerTargets[layerIndex];
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.viewport(0, 0, target.width, target.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      if (debugMode !== 0) {
        this.debugPasses.renderLayer(debugMode, sourceTexture, state, layerIndex, canvasAspect);
        continue;
      }

      const layer = state.layers[layerIndex];
      activateProgram(gl, this.program);
      bindTexture(gl, this.program, 'u_source', 0, sourceTexture);
      uniform1i(gl, this.program, 'u_layerIndex', layerIndex);
      const [rad, flipX, flipY, layerAspect] = layerRotationUniforms(layer, canvasAspect);
      uniform1f(gl, this.program, 'u_angleRad', rad);
      uniform1f(gl, this.program, 'u_flipX', flipX);
      uniform1f(gl, this.program, 'u_flipY', flipY);
      uniform1f(gl, this.program, 'u_aspect', layerAspect);
      uniform1f(gl, this.program, 'u_avgLuminance', state.avgLuminance);
      uniform1f(gl, this.program, 'u_layerOpacity', 1);
      uniform1f(gl, this.program, 'u_colorMode', state.colorMode ?? 1);
      uniform1f(gl, this.program, 'u_sobelEnabled', state.sobelEnabled ? 1 : 0);
      uniform1f(gl, this.program, 'u_softCropEnabled', state.softCropEnabled ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
  }

  destroy(): void {
    for (const target of this.layerTargets) {
      destroyTarget(this.gl, target);
    }
    this.layerTargets = [];
    destroyProgram(this.gl, this.program);
  }
}
