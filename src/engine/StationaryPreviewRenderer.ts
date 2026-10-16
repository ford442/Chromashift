import { layerFragmentSources } from './shaders';
import {
  createLayerBindGroupCache,
  getOrCreateLayerBindGroup,
  invalidateLayerBindGroupCache,
} from './BindGroupCache';
import { CompositorPass } from './CompositorPass';
import { ProfileLutTexture } from './color/ProfileLutTexture';
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
import { drawnLayerCount, encodeLayerClear, type WebGPUPipelines } from './WebGPUPipelines';
import type { LayerTextures } from './BindGroupCache';
import { bandLayerUniforms, compositorUniforms, tracerInspectSettings } from './graph/exec/uniforms';
import { packUniforms } from './graph/templates/uniformLayout';
import { BAND_LAYER_UNIFORMS } from './graph/templates/wgsl';

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
  private readonly layerBindGroupCache = createLayerBindGroupCache(layerFragmentSources.length);
  private readonly layerPipelines: ReturnType<WebGPUPipelines['createLayerPipeline']>[] = [];
  private layerTextures: GPUTexture[] = [];
  private outputTexture: GPUTexture | null = null;
  private sourceTexture: GPUTexture | null = null;
  private maskTexture: GPUTexture | null = null;
  private readonly fallbackMaskTexture: GPUTexture;
  private readonly profileLut: ProfileLutTexture;
  /** Layers the compositor below was built for. */
  private readonly compositorLayerCount: number;

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
    this.compositorLayerCount = pipelines.layerCount;

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
    this.profileLut.destroy();
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

    const separated = wantSeparated
      ? await this.renderSeparatedPass(state, size)
      : null;

    let tracer: Uint8ClampedArray<ArrayBuffer> | null = null;
    if (wantTracer) {
      this.persistence.clear();
      // The preview state is a paused one (it is a still), but the warmup has
      // to accumulate; and no motion field is bound, so the temporal term is off.
      const warmup: RendererState = { ...state, paused: false };
      for (let frame = 0; frame < warmupFrames; frame += 1) {
        const enc = this.device.createCommandEncoder();
        this.encodeLayerPasses(enc, state);
        this.persistence.encode(enc, this.getLayerTextures(), { state: warmup, fps });
        this.device.queue.submit([enc.finish()]);
      }
      tracer = await this.renderTracerPass(state, size);
    }

    return { separated, tracer };
  }

  private ensureResources(size: number): void {
    const layerCount = this.layerPipelines.length;
    if (this.layerTextures.length === layerCount
      && this.layerTextures[0].width === size
      && this.outputTexture?.width === size) {
      return;
    }

    for (const t of this.layerTextures) t.destroy();
    this.outputTexture?.destroy();

    this.layerTextures = Array.from({ length: layerCount }, () => this.device.createTexture({
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
  ): void {
    const maskTexture = this.maskTexture ?? this.fallbackMaskTexture;
    // Non-classic colour profiles render from the baked LUT (docs/COLOR_PROFILES.md).
    this.profileLut.update(state.colorProfileLut);
    const aspect = 1;

    const drawn = drawnLayerCount(this.layerPipelines.length, state.layers.length);
    for (let i = 0; i < this.layerPipelines.length; i++) {
      if (i >= drawn) {
        encodeLayerClear(enc, this.layerTextures[i]);
        continue;
      }
      const lp = this.layerPipelines[i];
      const layer = state.layers[i];

      const [rad, flipX, flipY, layerAspect] = layerRotationUniforms(layer, aspect);
      lp.rotationData.set([rad, flipX, flipY, layerAspect]);
      this.device.queue.writeBuffer(lp.rotationBuffer, 0, lp.rotationData.buffer as ArrayBuffer, lp.rotationData.byteOffset, 16);

      packUniforms(BAND_LAYER_UNIFORMS, bandLayerUniforms(state, {
        layerIndex: i,
        hasClassificationMask: this.maskTexture !== null,
      }), lp.fragUniforms);
      this.device.queue.writeBuffer(lp.fragUniformBuffer, 0, lp.fragUniforms.buffer);

      const bindGroup = getOrCreateLayerBindGroup(
        this.device,
        this.layerBindGroupCache[i],
        lp.bindGroupLayout,
        this.sourceTexture!,
        maskTexture,
        this.sampler,
        lp.rotationBuffer,
        lp.fragUniformBuffer,
        this.profileLut.texture,
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

  private async renderSeparatedPass(
    state: RendererState,
    size: number,
  ): Promise<Uint8ClampedArray<ArrayBuffer> | null> {
    const enc = this.device.createCommandEncoder();
    this.encodeLayerPasses(enc, state);

    // The bands alone: no tracers and no diagnostics overlay.
    this.compositor.writeUniforms({
      ...compositorUniforms(state, this.compositorLayerCount),
      tracerAboveOpacity: 0,
      tracerBelowOpacity: 0,
      diagnosticsOpacity: 0,
      diagnosticsMode: 0,
    });

    const emptyBelow = this.persistence.belowTextures[this.persistence.pingPong]!;
    const emptyAbove = this.persistence.aboveTextures[this.persistence.pingPong]!;
    this.compositor.encode(
      enc,
      this.outputTexture!.createView(),
      this.getLayerTextures(),
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
    size: number,
  ): Promise<Uint8ClampedArray<ArrayBuffer> | null> {
    const enc = this.device.createCommandEncoder();
    const settings = tracerInspectSettings(state);

    this.tracerInspect.encodeTracerView(
      enc,
      this.outputTexture!.createView(),
      {
        // The thumbnail is the whole tracer, untoned: none of the inspect
        // view's zoom, pan, heatmap or exposure settings apply to it.
        ...settings,
        canvasWidth: size,
        canvasHeight: size,
        inspectZoom: 1,
        inspectPanX: 0,
        inspectPanY: 0,
        showHeatmap: false,
        exposure: 1,
        applyTonemap: false,
        showLayers: false,
      },
      {
        layerTextures: this.getLayerTextures(),
        persistAbove: this.persistence.aboveTextures[this.persistence.pingPong]!,
        persistBelow: this.persistence.belowTextures[this.persistence.pingPong]!,
        pingPong: this.persistence.pingPong,
      },
    );
    this.device.queue.submit([enc.finish()]);

    const result = await this.readback.readTexturePixels(this.outputTexture!, size, size);
    return result?.data ?? null;
  }

  private getLayerTextures(): LayerTextures {
    return this.layerTextures;
  }
}
