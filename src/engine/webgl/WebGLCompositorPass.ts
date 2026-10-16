import { COMPOSITOR_FRAGMENT_SOURCE, PASSTHROUGH_VERTEX_SOURCE } from './shaders';
import {
  bindTexture,
  createProgram,
  destroyProgram,
  type ProgramInfo,
  uniform1f,
  uniform1i,
  activateProgram,
} from './programUtils';
import type { RenderTarget } from './resources';
import { compositorUniforms, rendererStateValue } from '../graph/exec/uniforms';
import type { RendererState } from '../types/RendererState';
import type { WebGLPersistencePass } from './WebGLPersistencePass';
import type { WebGLRenderViewport } from './types';

export class WebGLCompositorPass {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: ProgramInfo;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = createProgram(gl, PASSTHROUGH_VERTEX_SOURCE, COMPOSITOR_FRAGMENT_SOURCE);
  }

  /**
   * Composite into `target` (the canvas when `null`). Layer opacities and every
   * other value come from `compositorUniforms()` — the same block the WebGPU
   * compositor packs — read here by name; this backend alone also runs the
   * viewport transforms in the shader.
   */
  render(
    target: RenderTarget | null,
    width: number,
    height: number,
    layerTextures: readonly RenderTarget[],
    persistence: WebGLPersistencePass,
    state: RendererState,
    viewport?: WebGLRenderViewport,
  ): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target?.framebuffer ?? null);
    const vx = viewport?.x ?? 0;
    const vy = viewport?.y ?? 0;
    gl.viewport(vx, vy, width, height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    activateProgram(gl, this.program);
    bindTexture(gl, this.program, 'u_layer0', 0, layerTextures[0].texture);
    bindTexture(gl, this.program, 'u_layer1', 1, layerTextures[1].texture);
    bindTexture(gl, this.program, 'u_layer2', 2, layerTextures[2].texture);
    bindTexture(gl, this.program, 'u_tracerBelow', 3, persistence.tracerBelow[persistence.pingPong]!.texture);
    bindTexture(gl, this.program, 'u_tracerAbove', 4, persistence.tracerAbove[persistence.pingPong]!.texture);
    // The compositor still blends the three canonical band targets.
    const values = compositorUniforms(state, layerTextures.length, { viewportTransforms: true });
    for (let i = 0; i < layerTextures.length; i += 1) {
      uniform1f(gl, this.program, `u_layerOpacity${i}`, values[`layerOpacity${i}`]);
    }
    uniform1f(gl, this.program, 'u_tracerBelowOpacity', values.tracerBelowOpacity);
    uniform1f(gl, this.program, 'u_tracerAboveOpacity', values.tracerAboveOpacity);
    uniform1i(gl, this.program, 'u_layerBlendMode', values.layerBlendMode);
    uniform1i(gl, this.program, 'u_tracerBlendMode', values.tracerBlendMode);
    uniform1i(gl, this.program, 'u_outputMode', values.outputMode);
    uniform1i(gl, this.program, 'u_mainViewMode', rendererStateValue(state, 'mainViewMode'));
    uniform1i(gl, this.program, 'u_diagnosticsMode', values.diagnosticsMode);
    uniform1f(gl, this.program, 'u_diagnosticsOpacity', values.diagnosticsOpacity);
    uniform1i(gl, this.program, 'u_viewportQuarterZoom', values.viewportQuarterZoom);
    uniform1i(gl, this.program, 'u_viewportHalfOverlay', values.viewportHalfOverlay);
    uniform1f(gl, this.program, 'u_halfOverlayAlpha', values.halfOverlayAlpha);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  destroy(): void {
    destroyProgram(this.gl, this.program);
  }
}
