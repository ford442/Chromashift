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

  /**
   * The five inspect-view pipelines, compiled off the frame.
   *
   * They used to be built synchronously inside `render()` on the first frame
   * that showed an inspect view, outside any error scope — so a shader the
   * device rejected surfaced only as a dropped command buffer. Built async,
   * a rejection arrives here, with the compiler's messages.
   */
  public createInspectPipelines(): Promise<InspectPipelines> {
    const n = this.layerCount;
    return Promise.all([
      this.fullscreenPipeline('tracer view', this.tracerViewBGL, this.canvasSource(emitTracerViewWgsl(n)), this.format),
      this.fullscreenPipeline('display', this.displayBGL, this.canvasSource(displayTextureFragmentSource), this.format),
      this.fullscreenPipeline('heatmap', this.heatmapBGL, this.canvasSource(emitCoincidenceHeatmapWgsl(n)), this.format),
      this.fullscreenPipeline('compare', this.compareBGL, this.canvasSource(emitCompareWgsl(n)), this.format),
      this.fullscreenPipeline(
        'stamp diagnostics',
        this.stampDiagnosticViewBGL,
        this.canvasSource(stampDiagnosticViewFragmentSource),
        this.format,
      ),
    ]).then(([tracerView, display, heatmap, compare, stampDiagnosticView]) => ({
      tracerView, display, heatmap, compare, stampDiagnosticView,
    }));
  }

  /** The collision-stats blit: an 8-bit offscreen target, whatever the canvas presents. */
  public createPersistDiagnosticBlitPipeline(): Promise<GPURenderPipeline> {
    return this.fullscreenPipeline(
      'collision-stats blit',
      this.persistDiagnosticBlitBGL,
      persistDiagnosticBlitFragmentSource,
      'rgba8unorm',
    );
  }

  /**
   * A fullscreen-triangle pass running `fragment` into `format`. The device
   * call is made synchronously (before the first `await`), so a recording
   * device sees every pipeline from a synchronous caller.
   */
  private async fullscreenPipeline(
    label: string,
    layout: GPUBindGroupLayout,
    fragment: string,
    format: GPUTextureFormat,
  ): Promise<GPURenderPipeline> {
    const device = this.device;
    const modules = [
      device.createShaderModule({ code: fullscreenVertexSource }),
      device.createShaderModule({ code: fragment }),
    ];
    try {
      return await device.createRenderPipelineAsync({
        label,
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        vertex: { module: modules[0], entryPoint: 'main' },
        fragment: { module: modules[1], entryPoint: 'main', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
        multisample: { count: 1 },
      });
    } catch (error) {
      throw new PipelineCompileError(label, await compilationMessages(modules, error));
    }
  }
}

/** What `createInspectPipelines` resolves to: one pipeline per inspect pass. */
export interface InspectPipelines {
  tracerView: GPURenderPipeline;
  display: GPURenderPipeline;
  heatmap: GPURenderPipeline;
  compare: GPURenderPipeline;
  stampDiagnosticView: GPURenderPipeline;
}

/** A pipeline the device refused, carrying the shader compiler's messages. */
export class PipelineCompileError extends Error {
  override readonly name = 'PipelineCompileError';
  readonly label: string;
  readonly messages: string;

  constructor(label: string, messages: string) {
    super(`[WebGPU:${label}] ${messages}`);
    this.label = label;
    this.messages = messages;
  }
}

/**
 * The compiler's error messages for `modules` (`line:column message`, one per
 * line), or the pipeline error's own message when the shaders compiled and it
 * was the pipeline that failed (a layout mismatch, say).
 */
async function compilationMessages(modules: readonly GPUShaderModule[], error: unknown): Promise<string> {
  const lines: string[] = [];
  for (const module of modules) {
    const info = await module.getCompilationInfo().catch(() => null);
    for (const message of info?.messages ?? []) {
      if (message.type === 'error') lines.push(`${message.lineNum}:${message.linePos} ${message.message}`);
    }
  }
  if (lines.length > 0) return lines.join('\n');
  return error instanceof Error ? error.message : String(error);
}
