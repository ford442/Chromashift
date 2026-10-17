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
import { layerTextureEntries, type LayerTextures } from './BindGroupCache';
import { DEFAULT_PER_LAYER_OPACITY, RENDERER_STATE_DEFAULTS } from '../state/defaults';
import { createUniformData, packUniforms } from './graph/templates/uniformLayout';
import {
  COMPARE_UNIFORMS,
  DISPLAY_UNIFORMS,
  HEATMAP_UNIFORMS,
  TRACER_VIEW_UNIFORMS,
} from './shaders/diagnostics';

/** The inspection shaders still read three layers; a missing opacity is opaque. */
const opacityAt = (opacities: readonly number[] | undefined, index: number): number =>
  opacities?.[index] ?? DEFAULT_PER_LAYER_OPACITY;

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
  /** Per-layer opacity, one entry per session layer; a missing entry is 1. */
  layerOpacities?: readonly number[];
}

export interface MainViewEncodeParams {
  mainViewMode: number;
  canvasView: GPUTextureView;
  canvasWidth: number;
  canvasHeight: number;
  sourceTexture: GPUTexture;
  sourceSampler: GPUSampler;
  layerTextures: LayerTextures;
  persistBelow: GPUTexture;
  persistAbove: GPUTexture;
  persistDiagnostic: GPUTexture | null;
  pingPong: 0 | 1;
  colorThresh: number;
  tracerAboveOp: number;
  tracerBelowOp: number;
  layerBlendMode: number;
  tracerBlendMode: number;
  layerOpacities: number[];
  stampBoost: number;
  outputMode: number;
  tracerMode: number;
  tracerInspect?: Omit<TracerViewEncodeParams, 'canvasWidth' | 'canvasHeight' | 'tracerAboveOpacity' | 'tracerBelowOpacity' | 'tracerBlendMode' | 'layerBlendMode' | 'layerOpacities'>;
}

export class TracerInspectPass {
  private readonly device: GPUDevice;
  private readonly compositorSampler: GPUSampler;

  private readonly tracerViewPipeline: GPURenderPipeline;
  private readonly tracerViewBGL: GPUBindGroupLayout;
  private readonly tracerViewUniformBuf: GPUBuffer;
  private readonly tracerViewSampler: GPUSampler;
  private readonly tracerViewUniforms = createUniformData(TRACER_VIEW_UNIFORMS);
  private readonly tracerViewBindGroupCache: TexturePairBindGroupCacheEntry[];

  private readonly displayPipeline: GPURenderPipeline;
  private readonly displayBGL: GPUBindGroupLayout;
  private readonly displayUniformBuf: GPUBuffer;
  private readonly displayUniforms = createUniformData(DISPLAY_UNIFORMS);
  private readonly displayBindGroupCache: SimpleTextureBindGroupCacheEntry = {
    bindGroup: null,
    texture: null,
    sampler: null,
  };

  private readonly heatmapPipeline: GPURenderPipeline;
  private readonly heatmapBGL: GPUBindGroupLayout;
  private readonly heatmapUniformBuf: GPUBuffer;
  private readonly heatmapUniforms = createUniformData(HEATMAP_UNIFORMS);
  private readonly heatmapBindGroupCache: LayerTextureBindGroupCacheEntry = {
    bindGroup: null,
    layers: null,
    uniformBuf: null,
    extraTexture: null,
  };

  private readonly comparePipeline: GPURenderPipeline;
  private readonly compareBGL: GPUBindGroupLayout;
  private readonly compareUniformBuf: GPUBuffer;
  private readonly compareUniforms = createUniformData(COMPARE_UNIFORMS);
  private readonly compareBindGroupCache: LayerTextureBindGroupCacheEntry = {
    bindGroup: null,
    layers: null,
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
      size: TRACER_VIEW_UNIFORMS.bytes,
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
      size: DISPLAY_UNIFORMS.bytes,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.heatmapBGL = pipelines.heatmapBGL;
    this.heatmapPipeline = pipelines.createHeatmapPipeline();
    this.heatmapUniformBuf = device.createBuffer({
      size: HEATMAP_UNIFORMS.bytes,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.compareBGL = pipelines.compareBGL;
    this.comparePipeline = pipelines.createComparePipeline();
    this.compareUniformBuf = device.createBuffer({
      size: COMPARE_UNIFORMS.bytes,
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
        layerOpacities,
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

    // Options come from state (`tracerInspectSettings`) or from an export
    // request, whose fields are optional; both fall back to the same defaults.
    const defaults = RENDERER_STATE_DEFAULTS;
    packUniforms(TRACER_VIEW_UNIFORMS, {
      canvasAspect: options.canvasWidth / Math.max(1, options.canvasHeight),
      texAspect: tW / Math.max(1, tH),
      tracerAboveOpacity: options.tracerAboveOpacity,
      tracerBelowOpacity: options.tracerBelowOpacity,
      tracerBlendMode: options.tracerBlendMode,
      showHeatmap: (options.showHeatmap ?? defaults.tracerInspectHeatmap) ? 1 : 0,
      zoom: Math.max(1, options.inspectZoom ?? defaults.tracerInspectZoom),
      panX: options.inspectPanX ?? defaults.tracerInspectPanX,
      panY: options.inspectPanY ?? defaults.tracerInspectPanY,
      heatmapOpacity: 0.82,
      exposure: options.exposure ?? defaults.tracerInspectExposure,
      applyTonemap: (options.applyTonemap ?? defaults.tracerInspectTonemap) ? 1 : 0,
      showLayers: (options.showLayers ?? defaults.tracerInspectShowLayers) ? 1 : 0,
      layerBlendMode: options.layerBlendMode ?? defaults.layerBlendMode,
      layerOpacity0: opacityAt(options.layerOpacities, 0),
      layerOpacity1: opacityAt(options.layerOpacities, 1),
      layerOpacity2: opacityAt(options.layerOpacities, 2),
    }, this.tracerViewUniforms);
    this.device.queue.writeBuffer(this.tracerViewUniformBuf, 0, this.tracerViewUniforms.buffer);

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
        ...layerTextureEntries(3, ctx.layerTextures),
        { binding: ctx.layerTextures.length + 3, resource: { buffer: this.tracerViewUniformBuf } },
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
  ): void {
    packUniforms(DISPLAY_UNIFORMS, { canvasAspect, texAspect: textureAspect }, this.displayUniforms);
    this.device.queue.writeBuffer(this.displayUniformBuf, 0, this.displayUniforms.buffer);

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
    layerTextures: LayerTextures,
    colorThresh: number,
  ): void {
    packUniforms(HEATMAP_UNIFORMS, { threshold: colorThresh }, this.heatmapUniforms);
    this.device.queue.writeBuffer(this.heatmapUniformBuf, 0, this.heatmapUniforms.buffer);

    const bg = getOrCreateLayerTextureBindGroup(
      this.device,
      this.heatmapBindGroupCache,
      this.heatmapBGL,
      layerTextures,
      this.heatmapUniformBuf,
      [
        { binding: 0, resource: this.compositorSampler },
        ...layerTextureEntries(1, layerTextures),
        { binding: layerTextures.length + 1, resource: { buffer: this.heatmapUniformBuf } },
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
    packUniforms(COMPARE_UNIFORMS, {
      sourceAspect: params.sourceTexture.width / Math.max(1, params.sourceTexture.height),
      tracerAboveOpacity: params.tracerAboveOp,
      tracerBelowOpacity: params.tracerBelowOp,
      layerBlendMode: params.layerBlendMode,
      tracerBlendMode: params.tracerBlendMode,
      layerOpacity0: opacityAt(params.layerOpacities, 0),
      layerOpacity1: opacityAt(params.layerOpacities, 1),
      layerOpacity2: opacityAt(params.layerOpacities, 2),
      stampBoost: params.stampBoost,
      dividerWidth: 0.004,
      outputMode: params.outputMode,
      tracerMode: params.tracerMode,
    }, this.compareUniforms);
    this.device.queue.writeBuffer(this.compareUniformBuf, 0, this.compareUniforms.buffer);

    const bg = getOrCreateLayerTextureBindGroup(
      this.device,
      this.compareBindGroupCache,
      this.compareBGL,
      params.layerTextures,
      this.compareUniformBuf,
      [
        { binding: 0, resource: params.sourceSampler },
        { binding: 1, resource: params.sourceTexture.createView() },
        ...layerTextureEntries(2, params.layerTextures),
        { binding: params.layerTextures.length + 2, resource: params.persistBelow.createView() },
        { binding: params.layerTextures.length + 3, resource: params.persistAbove.createView() },
        { binding: params.layerTextures.length + 4, resource: { buffer: this.compareUniformBuf } },
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
