import {
  vertexShaderSource,
  fullscreenVertexSource,
  persistenceFragmentSource,
  compositorFragmentSource,
  tracerViewFragmentSource,
  displayTextureFragmentSource,
  coincidenceHeatmapFragmentSource,
  compareFragmentSource,
  persistDiagnosticBlitFragmentSource,
  stampDiagnosticViewFragmentSource,
} from './shaders';

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

  public persistBGL: GPUBindGroupLayout;
  public compositorBGL: GPUBindGroupLayout;
  public tracerViewBGL: GPUBindGroupLayout;
  public displayBGL: GPUBindGroupLayout;
  public heatmapBGL: GPUBindGroupLayout;
  public compareBGL: GPUBindGroupLayout;
  public persistDiagnosticBlitBGL: GPUBindGroupLayout;
  public stampDiagnosticViewBGL: GPUBindGroupLayout;

  constructor(device: GPUDevice, format: GPUTextureFormat, internalFormat: GPUTextureFormat) {
    this.device = device;
    this.format = format;
    this.internalFormat = internalFormat;

    this.persistBGL = this.createPersistBGL();
    this.compositorBGL = this.createCompositorBGL();
    this.tracerViewBGL = this.createTracerViewBGL();
    this.displayBGL = this.createDisplayBGL();
    this.heatmapBGL = this.createHeatmapBGL();
    this.compareBGL = this.createCompareBGL();
    this.persistDiagnosticBlitBGL = this.createPersistDiagnosticBlitBGL();
    this.stampDiagnosticViewBGL = this.createStampDiagnosticViewBGL();
  }

  public createPersistBGL(): GPUBindGroupLayout {

    return this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
  }

  public createCompositorBGL(): GPUBindGroupLayout {

    return this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }, // NEW: persistAbove
        { binding: 6, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },      // MOVED to 6
      ],
    });
  }

  public createTracerViewBGL(): GPUBindGroupLayout {

    return this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }, // persistAbove
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }, // persistBelow
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }, // layer0
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }, // layer1
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }, // layer2
        { binding: 6, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
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

    return this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
  }

  public createCompareBGL(): GPUBindGroupLayout {

    return this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 7, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
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
