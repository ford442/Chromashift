import { MAIN_VIEW_MODES } from '../viewModes';
import type { CollisionStats, RendererState } from '../types/RendererState';
import type {
  ChromashiftRenderer,
  ExportFrameOptions,
  ExportFrameResult,
  ExportTracerOptions,
  ExportTracerResult,
  RenderTiming,
} from '../types/RendererContracts';
import { EMPTY_GPU_RENDER_TIMING } from '../types/RendererContracts';
import { durationToDecayWith } from '../WasmEngine';
import type { WebGLImageTexture } from '../WebGLTextureManager';
import { WebGLCompositorPass } from './WebGLCompositorPass';
import { WebGLDebugPasses } from './WebGLDebugPasses';
import { WebGLLayerPass } from './WebGLLayerPass';
import { WebGLPersistencePass } from './WebGLPersistencePass';
import { WebGLReadback } from './WebGLReadback';
import { WebGLStationaryPreviewRenderer } from './WebGLStationaryPreviewRenderer';
import { createTarget, destroyTarget, type RenderTarget } from './resources';
import type { StationaryPreviewOptions, StationaryPreviewResult } from '../stationaryPreview';
import type { WebGLRenderViewport } from './types';

export type { WebGLRenderViewport } from './types';

function isWebGLImageTexture(texture: unknown): texture is WebGLImageTexture {
  return typeof texture === 'object' && texture !== null && (texture as WebGLImageTexture).kind === 'webgl-image-texture';
}

function computeLayerOpacities(state: RendererState): [number, number, number] {
  const globalLayerOpacity = state.layerOpacity ?? 1.0;
  const perLayer = state.layerOpacities ?? [1, 1, 1];
  return [
    globalLayerOpacity * perLayer[0],
    globalLayerOpacity * perLayer[1],
    globalLayerOpacity * perLayer[2],
  ];
}

/**
 * WebGLRenderer — thin orchestrator over the WebGL2 fallback pipeline.
 */
export class WebGLRenderer implements ChromashiftRenderer {
  readonly backend = 'webgl' as const;

  private readonly gl: WebGL2RenderingContext;
  private readonly canvas: HTMLCanvasElement;
  private readonly debugPasses: WebGLDebugPasses;
  private readonly layerPass: WebGLLayerPass;
  private readonly persistencePass: WebGLPersistencePass;
  private readonly compositorPass: WebGLCompositorPass;
  private readonly readback: WebGLReadback;
  private readonly stationaryPreview: WebGLStationaryPreviewRenderer;
  private currentTexture: WebGLImageTexture | null = null;
  private lastCpuMs = 0;
  private avgCpuMs = 0;

  constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.canvas = canvas;
    this.gl = gl;
    this.debugPasses = new WebGLDebugPasses(gl);
    this.layerPass = new WebGLLayerPass(gl, this.debugPasses);
    this.persistencePass = new WebGLPersistencePass(gl);
    this.compositorPass = new WebGLCompositorPass(gl);
    this.readback = new WebGLReadback(gl);
    this.stationaryPreview = new WebGLStationaryPreviewRenderer(gl);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
  }

  setTexture(texture: unknown): void {
    if (!isWebGLImageTexture(texture)) {
      throw new Error('WebGLRenderer expected a WebGLImageTexture.');
    }
    this.currentTexture = texture;
    this.stationaryPreview.setSourceTexture(texture);
    this.clearPersistence();
  }

  setClassificationMaskTexture(): void {
    // WebGL fallback intentionally derives masks in GLSL from the shared source image.
  }

  setAntialiasing(): void {
    // WebGL2 fallback uses texture filtering and does not recreate MSAA targets.
  }

  clearPersistence(): void {
    this.persistencePass.clear();
  }

  async renderStationaryPreviews(
    state: RendererState,
    options?: StationaryPreviewOptions,
  ): Promise<StationaryPreviewResult> {
    return this.stationaryPreview.render(state, options);
  }

  /** @deprecated Side previews use {@link renderStationaryPreviews}. */
  requestPreviewReadback(callback: (data: Uint8ClampedArray<ArrayBuffer>) => void): boolean {
    return this.readback.requestPreviewReadback(callback);
  }

  requestCollisionStats(callback: (stats: CollisionStats) => void): boolean {
    return this.readback.requestCollisionStats(callback);
  }

  getRenderTiming(): RenderTiming {
    return {
      lastCpuMs: this.lastCpuMs,
      averageCpuMs: this.avgCpuMs,
      gpu: EMPTY_GPU_RENDER_TIMING,
    };
  }

  render(state: RendererState, fps = 30, viewport?: WebGLRenderViewport): void {
    if (!this.currentTexture) return;
    const start = performance.now();
    const width = viewport?.width ?? Math.max(1, this.canvas.width);
    const height = viewport?.height ?? Math.max(1, this.canvas.height);
    const layerOpacities = computeLayerOpacities(state);
    this.renderFrameInternal(state, width, height, fps, null, viewport);
    this.readback.afterFrame(
      this.compositorPass,
      this.layerPass.targets,
      this.persistencePass,
      state,
      layerOpacities,
    );
    const elapsed = performance.now() - start;
    this.lastCpuMs = elapsed;
    this.avgCpuMs = this.avgCpuMs === 0 ? elapsed : this.avgCpuMs * 0.9 + elapsed * 0.1;
  }

  restoreRenderSize(width: number, height: number): void {
    if (width > 0 && height > 0) {
      this.layerPass.ensureTextures(width, height);
      this.persistencePass.ensureTextures(width, height);
    }
  }

  async exportFrame(state: RendererState, options: ExportFrameOptions): Promise<ExportFrameResult | null> {
    if (!this.currentTexture) return null;

    const width = Math.max(1, Math.floor(options.width));
    const height = Math.max(1, Math.floor(options.height));
    const fps = options.fps ?? 30;
    const passMode = options.passMode ?? 'composite';

    this.layerPass.ensureTextures(width, height);
    this.persistencePass.ensureTextures(width, height);

    const exportState: RendererState = {
      ...state,
      viewportQuarterZoom: false,
      viewportHalfOverlay: false,
      diagnosticsMode: false,
      mainViewMode: passMode === 'tracers'
        ? MAIN_VIEW_MODES.FULL_RES_TRACER
        : MAIN_VIEW_MODES.PROCESSED_COMPOSITE,
      ...(passMode === 'layers'
        ? { tracerAboveIntensity: 0, tracerBelowIntensity: 0 }
        : {}),
    };

    const target = createTarget(this.gl, width, height);
    this.renderFrameInternal(exportState, width, height, fps, target);
    const pixels = this.readback.readTexturePixels(target, width, height);
    destroyTarget(this.gl, target);
    return { data: pixels, width, height };
  }

  async exportTracerView(options: ExportTracerOptions): Promise<ExportTracerResult | null> {
    if (!this.currentTexture) return null;
    const target = createTarget(this.gl, options.width, options.height);
    const state: RendererState = {
      layers: [
        { angleDeg: 0 },
        { angleDeg: 0, flipY: true },
        { angleDeg: 0 },
      ],
      avgLuminance: 128,
      mainViewMode: MAIN_VIEW_MODES.FULL_RES_TRACER,
      tracerAboveIntensity: options.tracerAboveOpacity,
      tracerBelowIntensity: options.tracerBelowOpacity,
      tracerBlendMode: options.tracerBlendMode,
      layerBlendMode: options.layerBlendMode,
      layerOpacities: [
        options.layerOpacity0 ?? 1,
        options.layerOpacity1 ?? 1,
        options.layerOpacity2 ?? 1,
      ],
    };
    this.compositorPass.render(
      target,
      options.width,
      options.height,
      this.layerPass.targets,
      this.persistencePass,
      state,
      state.layerOpacities ?? [1, 1, 1],
    );
    const pixels = this.readback.readTexturePixels(target, options.width, options.height);
    destroyTarget(this.gl, target);
    return { data: pixels, width: options.width, height: options.height };
  }

  destroy(): void {
    this.readback.destroy();
    this.stationaryPreview.destroy();
    this.layerPass.destroy();
    this.persistencePass.destroy();
    this.compositorPass.destroy();
    this.debugPasses.destroy();
  }

  private renderFrameInternal(
    state: RendererState,
    width: number,
    height: number,
    fps: number,
    compositeTarget: RenderTarget | null,
    viewport?: WebGLRenderViewport,
  ): void {
    if (!this.currentTexture) return;
    this.layerPass.ensureTextures(width, height);
    this.persistencePass.ensureTextures(width, height);

    const debugMode = state.webglDebugMode ?? 0;
    this.layerPass.render(
      this.currentTexture.texture,
      state,
      debugMode,
      width / height,
    );

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
    this.persistencePass.advancePingPong(state.paused);

    this.compositorPass.render(
      compositeTarget,
      width,
      height,
      this.layerPass.targets,
      this.persistencePass,
      state,
      computeLayerOpacities(state),
      viewport,
    );
  }
}
