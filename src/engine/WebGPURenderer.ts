import {
  fragmentShaderRedOrange,
  fragmentShaderVioletBlue,
  fragmentShaderGreenYellow
} from './shaders';
import { WebGPUPipelines, type LayerPipeline } from './WebGPUPipelines';
import { MAIN_VIEW_MODES } from './viewModes';
import {
  createLayerBindGroupCache,
  getOrCreateLayerBindGroup,
  invalidateLayerBindGroupCache,
} from './BindGroupCache';
import { PersistencePass } from './PersistencePass';
import { CompositorPass } from './CompositorPass';
import { TracerInspectPass } from './TracerInspectPass';
import { GpuReadback } from './GpuReadback';
import { GpuTimestampProfiler, publishGpuTimestampBreadcrumbs } from './GpuTimestampProfiler';
import { StationaryPreviewRenderer } from './StationaryPreviewRenderer';
import type { StationaryPreviewOptions, StationaryPreviewResult } from './stationaryPreview';
import type { ExportFrameOptions, ExportFrameResult, ExportPassMode, ExportTracerOptions, ExportTracerResult, GpuRenderTiming, RenderTiming } from './types/RendererContracts';
import { EMPTY_GPU_RENDER_TIMING } from './types/RendererContracts';
import type { CollisionStats, RendererState } from './types/RendererState';
import { layerRotationUniforms } from './math/rotation';

/**
 * WebGPURenderer — thin orchestrator over the 5-pass GPU pipeline.
 */

export function computeAverageLuminance(image: HTMLImageElement): number {
  const canvas = document.createElement('canvas');
  const MAX_SIZE = 256;
  const scale = Math.min(1, MAX_SIZE / Math.max(image.naturalWidth, image.naturalHeight));
  canvas.width = Math.max(1, Math.floor(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.floor(image.naturalHeight * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return 128;
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imgData.data;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    sum += r * 0.2126 + g * 0.7152 + b * 0.0722;
  }
  return sum / (data.length / 4);
}

export class WebGPURenderer {
  readonly backend = 'webgpu' as const;
  static readonly PREVIEW_SIZE = GpuReadback.PREVIEW_SIZE;
  static readonly DIAGNOSTIC_SIZE = GpuReadback.DIAGNOSTIC_SIZE;

  private device         : GPUDevice;
  private context        : GPUCanvasContext;
  private internalFormat : GPUTextureFormat = 'rgba16float';
  public pipelines: WebGPUPipelines;
  public sampler        : GPUSampler;
  private sampleCount    : number = 4;

  private layerPipelines : LayerPipeline[] = [];
  private currentTexture : GPUTexture | null = null;
  private classificationMaskTexture: GPUTexture | null = null;
  private fallbackMaskTexture: GPUTexture;

  private layerTextures : GPUTexture[] = [];
  private msaaTexture   : GPUTexture | null = null;
  private texW = 0;
  private texH = 0;
  private currentLayerScale = 1.0;
  private currentTracerScale = 1.0;
  private layerScale = 1.0;
  private tracerScale = 1.0;

  private readonly persistence: PersistencePass;
  private readonly compositor: CompositorPass;
  private readonly tracerInspect: TracerInspectPass;
  private readonly readback: GpuReadback;
  private readonly gpuProfiler: GpuTimestampProfiler | null;
  private readonly compositorSampler: GPUSampler;
  private readonly stationaryPreview: StationaryPreviewRenderer;
  private readonly layerBindGroupCache = createLayerBindGroupCache(3);

  private lastRenderCpuMs = 0;
  private averageRenderCpuMs = 0;

  constructor(device: GPUDevice, context: GPUCanvasContext, format: GPUTextureFormat, enableMSAA = false) {
    this.device  = device;
    this.context = context;
    this.sampleCount = enableMSAA ? 4 : 1;
    this.pipelines = new WebGPUPipelines(device, format, this.internalFormat);

    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    this.compositorSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    this.fallbackMaskTexture = device.createTexture({
      size: [1, 1, 1],
      format: 'r8uint',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: this.fallbackMaskTexture },
      new Uint8Array([0]),
      { bytesPerRow: 1, rowsPerImage: 1 },
      [1, 1, 1],
    );

    const fragSources = [fragmentShaderRedOrange, fragmentShaderVioletBlue, fragmentShaderGreenYellow];
    for (const src of fragSources) {
      this.layerPipelines.push(this.pipelines.createLayerPipeline(src, this.sampleCount));
    }

    this.persistence = new PersistencePass(device, this.pipelines, this.internalFormat, this.compositorSampler);
    this.compositor = new CompositorPass(device, this.pipelines, this.compositorSampler);
    this.tracerInspect = new TracerInspectPass(device, this.pipelines, this.compositorSampler);
    this.readback = new GpuReadback(device, format, this.pipelines);
    this.stationaryPreview = new StationaryPreviewRenderer(
      device,
      this.pipelines,
      this.internalFormat,
      format,
      this.compositorSampler,
    );
    this.gpuProfiler = GpuTimestampProfiler.create(device);
    publishGpuTimestampBreadcrumbs(
      this.gpuProfiler !== null,
      this.gpuProfiler ? undefined : 'timestamp-query not granted',
    );
  }

  getRenderTiming(): RenderTiming {
    const gpu: GpuRenderTiming = this.gpuProfiler
      ? this.gpuProfiler.getSnapshot()
      : EMPTY_GPU_RENDER_TIMING;
    return {
      lastCpuMs: this.lastRenderCpuMs,
      averageCpuMs: this.averageRenderCpuMs,
      gpu,
    };
  }

  private invalidateBindGroupCaches(): void {
    invalidateLayerBindGroupCache(this.layerBindGroupCache);
    this.persistence.invalidateCaches();
    this.compositor.invalidateCaches();
    this.tracerInspect.invalidateCaches();
    this.readback.invalidateCaches();
  }

  private ensureTextures(w: number, h: number): void {
    if (this.texW === w && this.texH === h &&
        this.currentLayerScale === this.layerScale &&
        this.currentTracerScale === this.tracerScale &&
        this.layerTextures.length === 3) return;

    this.currentLayerScale = this.layerScale;
    this.currentTracerScale = this.tracerScale;

    for (const t of this.layerTextures) t.destroy();
    this.msaaTexture?.destroy();

    const layerW = Math.max(1, Math.round(w * this.layerScale));
    const layerH = Math.max(1, Math.round(h * this.layerScale));
    const tracerW = Math.max(1, Math.round(w * this.tracerScale));
    const tracerH = Math.max(1, Math.round(h * this.tracerScale));

    this.layerTextures = [0, 1, 2].map(() => this.device.createTexture({
      size: [layerW, layerH, 1],
      format: this.internalFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      sampleCount: 1,
    }));

    if (this.sampleCount > 1) {
      this.msaaTexture = this.device.createTexture({
        size: [layerW, layerH, 1],
        format: this.internalFormat,
        sampleCount: this.sampleCount,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
    } else {
      this.msaaTexture = null;
    }

    this.persistence.ensureTextures(tracerW, tracerH);

    this.texW = w;
    this.texH = h;
    this.invalidateBindGroupCaches();
  }

  setTexture(texture: unknown): void {
    this.currentTexture = texture as GPUTexture;
    this.stationaryPreview.setSourceTexture(this.currentTexture);
    invalidateLayerBindGroupCache(this.layerBindGroupCache);
  }

  setClassificationMaskTexture(texture: GPUTexture | null): void {
    this.classificationMaskTexture = texture;
    this.stationaryPreview.setMaskTexture(texture);
    for (const entry of this.layerBindGroupCache) {
      entry.bindGroup = null;
      entry.maskTexture = null;
    }
  }

  setAntialiasing(enabled: boolean): void {
    const next = enabled ? 4 : 1;
    if (next === this.sampleCount) return;
    this.sampleCount = next;

    this.layerPipelines = [];
    for (const src of [fragmentShaderRedOrange, fragmentShaderVioletBlue, fragmentShaderGreenYellow]) {
      this.layerPipelines.push(this.pipelines.createLayerPipeline(src, this.sampleCount));
    }

    for (const t of this.layerTextures) t.destroy();
    this.layerTextures = [];
    this.msaaTexture?.destroy();
    this.msaaTexture = null;
    this.persistence.resetTextures();
    this.texW = 0;
    this.texH = 0;
    this.layerScale = 1.0;
    this.tracerScale = 1.0;
    this.invalidateBindGroupCaches();
  }

  /** @deprecated Use requestPreviewReadback() for preview thumbnails. */
  getPersistenceTexture(): GPUTexture | null {
    return this.persistence.aboveTextures[this.persistence.pingPong];
  }

  /** @deprecated Side previews use {@link renderStationaryPreviews}. Kept for collision-stats blit path. */
  requestPreviewReadback(callback: (data: Uint8ClampedArray<ArrayBuffer>) => void): boolean {
    return this.readback.requestPreviewReadback(callback);
  }

  async renderStationaryPreviews(
    state: RendererState,
    options?: StationaryPreviewOptions,
  ): Promise<StationaryPreviewResult> {
    return this.stationaryPreview.render(state, options);
  }

  requestCollisionStats(callback: (stats: CollisionStats) => void): boolean {
    return this.readback.requestCollisionStats(callback);
  }

  clearPersistence(): void {
    this.persistence.clear();
  }

  private getLayerTexturesTuple(): [GPUTexture, GPUTexture, GPUTexture] {
    return [this.layerTextures[0], this.layerTextures[1], this.layerTextures[2]];
  }

  private getTracerTextures(): { below: GPUTexture; above: GPUTexture } {
    return {
      below: this.persistence.belowTextures[this.persistence.pingPong]!,
      above: this.persistence.aboveTextures[this.persistence.pingPong]!,
    };
  }

  private encodeLayerPasses(
    enc: GPUCommandEncoder,
    state: RendererState,
    canvasTex: GPUTexture,
    layerOpacities: [number, number, number],
  ): void {
    const maskTexture = this.classificationMaskTexture ?? this.fallbackMaskTexture;
    const colorMode = state.colorMode ?? 1.0;
    const useMask = this.classificationMaskTexture && colorMode === 0 ? 1 : 0;
    const sobelEnabled = state.sobelEnabled ? 1 : 0;
    const softCropEnabled = state.softCropEnabled ? 1 : 0;
    const aspect = canvasTex.width / canvasTex.height;

    for (let i = 0; i < 3; i++) {
      const lp = this.layerPipelines[i];
      const layer = state.layers[i];

      const [rad, flipX, flipY, layerAspect] = layerRotationUniforms(layer, aspect);
      lp.rotationData.set([rad, flipX, flipY, layerAspect]);
      this.device.queue.writeBuffer(lp.rotationBuffer, 0, lp.rotationData.buffer as ArrayBuffer, lp.rotationData.byteOffset, 16);

      lp.fragData.set([
        state.avgLuminance, layerOpacities[i], colorMode, useMask,
        sobelEnabled, softCropEnabled, 0, 0,
      ]);
      this.device.queue.writeBuffer(lp.fragUniformBuffer, 0, lp.fragData.buffer as ArrayBuffer, lp.fragData.byteOffset, 32);

      const bindGroup = getOrCreateLayerBindGroup(
        this.device,
        this.layerBindGroupCache[i],
        lp.bindGroupLayout,
        this.currentTexture!,
        maskTexture,
        this.sampler,
        lp.rotationBuffer,
        lp.fragUniformBuffer,
      );

      const usesMSAA = this.sampleCount > 1 && this.msaaTexture !== null;
      const pass = enc.beginRenderPass({
        colorAttachments: [{
          view: usesMSAA ? this.msaaTexture!.createView() : this.layerTextures[i].createView(),
          resolveTarget: usesMSAA ? this.layerTextures[i].createView() : undefined,
          loadOp: 'clear',
          storeOp: usesMSAA ? 'discard' : 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        }],
      });
      pass.setPipeline(lp.pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(6);
      pass.end();
    }
  }

  render(state: RendererState, fps = 30): void {
    if (!this.currentTexture) return;
    const renderStart = performance.now();

    let canvasTex: GPUTexture;
    try {
      canvasTex = this.context.getCurrentTexture();
    } catch (error) {
      console.warn('[WebGPURenderer] Canvas texture unavailable:', error);
      return;
    }
    this.layerScale = state.layerScale ?? 1.0;
    this.tracerScale = state.tracerScale ?? 1.0;
    this.ensureTextures(canvasTex.width, canvasTex.height);

    const enc = this.device.createCommandEncoder();
    const profiling = state.profilePerformance === true && this.gpuProfiler !== null;
    this.gpuProfiler?.setEnabled(profiling);
    if (profiling && this.gpuProfiler) {
      this.gpuProfiler.setBandwidthInput({
        canvasW: canvasTex.width,
        canvasH: canvasTex.height,
        layerScale: this.layerScale,
        tracerScale: this.tracerScale,
        sampleCount: this.sampleCount,
        readbackActive: state.livePreviewEnabled !== false,
      });
    }

    this.encodeFrameCore(enc, state, canvasTex.createView(), canvasTex.width, canvasTex.height, fps, 'composite', this.gpuProfiler);

    const readbackFlags = this.readback.encodeQueuedReadbacks(
      enc,
      (previewView) => {
        this.compositor.encodePreview(
          enc,
          previewView,
          this.getLayerTexturesTuple(),
          this.getTracerTextures().below,
          this.getTracerTextures().above,
          this.persistence.pingPong,
        );
      },
      state.paused
        ? this.persistence.getDiagnosticTextureForReadback(true)
        : this.persistence.getDiagnosticTextureForReadback(false),
    );

    this.gpuProfiler?.finishFrame(enc);

    this.device.queue.submit([enc.finish()]);
    this.lastRenderCpuMs = performance.now() - renderStart;
    this.averageRenderCpuMs = this.averageRenderCpuMs === 0
      ? this.lastRenderCpuMs
      : this.averageRenderCpuMs * 0.9 + this.lastRenderCpuMs * 0.1;
    this.gpuProfiler?.afterSubmit();
    this.readback.afterSubmit(readbackFlags);
  }

  /** Rebuild GPU targets after export at a different resolution. */
  restoreRenderSize(width: number, height: number): void {
    if (width > 0 && height > 0) {
      this.ensureTextures(width, height);
    }
  }

  async exportFrame(state: RendererState, options: ExportFrameOptions): Promise<ExportFrameResult | null> {
    if (!this.currentTexture) return null;

    const width = Math.max(1, Math.floor(options.width));
    const height = Math.max(1, Math.floor(options.height));
    const fps = options.fps ?? 30;
    const passMode = options.passMode ?? 'composite';

    this.layerScale = state.layerScale ?? 1.0;
    this.tracerScale = state.tracerScale ?? 1.0;
    this.ensureTextures(width, height);

    const output = this.device.createTexture({
      size: [width, height, 1],
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });

    const exportState: RendererState = {
      ...state,
      viewportQuarterZoom: false,
      viewportHalfOverlay: false,
      diagnosticsMode: false,
      ...(passMode === 'layers'
        ? { tracerAboveIntensity: 0, tracerBelowIntensity: 0 }
        : {}),
    };

    const enc = this.device.createCommandEncoder();
    this.encodeFrameCore(enc, exportState, output.createView(), width, height, fps, passMode);
    this.device.queue.submit([enc.finish()]);

    const result = await this.readback.readTexturePixels(output, width, height);
    output.destroy();
    return result;
  }

  private encodeFrameCore(
    enc: GPUCommandEncoder,
    state: RendererState,
    outputView: GPUTextureView,
    width: number,
    height: number,
    fps: number,
    passMode: ExportPassMode,
    profiler: GpuTimestampProfiler | null = null,
  ): void {
    profiler?.beginFrame(enc);

    const globalLayerOpacity = state.layerOpacity ?? 1.0;
    const sourceLayerOpacities = state.layerOpacities ?? [1.0, 1.0, 1.0];
    const layerOpacities: [number, number, number] = [
      globalLayerOpacity * sourceLayerOpacities[0],
      globalLayerOpacity * sourceLayerOpacities[1],
      globalLayerOpacity * sourceLayerOpacities[2],
    ];
    const stampBoost = state.stampBoost ?? 1.8;
    const tracerMode = state.tracerMode ?? 0.0;
    const layerTextures = this.getLayerTexturesTuple();
    const { below: persistBelow, above: persistAbove } = this.getTracerTextures();
    const canvasDims = { width, height } as GPUTexture;

    this.encodeLayerPasses(enc, state, canvasDims, layerOpacities);
    profiler?.markLayersEnd(enc);

    this.persistence.encode(enc, layerTextures, {
      fps,
      colorThresh: state.tracerThreshold ?? 0.05,
      tracerMode,
      stampBoost,
      peakMode: state.peakCollisionsOnly ? 1 : 0,
      belowDuration: state.tracerBelowDuration ?? 0,
      aboveDuration: state.tracerAboveDuration ?? 1000,
      paused: state.paused ?? false,
      useWasm: state.wasmEngine,
    });
    profiler?.markPersistenceEnd(enc);

    const tracerAboveOp = state.tracerAboveIntensity ?? 0.85;
    const tracerBelowOp = state.tracerBelowIntensity ?? 0.30;
    const layerBlendMode = state.layerBlendMode ?? 0;
    const tracerBlendMode = state.tracerBlendMode ?? 0;

    this.compositor.writeUniforms({
      tracerAboveOp,
      tracerBelowOp,
      layerBlendMode,
      tracerBlendMode,
      layerOpacities,
      diagnosticsOpacity: state.diagnosticsOpacity ?? 0.55,
      stampBoost,
      outputMode: state.outputMode ?? 0,
      tracerMode,
      diagnosticsMode: state.diagnosticsMode ?? false,
      viewportQuarterZoom: false,
      halfOverlayAlpha: state.halfOverlayAlpha ?? 0.5,
      viewportHalfOverlay: false,
    });

    if (passMode === 'tracers') {
      this.tracerInspect.encodeTracerView(
        enc,
        outputView,
        {
          canvasWidth: width,
          canvasHeight: height,
          tracerAboveOpacity: tracerAboveOp,
          tracerBelowOpacity: tracerBelowOp,
          tracerBlendMode,
          inspectZoom: state.tracerInspectZoom,
          inspectPanX: state.tracerInspectPanX,
          inspectPanY: state.tracerInspectPanY,
          showHeatmap: state.tracerInspectHeatmap,
          exposure: state.tracerInspectExposure,
          applyTonemap: state.tracerInspectTonemap,
          showLayers: state.tracerInspectShowLayers,
          layerBlendMode,
          layerOpacity0: layerOpacities[0],
          layerOpacity1: layerOpacities[1],
          layerOpacity2: layerOpacities[2],
        },
        {
          layerTextures,
          persistAbove,
          persistBelow,
          pingPong: this.persistence.pingPong,
        },
      );
      profiler?.markCompositorEnd(enc);
      return;
    }

    const mainViewMode = passMode === 'composite'
      ? MAIN_VIEW_MODES.PROCESSED_COMPOSITE
      : (state.mainViewMode ?? MAIN_VIEW_MODES.PROCESSED_COMPOSITE);

    const handledAlternateView = this.tracerInspect.encodeMainView(enc, {
      mainViewMode,
      canvasView: outputView,
      canvasWidth: width,
      canvasHeight: height,
      sourceTexture: this.currentTexture!,
      sourceSampler: this.sampler,
      layerTextures,
      persistBelow,
      persistAbove,
      persistDiagnostic: this.persistence.diagnosticTextures[this.persistence.pingPong],
      pingPong: this.persistence.pingPong,
      colorThresh: state.tracerThreshold ?? 0.05,
      tracerAboveOp,
      tracerBelowOp,
      layerBlendMode,
      tracerBlendMode,
      layerOpacities,
      stampBoost,
      outputMode: state.outputMode ?? 0,
      tracerMode,
      tracerInspect: {
        inspectZoom: state.tracerInspectZoom,
        inspectPanX: state.tracerInspectPanX,
        inspectPanY: state.tracerInspectPanY,
        showHeatmap: state.tracerInspectHeatmap,
        exposure: state.tracerInspectExposure,
        applyTonemap: state.tracerInspectTonemap,
        showLayers: state.tracerInspectShowLayers,
      },
    });

    if (!handledAlternateView) {
      this.compositor.encode(
        enc,
        outputView,
        layerTextures,
        persistBelow,
        persistAbove,
        this.persistence.pingPong,
      );
    }
    profiler?.markCompositorEnd(enc);
  }

  private get format(): GPUTextureFormat {
    return this.context.getCurrentTexture().format;
  }

  async exportTracerView(options: ExportTracerOptions): Promise<ExportTracerResult | null> {
    const above = this.persistence.aboveTextures[this.persistence.pingPong];
    const below = this.persistence.belowTextures[this.persistence.pingPong];
    if (!above || !below || this.layerTextures.length < 3) return null;

    return this.readback.exportTracerView(
      this.tracerInspect,
      {
        persistAbove: above,
        persistBelow: below,
        layerTextures: this.getLayerTexturesTuple(),
        pingPong: this.persistence.pingPong,
      },
      options,
    );
  }

  destroy(): void {
    for (const lp of this.layerPipelines) {
      lp.rotationBuffer.destroy();
      lp.fragUniformBuffer.destroy();
    }
    for (const t of this.layerTextures) t.destroy();
    this.msaaTexture?.destroy();
    this.persistence.destroy();
    this.compositor.destroy();
    this.tracerInspect.destroy();
    this.readback.destroy();
    this.stationaryPreview.destroy();
    this.gpuProfiler?.destroy();
    this.fallbackMaskTexture.destroy();
  }
}
