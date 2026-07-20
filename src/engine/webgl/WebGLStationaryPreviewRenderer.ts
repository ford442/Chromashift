import { MAIN_VIEW_MODES } from '../viewModes';
import { durationToDecayWith } from '../WasmEngine';
import type { RendererState } from '../types/RendererState';
import type { WebGLImageTexture } from '../WebGLTextureManager';
import {
  STATIONARY_PREVIEW_SIZE,
  STATIONARY_TRACER_WARMUP_FRAMES,
  type StationaryPreviewOptions,
  type StationaryPreviewResult,
} from '../stationaryPreview';
import { WebGLCompositorPass } from './WebGLCompositorPass';
import { WebGLDebugPasses } from './WebGLDebugPasses';
import { WebGLLayerPass } from './WebGLLayerPass';
import { WebGLPersistencePass } from './WebGLPersistencePass';
import { createTarget, destroyTarget, readTargetPixels, type RenderTarget } from './resources';

function computeLayerOpacities(state: RendererState): [number, number, number] {
  const globalLayerOpacity = state.layerOpacity ?? 1.0;
  const perLayer = state.layerOpacities ?? [1, 1, 1];
  return [
    globalLayerOpacity * perLayer[0],
    globalLayerOpacity * perLayer[1],
    globalLayerOpacity * perLayer[2],
  ];
}

/** Isolated WebGL2 path for stationary side previews (does not touch main FBOs). */
export class WebGLStationaryPreviewRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly debugPasses: WebGLDebugPasses;
  private readonly layerPass: WebGLLayerPass;
  private readonly persistencePass: WebGLPersistencePass;
  private readonly compositorPass: WebGLCompositorPass;
  private sourceTexture: WebGLImageTexture | null = null;
  private outputTarget: RenderTarget | null = null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.debugPasses = new WebGLDebugPasses(gl);
    this.layerPass = new WebGLLayerPass(gl, this.debugPasses);
    this.persistencePass = new WebGLPersistencePass(gl);
    this.compositorPass = new WebGLCompositorPass(gl);
  }

  setSourceTexture(texture: WebGLImageTexture | null): void {
    this.sourceTexture = texture;
  }

  destroy(): void {
    if (this.outputTarget) {
      destroyTarget(this.gl, this.outputTarget);
      this.outputTarget = null;
    }
    this.layerPass.destroy();
    this.persistencePass.destroy();
    this.compositorPass.destroy();
    this.debugPasses.destroy();
  }

  render(
    state: RendererState,
    options: StationaryPreviewOptions = {},
  ): StationaryPreviewResult {
    if (!this.sourceTexture) return { separated: null, tracer: null };

    const size = STATIONARY_PREVIEW_SIZE;
    const fps = options.fps ?? 30;
    const warmupFrames = options.tracerWarmupFrames ?? STATIONARY_TRACER_WARMUP_FRAMES;
    const wantSeparated = options.separated !== false;
    const wantTracer = options.tracer !== false;
    this.ensureOutputTarget(size);
    this.layerPass.ensureTextures(size, size);
    this.persistencePass.ensureTextures(size, size);
    this.persistencePass.clear();

    const layerOpacities = computeLayerOpacities(state);
    const separated = wantSeparated
      ? this.renderSeparated(state, size, layerOpacities)
      : null;

    let tracer: Uint8ClampedArray<ArrayBuffer> | null = null;
    if (wantTracer) {
      this.persistencePass.clear();
      for (let frame = 0; frame < warmupFrames; frame += 1) {
        this.encodeLayersAndPersistence(state, fps);
      }
      tracer = this.renderTracer(state, size, layerOpacities);
    }

    return { separated, tracer };
  }

  private ensureOutputTarget(size: number): void {
    if (this.outputTarget && this.outputTarget.width === size) return;
    if (this.outputTarget) destroyTarget(this.gl, this.outputTarget);
    this.outputTarget = createTarget(this.gl, size, size);
  }

  private encodeLayersAndPersistence(state: RendererState, fps: number): void {
    this.layerPass.render(this.sourceTexture!.texture, state, 0, 1);
    const readIndex = this.persistencePass.pingPong;
    const writeIndex = (1 - this.persistencePass.pingPong) as 0 | 1;
    const useWasm = state.wasmEngine ?? false;
    const aboveDecay = durationToDecayWith(state.tracerAboveDuration ?? 500, fps, useWasm);
    const belowDecay = durationToDecayWith(state.tracerBelowDuration ?? 2000, fps, useWasm);
    this.persistencePass.render(
      this.persistencePass.tracerAbove[writeIndex]!,
      this.persistencePass.tracerAbove[readIndex]!,
      this.layerPass.targets,
      aboveDecay,
      state,
    );
    this.persistencePass.render(
      this.persistencePass.tracerBelow[writeIndex]!,
      this.persistencePass.tracerBelow[readIndex]!,
      this.layerPass.targets,
      belowDecay,
      state,
    );
    this.persistencePass.advancePingPong(false);
  }

  private renderSeparated(
    state: RendererState,
    size: number,
    layerOpacities: [number, number, number],
  ): Uint8ClampedArray<ArrayBuffer> | null {
    this.layerPass.render(this.sourceTexture!.texture, state, 0, 1);
    const separatedState: RendererState = {
      ...state,
      tracerAboveIntensity: 0,
      tracerBelowIntensity: 0,
      mainViewMode: MAIN_VIEW_MODES.PROCESSED_COMPOSITE,
      viewportQuarterZoom: false,
      viewportHalfOverlay: false,
      diagnosticsMode: false,
    };
    this.compositorPass.render(
      this.outputTarget,
      size,
      size,
      this.layerPass.targets,
      this.persistencePass,
      separatedState,
      layerOpacities,
    );
    return readTargetPixels(this.gl, this.outputTarget!, size, size);
  }

  private renderTracer(
    state: RendererState,
    size: number,
    layerOpacities: [number, number, number],
  ): Uint8ClampedArray<ArrayBuffer> | null {
    const tracerState: RendererState = {
      ...state,
      mainViewMode: MAIN_VIEW_MODES.FULL_RES_TRACER,
      viewportQuarterZoom: false,
      viewportHalfOverlay: false,
      diagnosticsMode: false,
      tracerInspectShowLayers: false,
      tracerInspectHeatmap: false,
    };
    this.compositorPass.render(
      this.outputTarget,
      size,
      size,
      this.layerPass.targets,
      this.persistencePass,
      tracerState,
      layerOpacities,
    );
    return readTargetPixels(this.gl, this.outputTarget!, size, size);
  }
}
