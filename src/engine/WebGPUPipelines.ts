import {
  vertexShaderSource,
  fullscreenVertexSource,
  persistenceFragmentSource,
  persistenceMotionFragmentSource,
  persistenceCompositeFragmentSource,
  persistenceCompositeMotionFragmentSource,
  compositorFragmentSource,
  tracerViewFragmentSource,
  displayTextureFragmentSource,
  coincidenceHeatmapFragmentSource,
  compareFragmentSource,
  persistDiagnosticBlitFragmentSource,
  stampDiagnosticViewFragmentSource,
} from './shaders';
import { DEFAULT_LAYER_COUNT, assertLayerCount } from './graph';

/**
 * `GPUShaderStage` is a runtime global, not a type — reading it at module scope
 * would make importing this file throw wherever WebGPU is absent (Node, the
 * WebGL-only path), so every use goes through this.
 */
const fragmentStage = (): number => GPUShaderStage.FRAGMENT;

/** `n` consecutive sampled-texture entries starting at `first`. */
function textureEntries(first: number, count: number): GPUBindGroupLayoutEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    binding: first + i,
    visibility: fragmentStage(),
    texture: { sampleType: 'float' as const },
  }));
}

export interface LayerPipeline {
  pipeline          : GPURenderPipeline;
  bindGroupLayout   : GPUBindGroupLayout;
  rotationBuffer    : GPUBuffer;
  fragUniformBuffer : GPUBuffer;
  rotationData      : Float32Array;
  fragData          : Float32Array;
}

export class WebGPUPipelines {
  public device: GPUDevice;
  public format: GPUTextureFormat;
  public internalFormat: GPUTextureFormat;

  /**
   * How many band-layer textures every layout below is sized for.
   *
   * The persist, compositor and tracer-view passes each bind one texture per
   * layer, so their binding numbers shift with the count — which is why they
   * are generated here rather than written out. The emitted WGSL uses the same
   * arithmetic (`emitCoincidenceDecayWgsl`, `emitCompositorWgsl`), so a layout
   * and its shader can never disagree about where `prevTex` lives.
   */
  public readonly layerCount: number;

  public persistBGL: GPUBindGroupLayout;
  public persistMotionBGL: GPUBindGroupLayout;
  public persistCompositeBGL: GPUBindGroupLayout;
  public persistCompositeMotionBGL: GPUBindGroupLayout;
  public compositorBGL: GPUBindGroupLayout;
  public tracerViewBGL: GPUBindGroupLayout;
  public displayBGL: GPUBindGroupLayout;
  public heatmapBGL: GPUBindGroupLayout;
  public compareBGL: GPUBindGroupLayout;
  public persistDiagnosticBlitBGL: GPUBindGroupLayout;
  public stampDiagnosticViewBGL: GPUBindGroupLayout;

  constructor(
    device: GPUDevice,
    format: GPUTextureFormat,
    internalFormat: GPUTextureFormat,
    layerCount: number = DEFAULT_LAYER_COUNT,
  ) {
    this.device = device;
    this.format = format;
    this.internalFormat = internalFormat;
    this.layerCount = assertLayerCount(layerCount);

    this.persistBGL = this.createPersistBGL();
    this.persistMotionBGL = this.createPersistMotionBGL();
    this.persistCompositeBGL = this.createPersistCompositeBGL();
    this.persistCompositeMotionBGL = this.createPersistCompositeMotionBGL();
    this.compositorBGL = this.createCompositorBGL();
    this.tracerViewBGL = this.createTracerViewBGL();
    this.displayBGL = this.createDisplayBGL();
    this.heatmapBGL = this.createHeatmapBGL();
    this.compareBGL = this.createCompareBGL();
    this.persistDiagnosticBlitBGL = this.createPersistDiagnosticBlitBGL();
    this.stampDiagnosticViewBGL = this.createStampDiagnosticViewBGL();
  }

  public createPersistBGL(): GPUBindGroupLayout {
    // 0 = sampler, 1..n = layers, n+1 = previous frame, n+2 = uniforms — the
    // binding numbers `emitCoincidenceDecayWgsl(n)` emits.
    const n = this.layerCount;
    return this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: fragmentStage(), sampler: { type: 'filtering' } },
        ...textureEntries(1, n + 1),
        { binding: n + 2, visibility: fragmentStage(), buffer: { type: 'uniform' } },
      ],
    });
  }

  /**
   * The fused persistence pass plus the motion field at binding 6.
   *
   * A second layout (rather than an optional entry) is what lets
   * `motionMode: 'off'` bind the original layout and the original program,
   * with no motion texture in the frame at all.
   */
  public createPersistMotionBGL(): GPUBindGroupLayout {
    const n = this.layerCount;
    return this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: fragmentStage(), sampler: { type: 'filtering' } },
        ...textureEntries(1, n + 1),
        { binding: n + 2, visibility: fragmentStage(), buffer: { type: 'uniform' } },
        { binding: n + 3, visibility: fragmentStage(), texture: { sampleType: 'float' } },
      ],
    });
  }

  /** Lighter compute-fed composite pass — no sampler, exact-resolution `textureLoad` reads. */
  public createPersistCompositeBGL(): GPUBindGroupLayout {

    return this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
  }

  /** Compute-fed composite pass plus a sampled (quarter-resolution) motion field. */
  public createPersistCompositeMotionBGL(): GPUBindGroupLayout {

    return this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });
  }

  public createCompositorBGL(): GPUBindGroupLayout {
    // 0 = sampler, 1..n = layers, n+1 = tracer below, n+2 = tracer above,
    // n+3 = uniforms — matching `emitCompositorWgsl(n)`.
    const n = this.layerCount;
    return this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: fragmentStage(), sampler: { type: 'filtering' } },
        ...textureEntries(1, n + 2),
        { binding: n + 3, visibility: fragmentStage(), buffer: { type: 'uniform' } },
      ],
    });
  }

  public createTracerViewBGL(): GPUBindGroupLayout {
    // 0 = sampler, 1 = tracer above, 2 = tracer below, 3..n+2 = layers,
    // n+3 = uniforms.
    const n = this.layerCount;
    return this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: fragmentStage(), sampler: { type: 'filtering' } },
        ...textureEntries(1, n + 2),
        { binding: n + 3, visibility: fragmentStage(), buffer: { type: 'uniform' } },
      ],
    });
  }

  public createDisplayBGL(): GPUBindGroupLayout {

    return this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
  }

  public createHeatmapBGL(): GPUBindGroupLayout {
    // 0 = sampler, 1..n = layers, n+1 = uniforms.
    const n = this.layerCount;
    return this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: fragmentStage(), sampler: { type: 'filtering' } },
        ...textureEntries(1, n),
        { binding: n + 1, visibility: fragmentStage(), buffer: { type: 'uniform' } },
      ],
    });
  }

  public createCompareBGL(): GPUBindGroupLayout {
    // 0 = sampler, 1 = tracer below, 2 = tracer above, 3..n+2 = layers,
    // n+3 = second composite, n+4 = uniforms.
    const n = this.layerCount;
    return this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: fragmentStage(), sampler: { type: 'filtering' } },
        ...textureEntries(1, n + 3),
        { binding: n + 4, visibility: fragmentStage(), buffer: { type: 'uniform' } },
      ],
    });
  }

  public createPersistDiagnosticBlitBGL(): GPUBindGroupLayout {

    return this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });
  }

  public createStampDiagnosticViewBGL(): GPUBindGroupLayout {

    return this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });
  }

  public createPersistPipeline(): GPURenderPipeline {

    const device = this.device;
    return device.createRenderPipeline({
      layout  : device.createPipelineLayout({ bindGroupLayouts: [this.persistBGL] }),
      vertex  : { module: device.createShaderModule({ code: fullscreenVertexSource }), entryPoint: 'main' },
      fragment: {
        module     : device.createShaderModule({ code: persistenceFragmentSource }),
        entryPoint : 'main',
        targets    : [
          { format: this.internalFormat },   // @location(0) persistence colour
          { format: 'rgba8unorm' },          // @location(1) diagnostic stamp info
        ],
      },
      primitive  : { topology: 'triangle-list' },
      multisample: { count: 1 },
    });
  }

  /** Motion-aware twin of {@link createPersistPipeline}. */
  public createPersistMotionPipeline(): GPURenderPipeline {

    const device = this.device;
    return device.createRenderPipeline({
      layout  : device.createPipelineLayout({ bindGroupLayouts: [this.persistMotionBGL] }),
      vertex  : { module: device.createShaderModule({ code: fullscreenVertexSource }), entryPoint: 'main' },
      fragment: {
        module     : device.createShaderModule({ code: persistenceMotionFragmentSource }),
        entryPoint : 'main',
        targets    : [
          { format: this.internalFormat },   // @location(0) persistence colour
          { format: 'rgba8unorm' },          // @location(1) diagnostic stamp info
        ],
      },
      primitive  : { topology: 'triangle-list' },
      multisample: { count: 1 },
    });
  }

  public createPersistCompositePipeline(): GPURenderPipeline {

    const device = this.device;
    return device.createRenderPipeline({
      layout  : device.createPipelineLayout({ bindGroupLayouts: [this.persistCompositeBGL] }),
      vertex  : { module: device.createShaderModule({ code: fullscreenVertexSource }), entryPoint: 'main' },
      fragment: {
        module     : device.createShaderModule({ code: persistenceCompositeFragmentSource }),
        entryPoint : 'main',
        targets    : [
          { format: this.internalFormat },   // @location(0) persistence colour
        ],
      },
      primitive  : { topology: 'triangle-list' },
      multisample: { count: 1 },
    });
  }

  /** Motion-aware twin of {@link createPersistCompositePipeline}. */
  public createPersistCompositeMotionPipeline(): GPURenderPipeline {

    const device = this.device;
    return device.createRenderPipeline({
      layout  : device.createPipelineLayout({ bindGroupLayouts: [this.persistCompositeMotionBGL] }),
      vertex  : { module: device.createShaderModule({ code: fullscreenVertexSource }), entryPoint: 'main' },
      fragment: {
        module     : device.createShaderModule({ code: persistenceCompositeMotionFragmentSource }),
        entryPoint : 'main',
        targets    : [
          { format: this.internalFormat },   // @location(0) persistence colour
        ],
      },
      primitive  : { topology: 'triangle-list' },
      multisample: { count: 1 },
    });
  }

  public createCompositorPipeline(): GPURenderPipeline {

    const device = this.device;
    return device.createRenderPipeline({
      layout  : device.createPipelineLayout({ bindGroupLayouts: [this.compositorBGL] }),
      vertex  : { module: device.createShaderModule({ code: fullscreenVertexSource }), entryPoint: 'main' },
      fragment: {
        module     : device.createShaderModule({ code: compositorFragmentSource }),
        entryPoint : 'main',
        targets    : [{ format: this.format }],
      },
      primitive  : { topology: 'triangle-list' },
      multisample: { count: 1 },
    });
  }

  public createTracerViewPipeline(): GPURenderPipeline {

    const device = this.device;
    return device.createRenderPipeline({
      layout  : device.createPipelineLayout({ bindGroupLayouts: [this.tracerViewBGL] }),
      vertex  : { module: device.createShaderModule({ code: fullscreenVertexSource }), entryPoint: 'main' },
      fragment: {
        module     : device.createShaderModule({ code: tracerViewFragmentSource }),
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
        module: this.device.createShaderModule({ code: displayTextureFragmentSource }),
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
        module: this.device.createShaderModule({ code: coincidenceHeatmapFragmentSource }),
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
        module: this.device.createShaderModule({ code: compareFragmentSource }),
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
        module: this.device.createShaderModule({ code: stampDiagnosticViewFragmentSource }),
        entryPoint: 'main',
        targets: [{ format: this.format }],
      },
      primitive: { topology: 'triangle-list' },
      multisample: { count: 1 },
    });
  }

  public createLayerPipeline(fragmentSource: string, sampleCount = 1): LayerPipeline {

    const device = this.device;

    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX,   buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'uint' } },
        // 256×3 colour-profile LUT (textureLoad only — never sampled/filtered).
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });

    const pipeline = device.createRenderPipeline({
      layout  : device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      vertex  : { module: device.createShaderModule({ code: vertexShaderSource }), entryPoint: 'main' },
      fragment: {
        module     : device.createShaderModule({ code: fragmentSource }),
        entryPoint : 'main',
        targets    : [{ format: this.internalFormat }],
      },
      primitive  : { topology: 'triangle-list' },
      multisample: { count: sampleCount },
    });

    const rotationBuffer = device.createBuffer({
      size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const fragUniformBuffer = device.createBuffer({
      size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    return { pipeline, bindGroupLayout, rotationBuffer, fragUniformBuffer, rotationData: new Float32Array(4), fragData: new Float32Array(8) };
  }

}
