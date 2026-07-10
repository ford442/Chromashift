import { MAIN_VIEW_MODES } from './viewModes';
import {
  createTexturePairCache,
  getOrCreateLayerTextureBindGroup,
  getOrCreateSimpleTextureBindGroup,
  getOrCreateTexturePairBindGroup,
  invalidateLayerTextureCache,
  invalidateSimpleTextureCache,
  invalidateTexturePairCache,
  type LayerTextureBindGroupCacheEntry,
  type SimpleTextureBindGroupCacheEntry,
  type TexturePairBindGroupCacheEntry,
} from './BindGroupCache';
import type { WebGPUPipelines } from './WebGPUPipelines';

export interface TracerViewEncodeParams {
  canvasWidth: number;
  canvasHeight: number;
  tracerAboveOpacity: number;
  tracerBelowOpacity: number;
  tracerBlendMode: number;
  inspectZoom?: number;
  inspectPanX?: number;
  inspectPanY?: number;
  showHeatmap?: boolean;
  exposure?: number;
  applyTonemap?: boolean;
  showLayers?: boolean;
  layerBlendMode?: number;
  layerOpacity0?: number;
  layerOpacity1?: number;
  layerOpacity2?: number;
}

export interface MainViewEncodeParams {
  mainViewMode: number;
  canvasView: GPUTextureView;
  canvasWidth: number;
  canvasHeight: number;
  sourceTexture: GPUTexture;
  sourceSampler: GPUSampler;
  layerTextures: [GPUTexture, GPUTexture, GPUTexture];
  persistBelow: GPUTexture;
  persistAbove: GPUTexture;
  persistDiagnostic: GPUTexture | null;
  pingPong: 0 | 1;
  colorThresh: number;
  tracerAboveOp: number;
  tracerBelowOp: number;
  layerBlendMode: number;
  tracerBlendMode: number;
  layerOpacities: [number, number, number];
  stampBoost: number;
  outputMode: number;
  tracerMode: number;
  tracerInspect?: Omit<TracerViewEncodeParams, 'canvasWidth' | 'canvasHeight' | 'tracerAboveOpacity' | 'tracerBelowOpacity' | 'tracerBlendMode' | 'layerBlendMode' | 'layerOpacity0' | 'layerOpacity1' | 'layerOpacity2'>;
}

export class TracerInspectPass {
  private readonly device: GPUDevice;
  private readonly compositorSampler: GPUSampler;

  private readonly tracerViewPipeline: GPURenderPipeline;
  private readonly tracerViewBGL: GPUBindGroupLayout;
  private readonly tracerViewUniformBuf: GPUBuffer;
  private readonly tracerViewSampler: GPUSampler;
  private readonly tracerViewUniformData = new ArrayBuffer(80);
  private readonly tracerViewF32 = new Float32Array(this.tracerViewUniformData);
  private readonly tracerViewU32 = new Uint32Array(this.tracerViewUniformData);
  private readonly tracerViewBindGroupCache: TexturePairBindGroupCacheEntry[];

  private readonly displayPipeline: GPURenderPipeline;
  private readonly displayBGL: GPUBindGroupLayout;
  private readonly displayUniformBuf: GPUBuffer;
  private readonly displayUniformData = new ArrayBuffer(16);
  private readonly displayF32 = new Float32Array(this.displayUniformData);
  private readonly displayU32 = new Uint32Array(this.displayUniformData);
  private readonly displayBindGroupCache: SimpleTextureBindGroupCacheEntry = {
    bindGroup: null,
    texture: null,
    sampler: null,
  };

  private readonly heatmapPipeline: GPURenderPipeline;
  private readonly heatmapBGL: GPUBindGroupLayout;
  private readonly heatmapUniformBuf: GPUBuffer;
  private readonly heatmapUniformData = new ArrayBuffer(16);
  private readonly heatmapF32 = new Float32Array(this.heatmapUniformData);
  private readonly heatmapBindGroupCache: LayerTextureBindGroupCacheEntry = {
    bindGroup: null,
    layer0: null,
    layer1: null,
    layer2: null,
    uniformBuf: null,
    extraTexture: null,
  };

  private readonly comparePipeline: GPURenderPipeline;
  private readonly compareBGL: GPUBindGroupLayout;
  private readonly compareUniformBuf: GPUBuffer;
  private readonly compareUniformData = new ArrayBuffer(48);
  private readonly compareF32 = new Float32Array(this.compareUniformData);
  private readonly compareU32 = new Uint32Array(this.compareUniformData);
  private readonly compareBindGroupCache: LayerTextureBindGroupCacheEntry = {
    bindGroup: null,
    layer0: null,
    layer1: null,
    layer2: null,
    uniformBuf: null,
    extraTexture: null,
  };

  private readonly stampDiagnosticViewPipeline: GPURenderPipeline;
  private readonly stampDiagnosticViewBGL: GPUBindGroupLayout;
  private readonly stampDiagnosticViewSampler: GPUSampler;
  private readonly stampDiagnosticBindGroupCache: SimpleTextureBindGroupCacheEntry = {
    bindGroup: null,
    texture: null,
    sampler: null,
  };

  constructor(
    device: GPUDevice,
    pipelines: WebGPUPipelines,
    compositorSampler: GPUSampler,
  ) {
    this.device = device;
    this.compositorSampler = compositorSampler;

    this.tracerViewBGL = pipelines.tracerViewBGL;
    this.tracerViewPipeline = pipelines.createTracerViewPipeline();
    this.tracerViewUniformBuf = device.createBuffer({
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.tracerViewSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'nearest',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    this.tracerViewBindGroupCache = createTexturePairCache(2);

    this.displayBGL = pipelines.displayBGL;
    this.displayPipeline = pipelines.createDisplayPipeline();
    this.displayUniformBuf = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.heatmapBGL = pipelines.heatmapBGL;
    this.heatmapPipeline = pipelines.createHeatmapPipeline();
    this.heatmapUniformBuf = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.compareBGL = pipelines.compareBGL;
    this.comparePipeline = pipelines.createComparePipeline();
    this.compareUniformBuf = device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.stampDiagnosticViewBGL = pipelines.stampDiagnosticViewBGL;
    this.stampDiagnosticViewPipeline = pipelines.createStampDiagnosticViewPipeline();
    this.stampDiagnosticViewSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
  }

  invalidateCaches(): void {
    invalidateTexturePairCache(this.tracerViewBindGroupCache);
    invalidateSimpleTextureCache(this.displayBindGroupCache);
    invalidateLayerTextureCache(this.heatmapBindGroupCache);
    invalidateLayerTextureCache(this.compareBindGroupCache);
    invalidateSimpleTextureCache(this.stampDiagnosticBindGroupCache);
  }

  encodeMainView(enc: GPUCommandEncoder, params: MainViewEncodeParams): boolean {
    const {
      mainViewMode,
      canvasView,
      canvasWidth,
      canvasHeight,
      tracerAboveOp,
      tracerBelowOp,
      tracerBlendMode,
      layerBlendMode,
      layerOpacities,
    } = params;

    if (mainViewMode === MAIN_VIEW_MODES.FULL_RES_TRACER) {
      this.encodeTracerView(enc, canvasView, {
        canvasWidth,
        canvasHeight,
        tracerAboveOpacity: tracerAboveOp,
        tracerBelowOpacity: tracerBelowOp,
        tracerBlendMode,
        layerBlendMode,
        layerOpacity0: layerOpacities[0],
        layerOpacity1: layerOpacities[1],
        layerOpacity2: layerOpacities[2],
        ...params.tracerInspect,
      }, params);
      return true;
    }

    if (mainViewMode === MAIN_VIEW_MODES.SOURCE_IMAGE) {
      this.encodeDisplay(
        enc,
        canvasView,
        params.sourceTexture,
        params.sourceSampler,
        canvasWidth / Math.max(1, canvasHeight),
        params.sourceTexture.width / Math.max(1, params.sourceTexture.height),
        0,
      );
      return true;
    }

    if (mainViewMode >= MAIN_VIEW_MODES.LAYER_0 && mainViewMode <= MAIN_VIEW_MODES.LAYER_2) {
      const layerIndex = mainViewMode - MAIN_VIEW_MODES.LAYER_0;
      this.encodeDisplay(
        enc,
        canvasView,
        params.layerTextures[layerIndex],
        this.compositorSampler,
        1,
        1,
        1,
      );
      return true;
    }

    if (mainViewMode === MAIN_VIEW_MODES.COINCIDENCE_HEATMAP) {
      this.encodeHeatmap(enc, canvasView, params.layerTextures, params.colorThresh);
      return true;
    }

    if (mainViewMode === MAIN_VIEW_MODES.COMPARE_SOURCE_COMPOSITE) {
      this.encodeCompare(enc, canvasView, params);
      return true;
    }

    if (mainViewMode === MAIN_VIEW_MODES.STAMP_DIAGNOSTICS && params.persistDiagnostic) {
      this.encodeStampDiagnostic(enc, canvasView, params.persistDiagnostic);
      return true;
    }

    return false;
  }

  encodeTracerView(
    enc: GPUCommandEncoder,
    targetView: GPUTextureView,
    options: TracerViewEncodeParams,
    ctx?: Pick<MainViewEncodeParams, 'layerTextures' | 'persistAbove' | 'persistBelow' | 'pingPong'>,
  ): void {
    if (!ctx) return;

    const tW = ctx.persistAbove.width;
    const tH = ctx.persistAbove.height;

    this.tracerViewF32[0] = options.canvasWidth / Math.max(1, options.canvasHeight);
    this.tracerViewF32[1] = tW / Math.max(1, tH);
    this.tracerViewF32[2] = options.tracerAboveOpacity;
    this.tracerViewF32[3] = options.tracerBelowOpacity;
    this.tracerViewU32[4] = options.tracerBlendMode;
    this.tracerViewU32[5] = options.showHeatmap ? 1 : 0;
    this.tracerViewF32[6] = Math.max(1, options.inspectZoom ?? 1);
    this.tracerViewF32[7] = options.inspectPanX ?? 0;
    this.tracerViewF32[8] = options.inspectPanY ?? 0;
    this.tracerViewF32[9] = 0.82;
    this.tracerViewF32[10] = options.exposure ?? 1.04;
    this.tracerViewU32[11] = (options.applyTonemap ?? true) ? 1 : 0;
    this.tracerViewU32[12] = (options.showLayers ?? false) ? 1 : 0;
    this.tracerViewU32[13] = options.layerBlendMode ?? 0;
    this.tracerViewF32[14] = options.layerOpacity0 ?? 1;
    this.tracerViewF32[15] = options.layerOpacity1 ?? 1;
    this.tracerViewF32[16] = options.layerOpacity2 ?? 1;
    this.device.queue.writeBuffer(this.tracerViewUniformBuf, 0, this.tracerViewUniformData);

    const bg = getOrCreateTexturePairBindGroup(
      this.device,
      this.tracerViewBindGroupCache[ctx.pingPong],
      this.tracerViewBGL,
      ctx.layerTextures,
      ctx.persistAbove,
      ctx.persistBelow,
      [
        { binding: 0, resource: this.tracerViewSampler },
        { binding: 1, resource: ctx.persistAbove.createView() },
        { binding: 2, resource: ctx.persistBelow.createView() },
        { binding: 3, resource: ctx.layerTextures[0].createView() },
        { binding: 4, resource: ctx.layerTextures[1].createView() },
        { binding: 5, resource: ctx.layerTextures[2].createView() },
        { binding: 6, resource: { buffer: this.tracerViewUniformBuf } },
      ],
    );

    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: targetView,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    pass.setPipeline(this.tracerViewPipeline);
    pass.setBindGroup(0, bg);
    pass.draw(6);
    pass.end();
  }

  destroy(): void {
    this.tracerViewUniformBuf.destroy();
    this.displayUniformBuf.destroy();
    this.heatmapUniformBuf.destroy();
    this.compareUniformBuf.destroy();
  }

  private encodeDisplay(
    enc: GPUCommandEncoder,
    targetView: GPUTextureView,
    texture: GPUTexture,
    sampler: GPUSampler,
    canvasAspect: number,
    textureAspect: number,
    mode: number,
  ): void {
    this.displayF32[0] = canvasAspect;
    this.displayF32[1] = textureAspect;
    this.displayU32[2] = mode;
    this.displayU32[3] = 0;
    this.device.queue.writeBuffer(this.displayUniformBuf, 0, this.displayUniformData);

    const bg = getOrCreateSimpleTextureBindGroup(
      this.device,
      this.displayBindGroupCache,
      this.displayBGL,
      sampler,
      texture,
      [
        { binding: 0, resource: sampler },
        { binding: 1, resource: texture.createView() },
        { binding: 2, resource: { buffer: this.displayUniformBuf } },
      ],
    );

    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: targetView,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    pass.setPipeline(this.displayPipeline);
    pass.setBindGroup(0, bg);
    pass.draw(6);
    pass.end();
  }

  private encodeHeatmap(
    enc: GPUCommandEncoder,
    targetView: GPUTextureView,
    layerTextures: [GPUTexture, GPUTexture, GPUTexture],
    colorThresh: number,
  ): void {
    this.heatmapF32[0] = colorThresh;
    this.heatmapF32[1] = 0;
    this.heatmapF32[2] = 0;
    this.heatmapF32[3] = 0;
    this.device.queue.writeBuffer(this.heatmapUniformBuf, 0, this.heatmapUniformData);

    const bg = getOrCreateLayerTextureBindGroup(
      this.device,
      this.heatmapBindGroupCache,
      this.heatmapBGL,
      layerTextures,
      this.heatmapUniformBuf,
      [
        { binding: 0, resource: this.compositorSampler },
        { binding: 1, resource: layerTextures[0].createView() },
        { binding: 2, resource: layerTextures[1].createView() },
        { binding: 3, resource: layerTextures[2].createView() },
        { binding: 4, resource: { buffer: this.heatmapUniformBuf } },
      ],
    );

    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: targetView,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    pass.setPipeline(this.heatmapPipeline);
    pass.setBindGroup(0, bg);
    pass.draw(6);
    pass.end();
  }

  private encodeCompare(enc: GPUCommandEncoder, targetView: GPUTextureView, params: MainViewEncodeParams): void {
    this.compareF32[0] = params.sourceTexture.width / Math.max(1, params.sourceTexture.height);
    this.compareF32[1] = params.tracerAboveOp;
    this.compareF32[2] = params.tracerBelowOp;
    this.compareU32[3] = params.layerBlendMode;
    this.compareU32[4] = params.tracerBlendMode;
    this.compareF32[5] = params.layerOpacities[0];
    this.compareF32[6] = params.layerOpacities[1];
    this.compareF32[7] = params.layerOpacities[2];
    this.compareF32[8] = params.stampBoost;
    this.compareF32[9] = 0.004;
    this.compareU32[10] = params.outputMode;
    this.compareU32[11] = params.tracerMode;
    this.device.queue.writeBuffer(this.compareUniformBuf, 0, this.compareUniformData);

    const bg = getOrCreateLayerTextureBindGroup(
      this.device,
      this.compareBindGroupCache,
      this.compareBGL,
      params.layerTextures,
      this.compareUniformBuf,
      [
        { binding: 0, resource: params.sourceSampler },
        { binding: 1, resource: params.sourceTexture.createView() },
        { binding: 2, resource: params.layerTextures[0].createView() },
        { binding: 3, resource: params.layerTextures[1].createView() },
        { binding: 4, resource: params.layerTextures[2].createView() },
        { binding: 5, resource: params.persistBelow.createView() },
        { binding: 6, resource: params.persistAbove.createView() },
        { binding: 7, resource: { buffer: this.compareUniformBuf } },
      ],
      params.persistAbove,
    );

    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: targetView,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    pass.setPipeline(this.comparePipeline);
    pass.setBindGroup(0, bg);
    pass.draw(6);
    pass.end();
  }

  private encodeStampDiagnostic(
    enc: GPUCommandEncoder,
    targetView: GPUTextureView,
    persistDiagnostic: GPUTexture,
  ): void {
    const bg = getOrCreateSimpleTextureBindGroup(
      this.device,
      this.stampDiagnosticBindGroupCache,
      this.stampDiagnosticViewBGL,
      this.stampDiagnosticViewSampler,
      persistDiagnostic,
      [
        { binding: 0, resource: this.stampDiagnosticViewSampler },
        { binding: 1, resource: persistDiagnostic.createView() },
      ],
    );

    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: targetView,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    pass.setPipeline(this.stampDiagnosticViewPipeline);
    pass.setBindGroup(0, bg);
    pass.draw(6);
    pass.end();
  }
}
