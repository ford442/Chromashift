import {
  fullscreenVertexSource,
  displayTextureFragmentSource,
  persistDiagnosticBlitFragmentSource,
  stampDiagnosticViewFragmentSource,
  toHdrPresentWgsl,
} from './shaders';
import { DEFAULT_LAYER_COUNT, assertLayerCount } from './graph';
import { emitCoincidenceHeatmapWgsl, emitCompareWgsl, emitTracerViewWgsl } from './shaders/diagnostics';
import type { CanvasPresentation } from './gpuOptions';
import { layoutFromReflection } from './shaders/bindingReflection';

/**
 * The pipelines that read a frame rather than draw one: the inspect views
 * (`TracerInspectPass`) and the collision-stats blit (`GpuReadback`).
 *
 * The frame itself is the pass graph's — `graph/exec/nodePipelines.ts` builds
 * those pipelines from the compiled graph. What used to live here alongside
 * these (the hand encoder's layer, persistence and compositor pipelines) went
 * with the hand encoder (docs/PASS_GRAPH.md, Phase 3).
 */
export class WebGPUPipelines {
  public device: GPUDevice;
  public format: GPUTextureFormat;

  /**
   * How many band-layer textures every layout below is sized for.
   *
   * The tracer-view, heatmap and compare passes each bind one texture per
   * layer, so their binding numbers shift with the count — which is why each
   * layout is read off the shader emitted for this count
   * (`shaders/bindingReflection.ts`) rather than written out a second time.
   */
  public readonly layerCount: number;

  /**
   * Output encode for the pipelines that target `format` (the canvas): the
   * clamping sRGB OETF for `sdr`, the unclamped extended-sRGB one for
   * `hdr-extended` (docs/gpu-bootstrap.md).
   */
  public readonly presentation: CanvasPresentation;

  public tracerViewBGL: GPUBindGroupLayout;
  public displayBGL: GPUBindGroupLayout;
  public heatmapBGL: GPUBindGroupLayout;
  public compareBGL: GPUBindGroupLayout;
  public persistDiagnosticBlitBGL: GPUBindGroupLayout;
  public stampDiagnosticViewBGL: GPUBindGroupLayout;

  constructor(
    device: GPUDevice,
    format: GPUTextureFormat,
    layerCount: number = DEFAULT_LAYER_COUNT,
    presentation: CanvasPresentation = 'sdr',
  ) {
    this.device = device;
    this.format = format;
    this.layerCount = assertLayerCount(layerCount);
    this.presentation = presentation;

    this.tracerViewBGL = this.createTracerViewBGL();
    this.displayBGL = this.createDisplayBGL();
    this.heatmapBGL = this.createHeatmapBGL();
    this.compareBGL = this.createCompareBGL();
    this.persistDiagnosticBlitBGL = this.createPersistDiagnosticBlitBGL();
    this.stampDiagnosticViewBGL = this.createStampDiagnosticViewBGL();
  }

  /** A canvas-target fragment source, encoded for this pipeline set's presentation. */
  private canvasSource(source: string): string {
    return this.presentation === 'hdr-extended' ? toHdrPresentWgsl(source) : source;
  }

  /** The layout a fullscreen pass running `fragment` needs. */
  private layoutFor(fragment: string): GPUBindGroupLayout {
    return this.device.createBindGroupLayout({
      entries: layoutFromReflection([
        { code: fullscreenVertexSource, visibility: GPUShaderStage.VERTEX },
        { code: fragment, visibility: GPUShaderStage.FRAGMENT },
      ]),
    });
  }

  public createTracerViewBGL(): GPUBindGroupLayout {
    return this.layoutFor(emitTracerViewWgsl(this.layerCount));
  }

  public createDisplayBGL(): GPUBindGroupLayout {
    return this.layoutFor(displayTextureFragmentSource);
  }

  public createHeatmapBGL(): GPUBindGroupLayout {
    return this.layoutFor(emitCoincidenceHeatmapWgsl(this.layerCount));
  }

  public createCompareBGL(): GPUBindGroupLayout {
    return this.layoutFor(emitCompareWgsl(this.layerCount));
  }

  public createPersistDiagnosticBlitBGL(): GPUBindGroupLayout {
    return this.layoutFor(persistDiagnosticBlitFragmentSource);
  }

  public createStampDiagnosticViewBGL(): GPUBindGroupLayout {
    return this.layoutFor(stampDiagnosticViewFragmentSource);
  }

  public createTracerViewPipeline(): GPURenderPipeline {

    const device = this.device;
    return device.createRenderPipeline({
      layout  : device.createPipelineLayout({ bindGroupLayouts: [this.tracerViewBGL] }),
      vertex  : { module: device.createShaderModule({ code: fullscreenVertexSource }), entryPoint: 'main' },
      fragment: {
        module     : device.createShaderModule({ code: this.canvasSource(emitTracerViewWgsl(this.layerCount)) }),
        entryPoint : 'main',
        targets    : [{ format: this.format }],
      },
      primitive  : { topology: 'triangle-list' },
      multisample: { count: 1 },
    });
  }

  public createDisplayPipeline(): GPURenderPipeline {

    return this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.displayBGL] }),
      vertex: { module: this.device.createShaderModule({ code: fullscreenVertexSource }), entryPoint: 'main' },
      fragment: {
        module: this.device.createShaderModule({ code: this.canvasSource(displayTextureFragmentSource) }),
        entryPoint: 'main',
        targets: [{ format: this.format }],
      },
      primitive: { topology: 'triangle-list' },
      multisample: { count: 1 },
    });
  }

  public createHeatmapPipeline(): GPURenderPipeline {

    return this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.heatmapBGL] }),
      vertex: { module: this.device.createShaderModule({ code: fullscreenVertexSource }), entryPoint: 'main' },
      fragment: {
        module: this.device.createShaderModule({ code: this.canvasSource(emitCoincidenceHeatmapWgsl(this.layerCount)) }),
        entryPoint: 'main',
        targets: [{ format: this.format }],
      },
      primitive: { topology: 'triangle-list' },
      multisample: { count: 1 },
    });
  }

  public createComparePipeline(): GPURenderPipeline {

    return this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.compareBGL] }),
      vertex: { module: this.device.createShaderModule({ code: fullscreenVertexSource }), entryPoint: 'main' },
      fragment: {
        module: this.device.createShaderModule({ code: this.canvasSource(emitCompareWgsl(this.layerCount)) }),
        entryPoint: 'main',
        targets: [{ format: this.format }],
      },
      primitive: { topology: 'triangle-list' },
      multisample: { count: 1 },
    });
  }

  public createPersistDiagnosticBlitPipeline(): GPURenderPipeline {

    return this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.persistDiagnosticBlitBGL] }),
      vertex: { module: this.device.createShaderModule({ code: fullscreenVertexSource }), entryPoint: 'main' },
      fragment: {
        module: this.device.createShaderModule({ code: persistDiagnosticBlitFragmentSource }),
        entryPoint: 'main',
        targets: [{ format: 'rgba8unorm' }],
      },
      primitive: { topology: 'triangle-list' },
      multisample: { count: 1 },
    });
  }

  public createStampDiagnosticViewPipeline(): GPURenderPipeline {

    return this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.stampDiagnosticViewBGL] }),
      vertex: { module: this.device.createShaderModule({ code: fullscreenVertexSource }), entryPoint: 'main' },
      fragment: {
        module: this.device.createShaderModule({ code: this.canvasSource(stampDiagnosticViewFragmentSource) }),
        entryPoint: 'main',
        targets: [{ format: this.format }],
      },
      primitive: { topology: 'triangle-list' },
      multisample: { count: 1 },
    });
  }
}
