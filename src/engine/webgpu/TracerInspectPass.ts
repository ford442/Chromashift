import { MAIN_VIEW_MODES } from '../viewModes';
import {
  bindGroupSlot,
  cachedBindGroup,
  layerTextureEntries,
  type BindGroupSlot,
  type LayerTextures,
} from './bindGroups';
import type { InspectPipelines, WebGPUPipelines } from './WebGPUPipelines';
import { DEFAULT_PER_LAYER_OPACITY, RENDERER_STATE_DEFAULTS } from '../../state/defaults';
import { createUniformData, packUniforms, type UniformData } from '../graph/templates/uniformLayout';
import {
  DISPLAY_UNIFORMS,
  HEATMAP_UNIFORMS,
  compareUniformLayout,
  tracerViewUniformLayout,
} from '../shaders/diagnostics';

/** One opacity per band layer the pass binds; a missing one is opaque. */
function layerOpacityValues(opacities: readonly number[] | undefined, count: number): Record<string, number> {
  const values: Record<string, number> = {};
  for (let i = 0; i < count; i += 1) values[`layerOpacity${i}`] = opacities?.[i] ?? DEFAULT_PER_LAYER_OPACITY;
  return values;
}

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
  /**
   * The inspect passes for `pipelines`, once the device has compiled them.
   * Rejects with a `PipelineCompileError` naming the pass and the compiler's
   * messages.
   */
  static async create(
    device: GPUDevice,
    pipelines: WebGPUPipelines,
    compositorSampler: GPUSampler,
  ): Promise<TracerInspectPass> {
    const built = await pipelines.createInspectPipelines();
    return new TracerInspectPass(device, pipelines, built, compositorSampler);
  }

  private readonly device: GPUDevice;
  private readonly compositorSampler: GPUSampler;

  private readonly tracerViewPipeline: GPURenderPipeline;
  private readonly tracerViewBGL: GPUBindGroupLayout;
  private readonly tracerViewUniformBuf: GPUBuffer;
  private readonly tracerViewSampler: GPUSampler;
  /** The band layers every pass here binds — `pipelines.layerCount`. */
  private readonly layerCount: number;
  private readonly tracerViewUniforms: UniformData;
  /** One per ping-pong phase: the tracers' read halves alternate every frame. */
  private readonly tracerViewBindGroups: [BindGroupSlot, BindGroupSlot] = [bindGroupSlot(), bindGroupSlot()];

  private readonly displayPipeline: GPURenderPipeline;
  private readonly displayBGL: GPUBindGroupLayout;
  private readonly displayUniformBuf: GPUBuffer;
  private readonly displayUniforms = createUniformData(DISPLAY_UNIFORMS);
  private readonly displayBindGroup = bindGroupSlot();

  private readonly heatmapPipeline: GPURenderPipeline;
  private readonly heatmapBGL: GPUBindGroupLayout;
  private readonly heatmapUniformBuf: GPUBuffer;
  private readonly heatmapUniforms = createUniformData(HEATMAP_UNIFORMS);
  private readonly heatmapBindGroup = bindGroupSlot();

  private readonly comparePipeline: GPURenderPipeline;
  private readonly compareBGL: GPUBindGroupLayout;
  private readonly compareUniformBuf: GPUBuffer;
  private readonly compareUniforms: UniformData;
  /** Per ping-pong phase, like the tracer view: it binds both tracers too. */
  private readonly compareBindGroups: [BindGroupSlot, BindGroupSlot] = [bindGroupSlot(), bindGroupSlot()];

  private readonly stampDiagnosticViewPipeline: GPURenderPipeline;
  private readonly stampDiagnosticViewBGL: GPUBindGroupLayout;
  private readonly stampDiagnosticViewSampler: GPUSampler;
  /** Per ping-pong phase: the diagnostic accumulator flips with the tracers. */
  private readonly stampDiagnosticBindGroups: [BindGroupSlot, BindGroupSlot] = [bindGroupSlot(), bindGroupSlot()];

  private constructor(
    device: GPUDevice,
    pipelines: WebGPUPipelines,
    built: InspectPipelines,
    compositorSampler: GPUSampler,
  ) {
    this.device = device;
    this.compositorSampler = compositorSampler;
    this.layerCount = pipelines.layerCount;
    this.tracerViewUniforms = createUniformData(tracerViewUniformLayout(this.layerCount));
    this.compareUniforms = createUniformData(compareUniformLayout(this.layerCount));

    this.tracerViewBGL = pipelines.tracerViewBGL;
    this.tracerViewPipeline = built.tracerView;
    this.tracerViewUniformBuf = device.createBuffer({
      size: tracerViewUniformLayout(pipelines.layerCount).bytes,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.tracerViewSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'nearest',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    this.displayBGL = pipelines.displayBGL;
    this.displayPipeline = built.display;
    this.displayUniformBuf = device.createBuffer({
      size: DISPLAY_UNIFORMS.bytes,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.heatmapBGL = pipelines.heatmapBGL;
    this.heatmapPipeline = built.heatmap;
    this.heatmapUniformBuf = device.createBuffer({
      size: HEATMAP_UNIFORMS.bytes,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.compareBGL = pipelines.compareBGL;
    this.comparePipeline = built.compare;
    this.compareUniformBuf = device.createBuffer({
      size: compareUniformLayout(pipelines.layerCount).bytes,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.stampDiagnosticViewBGL = pipelines.stampDiagnosticViewBGL;
    this.stampDiagnosticViewPipeline = built.stampDiagnosticView;
    this.stampDiagnosticViewSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
  }

  /**
   * Whether {@link encodeMainView} draws `mainViewMode` itself for a frame of
   * `layerCount` band layers — every view but the processed composite, and a
   * layer view only of a layer the frame has. A frame showing one of these
   * needs the graph's outputs, not its compositor.
   */
  static drawsMainView(mainViewMode: number, layerCount: number): boolean {
    const layerIndex = mainViewMode - MAIN_VIEW_MODES.LAYER_0;
    return mainViewMode === MAIN_VIEW_MODES.FULL_RES_TRACER
      || mainViewMode === MAIN_VIEW_MODES.SOURCE_IMAGE
      || (mainViewMode >= MAIN_VIEW_MODES.LAYER_0 && mainViewMode <= MAIN_VIEW_MODES.LAYER_2
        && layerIndex < layerCount)
      || mainViewMode === MAIN_VIEW_MODES.COINCIDENCE_HEATMAP
      || mainViewMode === MAIN_VIEW_MODES.COMPARE_SOURCE_COMPOSITE
      || mainViewMode === MAIN_VIEW_MODES.STAMP_DIAGNOSTICS;
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

    if (
      mainViewMode >= MAIN_VIEW_MODES.LAYER_0 && mainViewMode <= MAIN_VIEW_MODES.LAYER_2
      && mainViewMode - MAIN_VIEW_MODES.LAYER_0 < params.layerTextures.length
    ) {
      const layerIndex = mainViewMode - MAIN_VIEW_MODES.LAYER_0;
      this.encodeDisplay(
        enc,
        canvasView,
        params.layerTextures[layerIndex]!,
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
      this.encodeStampDiagnostic(enc, canvasView, params.persistDiagnostic, params.pingPong);
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
    packUniforms(tracerViewUniformLayout(this.layerCount), {
      ...layerOpacityValues(options.layerOpacities, this.layerCount),
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
    }, this.tracerViewUniforms);
    this.device.queue.writeBuffer(this.tracerViewUniformBuf, 0, this.tracerViewUniforms.buffer);

    const bg = cachedBindGroup(
      this.device,
      this.tracerViewBindGroups[ctx.pingPong],
      this.tracerViewBGL,
      [ctx.persistAbove, ctx.persistBelow, ...ctx.layerTextures],
      () => [
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

    const bg = cachedBindGroup(
      this.device,
      this.displayBindGroup,
      this.displayBGL,
      [sampler, texture],
      () => [
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

    const bg = cachedBindGroup(
      this.device,
      this.heatmapBindGroup,
      this.heatmapBGL,
      layerTextures,
      () => [
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
    packUniforms(compareUniformLayout(this.layerCount), {
      ...layerOpacityValues(params.layerOpacities, this.layerCount),
      sourceAspect: params.sourceTexture.width / Math.max(1, params.sourceTexture.height),
      tracerAboveOpacity: params.tracerAboveOp,
      tracerBelowOpacity: params.tracerBelowOp,
      layerBlendMode: params.layerBlendMode,
      tracerBlendMode: params.tracerBlendMode,
      stampBoost: params.stampBoost,
      dividerWidth: 0.004,
      outputMode: params.outputMode,
      tracerMode: params.tracerMode,
    }, this.compareUniforms);
    this.device.queue.writeBuffer(this.compareUniformBuf, 0, this.compareUniforms.buffer);

    const bg = cachedBindGroup(
      this.device,
      this.compareBindGroups[params.pingPong],
      this.compareBGL,
      [params.sourceSampler, params.sourceTexture, ...params.layerTextures, params.persistBelow, params.persistAbove],
      () => [
        { binding: 0, resource: params.sourceSampler },
        { binding: 1, resource: params.sourceTexture.createView() },
        ...layerTextureEntries(2, params.layerTextures),
        { binding: params.layerTextures.length + 2, resource: params.persistBelow.createView() },
        { binding: params.layerTextures.length + 3, resource: params.persistAbove.createView() },
        { binding: params.layerTextures.length + 4, resource: { buffer: this.compareUniformBuf } },
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
    pass.setPipeline(this.comparePipeline);
    pass.setBindGroup(0, bg);
    pass.draw(6);
    pass.end();
  }

  private encodeStampDiagnostic(
    enc: GPUCommandEncoder,
    targetView: GPUTextureView,
    persistDiagnostic: GPUTexture,
    pingPong: 0 | 1,
  ): void {
    const bg = cachedBindGroup(
      this.device,
      this.stampDiagnosticBindGroups[pingPong],
      this.stampDiagnosticViewBGL,
      [persistDiagnostic],
      () => [
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
