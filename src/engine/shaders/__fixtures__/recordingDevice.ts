/**
 * A `GPUDevice` that records every pipeline it is asked to build — the layout
 * it was given and the shader modules of each stage — and nothing else.
 *
 * `shaderBindings.test.ts` drives every pipeline builder in the app against
 * it, so the shader ↔ layout check covers whatever pipelines exist rather than
 * a list of pairs someone remembered to write down.
 */

import { installWebGpuConstants } from '../../graph/exec/__fixtures__/fakeDevice';

export interface RecordedStage {
  stage: 'vertex' | 'fragment' | 'compute';
  code: string;
  entryPoint: string;
}

export interface RecordedPipeline {
  /** Where it came from, set by the driver with `recorder.context = …`. */
  context: string;
  stages: RecordedStage[];
  /** One descriptor per bind group, in group order. */
  layouts: GPUBindGroupLayoutDescriptor[];
}

export interface PipelineRecorder {
  device: GPUDevice;
  pipelines: RecordedPipeline[];
  context: string;
}

const codeOf = (module: GPUShaderModule): string => (module as unknown as { __code: string }).__code;

export function createPipelineRecorder(): PipelineRecorder {
  installWebGpuConstants();
  const g = globalThis as Record<string, unknown>;
  g.GPUBufferUsage = { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 };
  g.GPUMapMode ??= { READ: 1, WRITE: 2 };

  const recorder: PipelineRecorder = { device: null as unknown as GPUDevice, pipelines: [], context: '' };

  const layoutsOf = (layout: GPUPipelineLayout | 'auto'): GPUBindGroupLayoutDescriptor[] => {
    if (layout === 'auto') throw new Error(`${recorder.context}: layout 'auto' — every pipeline must name its layout`);
    return (layout as unknown as { __layouts: GPUBindGroupLayout[] }).__layouts
      .map((bgl) => (bgl as unknown as { __descriptor: GPUBindGroupLayoutDescriptor }).__descriptor);
  };

  const texture = (descriptor: GPUTextureDescriptor) => {
    const size = descriptor.size as number[];
    return {
      width: size[0],
      height: size[1] ?? 1,
      format: descriptor.format,
      createView: () => ({}),
      destroy: () => {},
    };
  };

  const buffer = (descriptor: GPUBufferDescriptor) => ({
    size: descriptor.size,
    destroy: () => {},
    mapAsync: () => Promise.resolve(),
    getMappedRange: () => new ArrayBuffer(descriptor.size),
    unmap: () => {},
  });

  recorder.device = {
    features: new Set(['texture-formats-tier1', 'timestamp-query', 'rg11b10ufloat-renderable']),
    limits: {
      maxTextureDimension2D: 8192,
      maxComputeWorkgroupSizeX: 256,
      maxComputeWorkgroupSizeY: 256,
      maxComputeInvocationsPerWorkgroup: 256,
      maxStorageBufferBindingSize: 1 << 27,
    },
    createShaderModule: (descriptor: GPUShaderModuleDescriptor) => ({ __code: descriptor.code }),
    createBindGroupLayout: (descriptor: GPUBindGroupLayoutDescriptor) => ({ __descriptor: descriptor }),
    createPipelineLayout: (descriptor: GPUPipelineLayoutDescriptor) => ({ __layouts: [...descriptor.bindGroupLayouts] }),
    createRenderPipeline(descriptor: GPURenderPipelineDescriptor) {
      const stages: RecordedStage[] = [{
        stage: 'vertex',
        code: codeOf(descriptor.vertex.module),
        entryPoint: descriptor.vertex.entryPoint ?? 'main',
      }];
      if (descriptor.fragment) {
        stages.push({
          stage: 'fragment',
          code: codeOf(descriptor.fragment.module),
          entryPoint: descriptor.fragment.entryPoint ?? 'main',
        });
      }
      recorder.pipelines.push({ context: recorder.context, stages, layouts: layoutsOf(descriptor.layout) });
      return {};
    },
    createComputePipeline(descriptor: GPUComputePipelineDescriptor) {
      recorder.pipelines.push({
        context: recorder.context,
        stages: [{
          stage: 'compute',
          code: codeOf(descriptor.compute.module),
          entryPoint: descriptor.compute.entryPoint ?? 'main',
        }],
        layouts: layoutsOf(descriptor.layout),
      });
      return {};
    },
    createTexture: texture,
    createBuffer: buffer,
    createSampler: () => ({}),
    createBindGroup: () => ({}),
    createQuerySet: () => ({ destroy: () => {} }),
    createCommandEncoder: () => ({}),
    pushErrorScope: () => {},
    popErrorScope: () => Promise.resolve(null),
    queue: { writeBuffer: () => {}, writeTexture: () => {}, submit: () => {} },
  } as unknown as GPUDevice;

  return recorder;
}
