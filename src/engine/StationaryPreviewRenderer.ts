import {
  fragmentShaderGreenYellow,
  fragmentShaderRedOrange,
  fragmentShaderVioletBlue,
} from './shaders';
import {
  createLayerBindGroupCache,
  getOrCreateLayerBindGroup,
  invalidateLayerBindGroupCache,
} from './BindGroupCache';
import { CompositorPass } from './CompositorPass';
import { GpuReadback } from './GpuReadback';
import { PersistencePass } from './PersistencePass';
import {
  STATIONARY_PREVIEW_SIZE,
  STATIONARY_TRACER_WARMUP_FRAMES,
  type StationaryPreviewOptions,
  type StationaryPreviewResult,
} from './stationaryPreview';
import { TracerInspectPass } from './TracerInspectPass';
import type { RendererState } from './types/RendererState';
import { layerRotationUniforms } from './math/rotation';
import type { WebGPUPipelines } from './WebGPUPipelines';

/**
 * Isolated 128×128 GPU path for side-preview thumbnails at preset angles.
 * Does not read or write the main canvas layer/tracer textures.
 */
export class StationaryPreviewRenderer {
  private readonly device: GPUDevice;
  private readonly internalFormat: GPUTextureFormat;
  private readonly outputFormat: GPUTextureFormat;
  private readonly sampler: GPUSampler;
  private readonly persistence: PersistencePass;
  private readonly compositor: CompositorPass;
  private readonly tracerInspect: TracerInspectPass;
  private readonly readback: GpuReadback;
  private readonly layerBindGroupCache = createLayerBindGroupCache(3);
  private readonly layerPipelines: ReturnType<WebGPUPipelines['createLayerPipeline']>[] = [];
  private layerTextures: GPUTexture[] = [];
  private outputTexture: GPUTexture | null = null;
  private sourceTexture: GPUTexture | null = null;
  private maskTexture: GPUTexture | null = null;
  private readonly fallbackMaskTexture: GPUTexture;

  constructor(
    device: GPUDevice,
    pipelines: WebGPUPipelines,
    internalFormat: GPUTextureFormat,
    outputFormat: GPUTextureFormat,
    sampler: GPUSampler,
  ) {
    this.device = device;
    this.internalFormat = internalFormat;
    this.outputFormat = outputFormat;
    this.sampler = sampler;

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

    for (const src of [fragmentShaderRedOrange, fragmentShaderVioletBlue, fragmentShaderGreenYellow]) {
      this.layerPipelines.push(pipelines.createLayerPipeline(src, 1));
    }

    this.persistence = new PersistencePass(device, pipelines, internalFormat, sampler);
    this.compositor = new CompositorPass(device, pipelines, sampler);
    this.tracerInspect = new TracerInspectPass(device, pipelines, sampler);
    this.readback = new GpuReadback(device, outputFormat, pipelines);
  }

  setSourceTexture(texture: GPUTexture | null): void {
    this.sourceTexture = texture;
    invalidateLayerBindGroupCache(this.layerBindGroupCache);
  }

  setMaskTexture(texture: GPUTexture | null): void {
    this.maskTexture = texture;
    for (const entry of this.layerBindGroupCache) {
      entry.bindGroup = null;
      entry.maskTexture = null;
    }
  }

  destroy(): void {
    for (const t of this.layerTextures) t.destroy();
    this.outputTexture?.destroy();
    this.fallbackMaskTexture.destroy();
    this.persistence.destroy();
    this.compositor.destroy();
    this.tracerInspect.destroy();
    this.readback.destroy();
  }

  async render(
    state: RendererState,
    options: StationaryPreviewOptions = {},
  ): Promise<StationaryPreviewResult> {
    if (!this.sourceTexture) return { separated: null, tracer: null };

    const size = STATIONARY_PREVIEW_SIZE;
    const fps = options.fps ?? 30;
    const warmupFrames = options.tracerWarmupFrames ?? STATIONARY_TRACER_WARMUP_FRAMES;
    const wantSeparated = options.separated !== false;
    const wantTracer = options.tracer !== false;
    this.ensureResources(size);
    this.persistence.clear();

    const globalLayerOpacity = state.layerOpacity ?? 1.0;
    const sourceLayerOpacities = state.layerOpacities ?? [1.0, 1.0, 1.0];
    const layerOpacities: [number, number, number] = [
      globalLayerOpacity * sourceLayerOpacities[0],
      globalLayerOpacity * sourceLayerOpacities[1],
      globalLayerOpacity * sourceLayerOpacities[2],
    ];

    const separated = wantSeparated
      ? await this.renderSeparatedPass(state, layerOpacities, size)
      : null;

    let tracer: Uint8ClampedArray<ArrayBuffer> | null = null;
    if (wantTracer) {
      this.persistence.clear();
      for (let frame = 0; frame < warmupFrames; frame += 1) {
        const enc = this.device.createCommandEncoder();
        this.encodeLayerPasses(enc, state, layerOpacities);
        this.encodePersistence(enc, state, fps);
        this.device.queue.submit([enc.finish()]);
      }
      tracer = await this.renderTracerPass(state, layerOpacities, size);
    }

    return { separated, tracer };
  }

  private ensureResources(size: number): void {
    if (this.layerTextures.length === 3
      && this.layerTextures[0].width === size
      && this.outputTexture?.width === size) {
      return;
    }

    for (const t of this.layerTextures) t.destroy();
    this.outputTexture?.destroy();

    this.layerTextures = [0, 1, 2].map(() => this.device.createTexture({
      size: [size, size, 1],
      format: this.internalFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    }));
    this.outputTexture = this.device.createTexture({
      size: [size, size, 1],
      format: this.outputFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    this.persistence.ensureTextures(size, size);
    invalidateLayerBindGroupCache(this.layerBindGroupCache);
    this.persistence.invalidateCaches();
    this.compositor.invalidateCaches();
    this.tracerInspect.invalidateCaches();
  }

  private encodeLayerPasses(
    enc: GPUCommandEncoder,
    state: RendererState,
    layerOpacities: [number, number, number],
  ): void {
    const maskTexture = this.maskTexture ?? this.fallbackMaskTexture;
    const colorMode = state.colorMode ?? 1.0;
    const useMask = this.maskTexture && colorMode === 0 ? 1 : 0;
    const sobelEnabled = state.sobelEnabled ? 1 : 0;
    const softCropEnabled = state.softCropEnabled ? 1 : 0;
    const aspect = 1;

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
        this.sourceTexture!,
        maskTexture,
        this.sampler,
        lp.rotationBuffer,
        lp.fragUniformBuffer,
      );

      const pass = enc.beginRenderPass({
        colorAttachments: [{
          view: this.layerTextures[i].createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        }],
      });
      pass.setPipeline(lp.pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(6);
      pass.end();
    }
  }

  private encodePersistence(enc: GPUCommandEncoder, state: RendererState, fps: number): void {
    this.persistence.encode(enc, this.getLayerTexturesTuple(), {
      fps,
      colorThresh: state.tracerThreshold ?? 0.05,
      tracerMode: state.tracerMode ?? 0,
      stampBoost: state.stampBoost ?? 1.8,
      peakMode: state.peakCollisionsOnly ? 1 : 0,
      belowDuration: state.tracerBelowDuration ?? 0,
      aboveDuration: state.tracerAboveDuration ?? 1000,
      paused: false,
      useWasm: state.wasmEngine,
    });
  }

  private async renderSeparatedPass(
    state: RendererState,
    layerOpacities: [number, number, number],
    size: number,
  ): Promise<Uint8ClampedArray<ArrayBuffer> | null> {
    const enc = this.device.createCommandEncoder();
    this.encodeLayerPasses(enc, state, layerOpacities);

    this.compositor.writeUniforms({
      tracerAboveOp: 0,
      tracerBelowOp: 0,
      layerBlendMode: state.layerBlendMode ?? 0,
      tracerBlendMode: state.tracerBlendMode ?? 0,
      layerOpacities,
      diagnosticsOpacity: 0,
      stampBoost: state.stampBoost ?? 1.8,
      outputMode: state.outputMode ?? 0,
      tracerMode: state.tracerMode ?? 0,
      diagnosticsMode: false,
      viewportQuarterZoom: false,
      halfOverlayAlpha: 0.5,
      viewportHalfOverlay: false,
    });

    const emptyBelow = this.persistence.belowTextures[this.persistence.pingPong]!;
    const emptyAbove = this.persistence.aboveTextures[this.persistence.pingPong]!;
    this.compositor.encode(
      enc,
      this.outputTexture!.createView(),
      this.getLayerTexturesTuple(),
      emptyBelow,
      emptyAbove,
      this.persistence.pingPong,
    );
    this.device.queue.submit([enc.finish()]);

    const result = await this.readback.readTexturePixels(this.outputTexture!, size, size);
    return result?.data ?? null;
  }

  private async renderTracerPass(
    state: RendererState,
    layerOpacities: [number, number, number],
    size: number,
  ): Promise<Uint8ClampedArray<ArrayBuffer> | null> {
    const enc = this.device.createCommandEncoder();
    const tracerAboveOp = state.tracerAboveIntensity ?? 0.85;
    const tracerBelowOp = state.tracerBelowIntensity ?? 0.30;
    const layerBlendMode = state.layerBlendMode ?? 0;
    const tracerBlendMode = state.tracerBlendMode ?? 0;

    this.tracerInspect.encodeTracerView(
      enc,
      this.outputTexture!.createView(),
      {
        canvasWidth: size,
        canvasHeight: size,
        tracerAboveOpacity: tracerAboveOp,
        tracerBelowOpacity: tracerBelowOp,
        tracerBlendMode,
        inspectZoom: 1,
        inspectPanX: 0,
        inspectPanY: 0,
        showHeatmap: false,
        exposure: 1,
        applyTonemap: false,
        showLayers: false,
        layerBlendMode,
        layerOpacity0: layerOpacities[0],
        layerOpacity1: layerOpacities[1],
        layerOpacity2: layerOpacities[2],
      },
      {
        layerTextures: this.getLayerTexturesTuple(),
        persistAbove: this.persistence.aboveTextures[this.persistence.pingPong]!,
        persistBelow: this.persistence.belowTextures[this.persistence.pingPong]!,
        pingPong: this.persistence.pingPong,
      },
    );
    this.device.queue.submit([enc.finish()]);

    const result = await this.readback.readTexturePixels(this.outputTexture!, size, size);
    return result?.data ?? null;
  }

  private getLayerTexturesTuple(): [GPUTexture, GPUTexture, GPUTexture] {
    return [this.layerTextures[0], this.layerTextures[1], this.layerTextures[2]];
  }
}
