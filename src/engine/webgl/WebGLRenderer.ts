import { MAIN_VIEW_MODES } from '../viewModes';
import type { CollisionStats, RendererState } from '../types/RendererState';
import type {
  ChromashiftRenderer,
  CpuMotionField,
  ExportFrameOptions,
  ExportFrameResult,
  ExportTracerOptions,
  ExportTracerResult,
  RenderTiming,
} from '../types/RendererContracts';
import { EMPTY_GPU_RENDER_TIMING } from '../types/RendererContracts';
import { durationToDecay } from '../math/decay';
import type { ChromashiftTextureHandle, WebGlTextureHandle } from '../types/TextureHandle';
import { WebGLBlit } from './WebGLBlit';
import { WebGLCompositorPass } from './WebGLCompositorPass';
import { WebGLDebugPasses } from './WebGLDebugPasses';
import { WebGLLayerPass } from './WebGLLayerPass';
import { WebGLPersistencePass } from './WebGLPersistencePass';
import { WebGLReadback } from './WebGLReadback';
import { WebGLStationaryPreviewRenderer } from './WebGLStationaryPreviewRenderer';
import {
  createWebglScaleController,
  stepWebglInternalScale,
  type WebglScaleController,
} from './internalScale';
import { createTarget, destroyTarget, type RenderTarget } from './resources';
import type { StationaryPreviewOptions, StationaryPreviewResult } from '../stationaryPreview';
import type { WebGLRenderViewport } from './types';

export type { WebGLRenderViewport } from './types';

/**
 * Per-layer opacity, global multiplier folded in — one entry per layer the
 * state actually carries, not a fixed three.
 */
function computeLayerOpacities(state: RendererState): number[] {
  const globalLayerOpacity = state.layerOpacity ?? 1.0;
  const perLayer = state.layerOpacities;
  return state.layers.map((_, i) => globalLayerOpacity * (perLayer?.[i] ?? 1));
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
  private readonly blit: WebGLBlit;
  private readonly stationaryPreview: WebGLStationaryPreviewRenderer;
  private readonly scaleController: WebglScaleController = createWebglScaleController();
  private compositeTarget: RenderTarget | null = null;
  private currentTexture: WebGlTextureHandle | null = null;
  private lastCpuMs = 0;
  private avgCpuMs = 0;
  /** Previous on-screen frame's main-thread time, fed into the scale controller. */
  private pendingElapsedMs: number | null = null;

  constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.canvas = canvas;
    this.gl = gl;
    this.debugPasses = new WebGLDebugPasses(gl);
    this.layerPass = new WebGLLayerPass(gl, this.debugPasses);
    this.persistencePass = new WebGLPersistencePass(gl);
    this.compositorPass = new WebGLCompositorPass(gl);
    this.readback = new WebGLReadback(gl);
    this.blit = new WebGLBlit(gl);
    this.stationaryPreview = new WebGLStationaryPreviewRenderer(gl);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
  }

  setTexture(handle: ChromashiftTextureHandle): void {
    if (handle.backend !== 'webgl') {
      throw new Error(`Expected a webgl texture handle, received ${handle.backend}.`);
    }
    this.currentTexture = handle;
    this.stationaryPreview.setSourceTexture(handle);
    this.clearPersistence();
  }

  setClassificationMaskTexture(texture: GPUTexture | null): void {
    void texture;
    // WebGL fallback intentionally derives masks in GLSL from the shared source image.
  }

  setAntialiasing(): void {
    // WebGL2 fallback uses texture filtering and does not recreate MSAA targets.
  }

  clearPersistence(): void {
    this.persistencePass.clear();
  }

  /**
   * Hand the diagnostic backend the latest motion field.
   *
   * There is no compute lane here, so the field arrives from the chore kit's
   * `wasm`/`ts` lanes as a small `Float32Array` (see `useMotionField`) and is
   * uploaded into a quarter-resolution R16F texture. `null` drops it, which
   * returns the persistence pass to the non-motion program.
   */
  setMotionField(motion: CpuMotionField | null): void {
    this.persistencePass.setMotionField(motion);
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
    const canvasW = Math.max(1, this.canvas.width);
    const canvasH = Math.max(1, this.canvas.height);
    const destW = viewport?.width ?? canvasW;
    const destH = viewport?.height ?? canvasH;
    // An explicit viewport (WebXR) is already the draw size. The on-screen
    // canvas applies the internal budget plus the layer/tracer scale sliders.
    const contentScale = viewport
      ? 1
      : stepWebglInternalScale(
          this.scaleController,
          canvasW,
          canvasH,
          this.pendingElapsedMs,
          1000 / Math.max(1, fps),
        );
    if (!viewport) publishWebglInternalScale(contentScale);
    const internalW = Math.max(1, Math.round(destW * contentScale));
    const internalH = Math.max(1, Math.round(destH * contentScale));
    const layerScale = viewport ? 1 : (state.layerScale ?? 1);
    const tracerScale = viewport ? 1 : (state.tracerScale ?? 1);
    const layerOpacities = computeLayerOpacities(state);
    const upsample = !viewport && (internalW !== canvasW || internalH !== canvasH);
    const compositeTarget = upsample ? this.ensureCompositeTarget(internalW, internalH) : null;
    this.renderFrameInternal(state, fps, {
      layerWidth: Math.max(1, Math.round(internalW * layerScale)),
      layerHeight: Math.max(1, Math.round(internalH * layerScale)),
      tracerWidth: Math.max(1, Math.round(internalW * tracerScale)),
      tracerHeight: Math.max(1, Math.round(internalH * tracerScale)),
      compositeWidth: upsample ? internalW : destW,
      compositeHeight: upsample ? internalH : destH,
      compositeTarget,
      viewport: upsample ? undefined : viewport,
    });
    if (upsample && compositeTarget) {
      this.blit.draw(compositeTarget.texture, canvasW, canvasH);
    }
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
    if (!viewport) this.pendingElapsedMs = elapsed;
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
    this.renderFrameInternal(exportState, fps, fullFrame(width, height, target));
    const pixels = await this.readback.readTexturePixelsAsync(target, width, height)
      ?? this.readback.readTexturePixels(target, width, height);
    destroyTarget(this.gl, target);
    return { data: pixels, width, height };
  }

  async exportTracerView(options: ExportTracerOptions): Promise<ExportTracerResult | null> {
    if (!this.currentTexture) return null;
    const target = createTarget(this.gl, options.width, options.height);
    const layerOpacities = this.layerPass.targets.map((_, i) => options.layerOpacities?.[i] ?? 1);
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
      layerOpacities,
    };
    this.compositorPass.render(
      target,
      options.width,
      options.height,
      this.layerPass.targets,
      this.persistencePass,
      state,
      layerOpacities,
    );
    const pixels = await this.readback.readTexturePixelsAsync(target, options.width, options.height)
      ?? this.readback.readTexturePixels(target, options.width, options.height);
    destroyTarget(this.gl, target);
    return { data: pixels, width: options.width, height: options.height };
  }

  destroy(): void {
    if (this.compositeTarget) {
      destroyTarget(this.gl, this.compositeTarget);
      this.compositeTarget = null;
    }
    this.readback.destroy();
    this.blit.destroy();
    this.stationaryPreview.destroy();
    this.layerPass.destroy();
    this.persistencePass.destroy();
    this.compositorPass.destroy();
    this.debugPasses.destroy();
  }

  private ensureCompositeTarget(width: number, height: number): RenderTarget {
    if (this.compositeTarget
      && this.compositeTarget.width === width
      && this.compositeTarget.height === height) {
      return this.compositeTarget;
    }
    if (this.compositeTarget) destroyTarget(this.gl, this.compositeTarget);
    this.compositeTarget = createTarget(this.gl, width, height);
    return this.compositeTarget;
  }

  private renderFrameInternal(
    state: RendererState,
    fps: number,
    frame: WebGLFrameSize,
  ): void {
    if (!this.currentTexture) return;
    this.layerPass.ensureTextures(frame.layerWidth, frame.layerHeight);
    this.persistencePass.ensureTextures(frame.tracerWidth, frame.tracerHeight);

    const debugMode = state.webglDebugMode ?? 0;
    this.layerPass.render(
      this.currentTexture.texture,
      state,
      debugMode,
      frame.layerWidth / frame.layerHeight,
    );

    const readIndex = this.persistencePass.pingPong;
    const writeIndex = (1 - this.persistencePass.pingPong) as 0 | 1;
    const aboveDecay = durationToDecay(state.tracerAboveDuration ?? 500, fps);
    const belowDecay = durationToDecay(state.tracerBelowDuration ?? 2000, fps);
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
      frame.compositeTarget,
      frame.compositeWidth,
      frame.compositeHeight,
      this.layerPass.targets,
      this.persistencePass,
      state,
      computeLayerOpacities(state),
      frame.viewport,
    );
  }
}

interface WebGLFrameSize {
  layerWidth: number;
  layerHeight: number;
  tracerWidth: number;
  tracerHeight: number;
  compositeWidth: number;
  compositeHeight: number;
  compositeTarget: RenderTarget | null;
  viewport?: WebGLRenderViewport;
}

function fullFrame(width: number, height: number, compositeTarget: RenderTarget): WebGLFrameSize {
  return {
    layerWidth: width,
    layerHeight: height,
    tracerWidth: width,
    tracerHeight: height,
    compositeWidth: width,
    compositeHeight: height,
    compositeTarget,
  };
}

function publishWebglInternalScale(scale: number): void {
  const target = window as Window & { webglInternalScale?: number };
  target.webglInternalScale = scale;
}
