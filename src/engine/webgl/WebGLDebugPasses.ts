import {
  LAYER_ISOLATION_DEBUG_FRAGMENT,
  LUMINANCE_DEBUG_FRAGMENT,
  ROTATION_VERTEX_SOURCE,
  UV_GRID_DEBUG_FRAGMENT,
} from './shaders';
import {
  bindTexture,
  createProgram,
  destroyProgram,
  type ProgramInfo,
  uniform1f,
  uniform1i,
  activateProgram,
} from './programUtils';
import type { RendererState } from '../types/RendererState';
import { layerRotationUniforms } from '../math/rotation';

export class WebGLDebugPasses {
  private readonly gl: WebGL2RenderingContext;
  private readonly luminanceProgram: ProgramInfo;
  private readonly uvGridProgram: ProgramInfo;
  private readonly isolationProgram: ProgramInfo;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.luminanceProgram = createProgram(gl, ROTATION_VERTEX_SOURCE, LUMINANCE_DEBUG_FRAGMENT);
    this.uvGridProgram = createProgram(gl, ROTATION_VERTEX_SOURCE, UV_GRID_DEBUG_FRAGMENT);
    this.isolationProgram = createProgram(gl, ROTATION_VERTEX_SOURCE, LAYER_ISOLATION_DEBUG_FRAGMENT);
  }

  renderLayer(
    debugMode: number,
    sourceTexture: WebGLTexture,
    state: RendererState,
    layerIndex: number,
    canvasAspect: number,
  ): void {
    const gl = this.gl;
    const program = this.programForMode(debugMode);
    const layer = state.layers[layerIndex];
    activateProgram(gl, program);
    bindTexture(gl, program, 'u_source', 0, sourceTexture);
    uniform1i(gl, program, 'u_layerIndex', layerIndex);
    const [rad, flipX, flipY, layerAspect] = layerRotationUniforms(layer, canvasAspect);
    uniform1f(gl, program, 'u_angleRad', rad);
    uniform1f(gl, program, 'u_flipX', flipX);
    uniform1f(gl, program, 'u_flipY', flipY);
    uniform1f(gl, program, 'u_aspect', layerAspect);
    if (debugMode === 1 || debugMode === 3) {
      uniform1f(gl, program, 'u_avgLuminance', state.avgLuminance);
      uniform1f(gl, program, 'u_colorMode', state.colorMode ?? 1);
      uniform1f(gl, program, 'u_sobelEnabled', state.sobelEnabled ? 1 : 0);
      uniform1f(gl, program, 'u_softCropEnabled', state.softCropEnabled ? 1 : 0);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  destroy(): void {
    const gl = this.gl;
    destroyProgram(gl, this.luminanceProgram);
    destroyProgram(gl, this.uvGridProgram);
    destroyProgram(gl, this.isolationProgram);
  }

  private programForMode(debugMode: number): ProgramInfo {
    if (debugMode === 1) return this.luminanceProgram;
    if (debugMode === 2) return this.uvGridProgram;
    return this.isolationProgram;
  }
}
