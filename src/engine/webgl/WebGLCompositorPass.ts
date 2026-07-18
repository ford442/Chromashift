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
import { MAIN_VIEW_MODES } from '../viewModes';
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

  render(
    target: RenderTarget | null,
    width: number,
    height: number,
    layerTextures: readonly RenderTarget[],
    persistence: WebGLPersistencePass,
    state: RendererState,
    layerOpacities: [number, number, number],
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
    uniform1f(gl, this.program, 'u_layerOpacity0', layerOpacities[0]);
    uniform1f(gl, this.program, 'u_layerOpacity1', layerOpacities[1]);
    uniform1f(gl, this.program, 'u_layerOpacity2', layerOpacities[2]);
    uniform1f(gl, this.program, 'u_tracerBelowOpacity', state.tracerBelowIntensity ?? 0.3);
    uniform1f(gl, this.program, 'u_tracerAboveOpacity', state.tracerAboveIntensity ?? 0.85);
    uniform1i(gl, this.program, 'u_layerBlendMode', state.layerBlendMode ?? 0);
    uniform1i(gl, this.program, 'u_tracerBlendMode', state.tracerBlendMode ?? 0);
    uniform1i(gl, this.program, 'u_outputMode', state.outputMode ?? 0);
    uniform1i(gl, this.program, 'u_mainViewMode', state.mainViewMode ?? MAIN_VIEW_MODES.PROCESSED_COMPOSITE);
    uniform1i(gl, this.program, 'u_diagnosticsMode', state.diagnosticsMode ? 1 : 0);
    uniform1f(gl, this.program, 'u_diagnosticsOpacity', state.diagnosticsOpacity ?? 0.55);
    const zoomEnabled = (state.viewportQuarterZoom ?? false)
      && (state.mainViewMode ?? MAIN_VIEW_MODES.PROCESSED_COMPOSITE) === MAIN_VIEW_MODES.PROCESSED_COMPOSITE;
    const overlayEnabled = (state.viewportHalfOverlay ?? false)
      && (state.mainViewMode ?? MAIN_VIEW_MODES.PROCESSED_COMPOSITE) === MAIN_VIEW_MODES.PROCESSED_COMPOSITE;
    uniform1i(gl, this.program, 'u_viewportQuarterZoom', zoomEnabled ? 1 : 0);
    uniform1i(gl, this.program, 'u_viewportHalfOverlay', overlayEnabled ? 1 : 0);
    uniform1f(gl, this.program, 'u_halfOverlayAlpha', state.halfOverlayAlpha ?? 0.5);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  destroy(): void {
    destroyProgram(this.gl, this.program);
  }
}
