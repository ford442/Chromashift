import { layerFragmentSources } from './shaders';
import { DEFAULT_LAYER_COUNT, publishGraphExecutorBreadcrumbs } from './graph';
import { WebGpuGraphExecutor } from './graph/exec/WebGpuGraphExecutor';
import { PassGraphError } from './graph/errors';
import type { GraphPresetName } from './graph/altGraphs';
import type { CompiledGraph } from './graph/types';
import { WebGPUPipelines, type LayerPipeline } from './WebGPUPipelines';
import { MAIN_VIEW_MODES } from './viewModes';
import {
  createLayerBindGroupCache,
  getOrCreateLayerBindGroup,
  invalidateLayerBindGroupCache,
} from './BindGroupCache';
import { MotionFieldPass } from './MotionFieldPass';
import { MOTION_FIELD_DIVISOR } from './motionModes';
import { PersistencePass } from './PersistencePass';
import { CompositorPass, type CompositorUniformParams } from './CompositorPass';
import { TracerInspectPass } from './TracerInspectPass';
import { GpuReadback } from './GpuReadback';
import { GpuTimestampProfiler, publishGpuTimestampBreadcrumbs } from './GpuTimestampProfiler';
import { StationaryPreviewRenderer } from './StationaryPreviewRenderer';
import type { StationaryPreviewOptions, StationaryPreviewResult } from './stationaryPreview';
import type { ExportFrameOptions, ExportFrameResult, ExportPassMode, ExportTracerOptions, ExportTracerResult, GpuRenderTiming, RenderTiming } from './types/RendererContracts';
import { EMPTY_GPU_RENDER_TIMING } from './types/RendererContracts';
import type { CollisionStats, RendererState } from './types/RendererState';
import type { ChromashiftTextureHandle } from './types/TextureHandle';
import { layerRotationUniforms } from './math/rotation';
import { ProfileLutTexture } from './color/ProfileLutTexture';
import { internalColorFormatBytesPerPixel, selectInternalColorFormat } from './gpuOptions';

/**
 * WebGPURenderer — thin orchestrator over the 5-pass GPU pipeline.
 */

/** Size contract for helpers that only need texture dimensions, not the GPU resource itself. */
type TextureSize = { readonly width: number; readonly height: number };

export class WebGPURenderer {
  readonly backend = 'webgpu' as const;
  static readonly PREVIEW_SIZE = GpuReadback.PREVIEW_SIZE;
  static readonly DIAGNOSTIC_SIZE = GpuReadback.DIAGNOSTIC_SIZE;

  private device         : GPUDevice;
  private context        : GPUCanvasContext;
  private internalFormat : GPUTextureFormat;
  public pipelines: WebGPUPipelines;
  public sampler        : GPUSampler;
  private sampleCount    : number = 4;

  private layerPipelines : LayerPipeline[] = [];
  private currentTexture : GPUTexture | null = null;
  private classificationMaskTexture: GPUTexture | null = null;
  private fallbackMaskTexture: GPUTexture;
  private readonly profileLut: ProfileLutTexture;

  private layerTextures : GPUTexture[] = [];
  private msaaTexture   : GPUTexture | null = null;
  private texW = 0;
  private texH = 0;
  private currentLayerScale = 1.0;
  private currentTracerScale = 1.0;
  private layerScale = 1.0;
  private tracerScale = 1.0;

  private readonly persistence: PersistencePass;
  private readonly motionField: MotionFieldPass;
  /**
   * Set whenever the source texture *object* changes (a new image, a live
   * frame at a new resolution). A live source re-uploads into the same texture
   * every tick, so identity — not the `setTexture` call itself — is what tells
   * a genuinely new source apart from the next frame of the current one.
   */
  private motionResetPending = true;
  private readonly compositor: CompositorPass;
  private readonly tracerInspect: TracerInspectPass;
  private readonly readback: GpuReadback;
  private readonly gpuProfiler: GpuTimestampProfiler | null;
  private readonly compositorSampler: GPUSampler;
  private readonly stationaryPreview: StationaryPreviewRenderer;
  private readonly layerBindGroupCache = createLayerBindGroupCache(DEFAULT_LAYER_COUNT);

  private lastRenderCpuMs = 0;
  private averageRenderCpuMs = 0;

  /**
   * Pass-graph executor (docs/PASS_GRAPH.md Phase 2). Non-null once
   * `setPassGraph()` adopts a compiled graph; `render()` then encodes
   * `compiled.passes` instead of the hand-written five-pass topology.
   */
  private graphExecutor: WebGpuGraphExecutor | null = null;
  private graphName: GraphPresetName | null = null;

  constructor(device: GPUDevice, context: GPUCanvasContext, format: GPUTextureFormat, enableMSAA = false) {
    this.device  = device;
    this.context = context;
    this.internalFormat = selectInternalColorFormat(device);
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

    this.profileLut = new ProfileLutTexture(device);

    for (const src of layerFragmentSources) {
      this.layerPipelines.push(this.pipelines.createLayerPipeline(src, this.sampleCount));
    }

    this.persistence = new PersistencePass(device, this.pipelines, this.internalFormat, this.compositorSampler);
    this.motionField = new MotionFieldPass(device);
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
    const timestamp = GpuTimestampProfiler.create(device);
    this.gpuProfiler = timestamp.profiler;
    publishGpuTimestampBreadcrumbs(this.gpuProfiler !== null, timestamp.reason);
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
        this.layerTextures.length === DEFAULT_LAYER_COUNT) return;

    this.currentLayerScale = this.layerScale;
    this.currentTracerScale = this.tracerScale;

    for (const t of this.layerTextures) t.destroy();
    this.msaaTexture?.destroy();

    const layerW = Math.max(1, Math.round(w * this.layerScale));
    const layerH = Math.max(1, Math.round(h * this.layerScale));
    const tracerW = Math.max(1, Math.round(w * this.tracerScale));
    const tracerH = Math.max(1, Math.round(h * this.tracerScale));

    this.layerTextures = Array.from({ length: DEFAULT_LAYER_COUNT }, () => this.device.createTexture({
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

  /**
   * Adopt a compiled pass graph, or `null` to return to the hand encoder.
   *
   * A graph that compiled but cannot be *encoded* — a `decay` reading the wrong
   * number of stamp inputs, a `blend` with three tracers — is refused here with
   * the node named, and the renderer stays on the hand encoder rather than
   * drawing an approximation of what was asked for.
   */
  setPassGraph(compiled: CompiledGraph | null, name: GraphPresetName | null = null): void {
    if (!compiled) {
      this.graphExecutor?.destroy();
      this.graphExecutor = null;
      this.graphName = null;
      publishGraphExecutorBreadcrumbs(null, []);
      return;
    }

    this.graphExecutor ??= new WebGpuGraphExecutor(
      this.device,
      this.pipelines,
      this.internalFormat,
      this.pipelines.format,
      this.sampler,
      this.compositorSampler,
    );
    try {
      this.graphExecutor.setGraph(compiled);
      this.graphExecutor.setSampleCount(this.sampleCount);
    } catch (error) {
      const message = error instanceof PassGraphError
        ? `${error.code}: ${error.message}`
        : String(error);
      console.warn('[Chromashift:PassGraph] executor refused the graph —', message);
      this.graphExecutor.destroy();
      this.graphExecutor = null;
      this.graphName = null;
      if (typeof window !== 'undefined') window.passGraphError = message;
      publishGraphExecutorBreadcrumbs(null, []);
      return;
    }
    this.graphName = name;
    publishGraphExecutorBreadcrumbs(name, this.graphExecutor.encodedPasses());
  }

  /** Name of the graph shape the executor is drawing, or `null`. */
  get passGraphName(): GraphPresetName | null {
    return this.graphName;
  }

  /**
   * True when the graph executor draws this frame.
   *
   * The temporal (motion) term has no graph node yet, so a session that selects
   * one falls back to the hand encoder rather than quietly dropping it.
   */
  private executorDrawsFrame(state: RendererState, passMode: ExportPassMode): boolean {
    return this.graphExecutor !== null
      && this.graphExecutor.active
      && passMode === 'composite'
      && (state.motionMode ?? 0) === 0;
  }

  setTexture(handle: ChromashiftTextureHandle): void {
    if (handle.backend !== 'webgpu') {
      throw new Error(`Expected a webgpu texture handle, received ${handle.backend}.`);
    }
    if (this.currentTexture !== handle.texture) {
      this.motionResetPending = true;
    }
    this.currentTexture = handle.texture;
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
    for (const src of layerFragmentSources) {
      this.layerPipelines.push(this.pipelines.createLayerPipeline(src, this.sampleCount));
    }

    for (const t of this.layerTextures) t.destroy();
    this.layerTextures = [];
    this.msaaTexture?.destroy();
    this.msaaTexture = null;
    this.persistence.resetTextures();
    this.graphExecutor?.setSampleCount(this.sampleCount);
    this.texW = 0;
    this.texH = 0;
    this.layerScale = 1.0;
    this.tracerScale = 1.0;
    this.invalidateBindGroupCaches();
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

  /**
   * Textures the preview, readback and inspect passes read.
   *
   * When the executor drew the frame, these come out of *its* pool — otherwise
   * the live preview and the collision-stats readback would sample the hand
   * encoder's now-untouched targets and report a black frame.
   */
  private getLayerTexturesTuple(): [GPUTexture, GPUTexture, GPUTexture] {
    const roles = this.graphExecutor?.roleTextures();
    if (roles) return [roles.layers[0], roles.layers[1], roles.layers[2]];
    return [this.layerTextures[0], this.layerTextures[1], this.layerTextures[2]];
  }

  private getTracerTextures(): { below: GPUTexture; above: GPUTexture } {
    const roles = this.graphExecutor?.roleTextures();
    if (roles) return { below: roles.tracerBelow, above: roles.tracerAbove };
    return {
      below: this.persistence.belowTextures[this.persistence.pingPong]!,
      above: this.persistence.aboveTextures[this.persistence.pingPong]!,
    };
  }

  /** Ping-pong index the bind-group caches key on, from whichever path drew. */
  private get activePingPong(): 0 | 1 {
    return this.graphExecutor?.roleTextures()?.pingPong ?? this.persistence.pingPong;
  }

  private encodeLayerPasses(
    enc: GPUCommandEncoder,
    state: RendererState,
    canvasSize: TextureSize,
    layerOpacities: [number, number, number],
  ): void {
    const maskTexture = this.classificationMaskTexture ?? this.fallbackMaskTexture;
    const colorMode = state.colorMode ?? 1.0;
    const useMask = this.classificationMaskTexture && colorMode === 0 ? 1 : 0;
    // Non-classic colour profiles render from the baked LUT (docs/COLOR_PROFILES.md).
    this.profileLut.update(state.colorProfileLut);
    const profileMode = state.colorProfileLut && state.colorProfileMode ? 1 : 0;
    const profileLightDark = state.colorProfileLightDark ?? 1;
    const sobelEnabled = state.sobelEnabled ? 1 : 0;
    const softCropEnabled = state.softCropEnabled ? 1 : 0;
    const aspect = canvasSize.width / canvasSize.height;

    for (let i = 0; i < this.layerPipelines.length; i++) {
      const lp = this.layerPipelines[i];
      const layer = state.layers[i];

      const [rad, flipX, flipY, layerAspect] = layerRotationUniforms(layer, aspect);
      lp.rotationData.set([rad, flipX, flipY, layerAspect]);
      this.device.queue.writeBuffer(lp.rotationBuffer, 0, lp.rotationData.buffer as ArrayBuffer, lp.rotationData.byteOffset, 16);

      lp.fragData.set([
        state.avgLuminance, layerOpacities[i], colorMode, useMask,
        sobelEnabled, softCropEnabled, profileMode, profileLightDark,
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
        this.profileLut.texture,
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
        internalBytesPerPixel: internalColorFormatBytesPerPixel(this.internalFormat),
        motionActive: (state.motionMode ?? 0) !== 0,
        motionDivisor: MOTION_FIELD_DIVISOR,
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
          this.activePingPong,
        );
      },
      this.diagnosticForReadback(state.paused === true),
    );

    this.gpuProfiler?.finishFrame(enc);

    this.device.queue.submit([enc.finish()]);
    this.lastRenderCpuMs = performance.now() - renderStart;
    this.averageRenderCpuMs = this.averageRenderCpuMs === 0
      ? this.lastRenderCpuMs
      : this.averageRenderCpuMs * 0.9 + this.lastRenderCpuMs * 0.1;
    this.gpuProfiler?.afterSubmit();
    // Only when a mode is selected: `off` must not map a stats buffer, or
    // publish a breadcrumb, for a pass that never ran.
    if ((state.motionMode ?? 0) !== 0) this.motionField.afterSubmit();
    this.readback.afterSubmit(readbackFlags);
  }

  /** Stamp-diagnostic texture the collision-stats readback samples. */
  private diagnosticForReadback(paused: boolean): GPUTexture | null {
    const roles = this.graphExecutor?.roleTextures();
    if (roles) return roles.diagnostic;
    return this.persistence.getDiagnosticTextureForReadback(paused);
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

    // Pass-graph executor (docs/PASS_GRAPH.md Phase 2). When a compiled graph
    // is adopted it encodes `compiled.passes` — the default graph byte-for-byte
    // the topology below, or a different shape entirely — and the hand-written
    // encode path is skipped whole rather than partly reused.
    if (this.executorDrawsFrame(state, passMode) && this.currentTexture) {
      // The live-preview readback still runs through `CompositorPass`, so its
      // uniform block has to be written even though the graph drew the frame.
      this.compositor.writeUniforms(this.compositorUniformParams(state));
      this.graphExecutor!.encode(
        enc,
        {
          source: this.currentTexture,
          classificationMask: this.classificationMaskTexture ?? this.fallbackMaskTexture,
          hasClassificationMask: this.classificationMaskTexture !== null,
          profileLut: this.updatedProfileLut(state),
        },
        {
          state,
          outputView,
          width,
          height,
          fps,
          marks: {
            layersEnd: () => { profiler?.markLayersEnd(enc); profiler?.markMotionEnd(enc); },
            stampEnd: () => profiler?.markPersistenceEnd(enc),
            compositorEnd: () => profiler?.markCompositorEnd(enc),
          },
        },
      );
      return;
    }

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
    const canvasSize: TextureSize = { width, height };

    this.encodeLayerPasses(enc, state, canvasSize, layerOpacities);
    profiler?.markLayersEnd(enc);

    // The motion field depends only on the source frame, so it runs before the
    // persistence pass that consumes it. Encoded only when a mode is selected:
    // `motionMode: 'off'` leaves the frame exactly as it was before the
    // temporal term existed, down to the command buffer.
    const motionMode = state.motionMode ?? 0;
    let motionTexture: GPUTexture | null = null;
    if (motionMode !== 0 && this.currentTexture) {
      motionTexture = this.motionField.encode(
        enc,
        this.currentTexture,
        this.currentTexture.width,
        this.currentTexture.height,
        {
          threshold: state.motionThreshold ?? 0.04,
          // A paused session shows a frozen frame; differencing it against
          // itself is zero anyway, but the explicit reset keeps the first frame
          // after unpausing from stamping a whole-screen "change".
          reset: this.motionResetPending || state.paused === true,
        },
      );
      this.motionResetPending = false;
    }
    profiler?.markMotionEnd(enc);

    this.persistence.encode(enc, layerTextures, {
      fps,
      colorThresh: state.tracerThreshold ?? 0.05,
      tracerMode,
      stampBoost,
      peakMode: state.peakCollisionsOnly ? 1 : 0,
      belowDuration: state.tracerBelowDuration ?? 0,
      aboveDuration: state.tracerAboveDuration ?? 1000,
      paused: state.paused ?? false,
      motionMode,
      motionGain: state.motionGain ?? 1,
      motionDecayBias: state.motionDecayBias ?? 0.5,
      motionTexture,
    });
    profiler?.markPersistenceEnd(enc);

    const tracerAboveOp = state.tracerAboveIntensity ?? 0.85;
    const tracerBelowOp = state.tracerBelowIntensity ?? 0.30;
    const layerBlendMode = state.layerBlendMode ?? 0;
    const tracerBlendMode = state.tracerBlendMode ?? 0;

    this.compositor.writeUniforms(this.compositorUniformParams(state));

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

  /** Compositor uniform block for one frame, shared by both encode paths. */
  private compositorUniformParams(state: RendererState): CompositorUniformParams {
    const globalLayerOpacity = state.layerOpacity ?? 1.0;
    const sourceLayerOpacities = state.layerOpacities ?? [1.0, 1.0, 1.0];
    return {
      tracerAboveOp: state.tracerAboveIntensity ?? 0.85,
      tracerBelowOp: state.tracerBelowIntensity ?? 0.30,
      layerBlendMode: state.layerBlendMode ?? 0,
      tracerBlendMode: state.tracerBlendMode ?? 0,
      layerOpacities: [
        globalLayerOpacity * sourceLayerOpacities[0],
        globalLayerOpacity * sourceLayerOpacities[1],
        globalLayerOpacity * sourceLayerOpacities[2],
      ],
      diagnosticsOpacity: state.diagnosticsOpacity ?? 0.55,
      stampBoost: state.stampBoost ?? 1.8,
      outputMode: state.outputMode ?? 0,
      tracerMode: state.tracerMode ?? 0.0,
      diagnosticsMode: state.diagnosticsMode ?? false,
      viewportQuarterZoom: false,
      halfOverlayAlpha: state.halfOverlayAlpha ?? 0.5,
      viewportHalfOverlay: false,
    };
  }

  /** Upload the active colour profile LUT and hand back its texture. */
  private updatedProfileLut(state: RendererState): GPUTexture {
    this.profileLut.update(state.colorProfileLut);
    return this.profileLut.texture;
  }

  private get format(): GPUTextureFormat {
    return this.context.getCurrentTexture().format;
  }

  async exportTracerView(options: ExportTracerOptions): Promise<ExportTracerResult | null> {
    const roles = this.graphExecutor?.roleTextures();
    const above = roles?.tracerAbove ?? this.persistence.aboveTextures[this.persistence.pingPong];
    const below = roles?.tracerBelow ?? this.persistence.belowTextures[this.persistence.pingPong];
    if (!above || !below) return null;
    if (!roles && this.layerTextures.length < DEFAULT_LAYER_COUNT) return null;

    return this.readback.exportTracerView(
      this.tracerInspect,
      {
        persistAbove: above,
        persistBelow: below,
        layerTextures: this.getLayerTexturesTuple(),
        pingPong: this.activePingPong,
      },
      options,
    );
  }

  destroy(): void {
    this.graphExecutor?.destroy();
    this.graphExecutor = null;
    for (const lp of this.layerPipelines) {
      lp.rotationBuffer.destroy();
      lp.fragUniformBuffer.destroy();
    }
    for (const t of this.layerTextures) t.destroy();
    this.msaaTexture?.destroy();
    this.persistence.destroy();
    this.motionField.destroy();
    this.compositor.destroy();
    this.tracerInspect.destroy();
    this.readback.destroy();
    this.stationaryPreview.destroy();
    this.gpuProfiler?.destroy();
    this.fallbackMaskTexture.destroy();
    this.profileLut.destroy();
  }
}
