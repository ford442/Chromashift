import { fullscreenVertexSource } from '../../shaders';
import type { LayerPipeline, WebGPUPipelines } from '../../WebGPUPipelines';
import { compositorUniformBytes } from '../templates/wgsl';
import type { EmittedPass, NodeKind } from '../types';

/** Pipeline + bind-group layout + uniform storage for one graph node. */
export interface NodePipeline {
  readonly kind: NodeKind;
  readonly pipeline: GPURenderPipeline;
  readonly bindGroupLayout: GPUBindGroupLayout;
  /** Single uniform block for every kind but `band-layer` (which has two). */
  readonly uniformBuffer: GPUBuffer | null;
  readonly uniformData: ArrayBuffer | null;
  /** `band-layer` reuses the shipped layer pipeline, buffers and all. */
  readonly layer: LayerPipeline | null;
  /** Cached views so a bind group is only rebuilt when a texture changes. */
  bindGroup: GPUBindGroup | null;
  bindGroupKey: string;
}

export interface NodePipelineContext {
  readonly device: GPUDevice;
  readonly pipelines: WebGPUPipelines;
  readonly internalFormat: GPUTextureFormat;
  readonly outputFormat: GPUTextureFormat;
  readonly sampleCount: number;
  readonly layerCount: number;
}

/** Uniform block size, in bytes, for one node kind. */
export function uniformBytes(kind: NodeKind, layerCount: number): number {
  switch (kind) {
    case 'coincidence':
    case 'decay':
      return 32;
    case 'blend':
      return compositorUniformBytes(layerCount);
    case 'warp':
    case 'blur':
    case 'lut':
      return 16;
    default:
      return 0;
  }
}

const sampler = (binding: number): GPUBindGroupLayoutEntry => ({
  binding,
  visibility: GPUShaderStage.FRAGMENT,
  sampler: { type: 'filtering' },
});
const texture = (binding: number): GPUBindGroupLayoutEntry => ({
  binding,
  visibility: GPUShaderStage.FRAGMENT,
  texture: { sampleType: 'float' },
});
const uniform = (binding: number): GPUBindGroupLayoutEntry => ({
  binding,
  visibility: GPUShaderStage.FRAGMENT,
  buffer: { type: 'uniform' },
});

/**
 * Bind-group layout for one emitted pass.
 *
 * The bindings are not guessed: `templates/wgsl.ts` lays every kind out as
 * `0 = sampler, 1..n = textures, n+1.. = uniforms`, and the emitter reports the
 * texture names in binding order as `EmittedPass.textureBindings`. So the
 * layout is derived from the shader the compiler produced, which is what makes
 * "a new node kind needs no renderer edit" true rather than aspirational.
 */
export function bindGroupLayoutEntries(emitted: EmittedPass, layerCount: number): GPUBindGroupLayoutEntry[] {
  const textures = textureBindingCount(emitted, layerCount);
  const entries: GPUBindGroupLayoutEntry[] = [sampler(0)];
  for (let i = 0; i < textures; i += 1) entries.push(texture(i + 1));
  entries.push(uniform(textures + 1));
  return entries;
}

/**
 * How many textures the emitted pass binds.
 *
 * `decay` is the one kind whose binding count is not its input count: it binds
 * the fused stamp's `layerCount` inputs plus its own previous-frame texture.
 */
export function textureBindingCount(emitted: EmittedPass, layerCount: number): number {
  switch (emitted.kind) {
    case 'coincidence':
    case 'decay':
      return layerCount + 1;
    case 'blend':
      return layerCount + 2;
    default:
      return emitted.textureBindings.length;
  }
}

/** Colour-attachment formats one emitted pass writes, in `@location` order. */
export function targetFormats(
  kind: NodeKind,
  internalFormat: GPUTextureFormat,
  outputFormat: GPUTextureFormat,
): GPUTextureFormat[] {
  switch (kind) {
    // The fused coincidence/decay shader always writes the stamp-diagnostic
    // side channel at @location(1); it is not optional.
    case 'coincidence':
    case 'decay':
      return [internalFormat, 'rgba8unorm'];
    case 'blend':
      return [outputFormat];
    default:
      return [internalFormat];
  }
}

/** Create the pipeline for one emitted pass. */
export function createNodePipeline(
  ctx: NodePipelineContext,
  emitted: EmittedPass,
): NodePipeline {
  const base = { kind: emitted.kind, bindGroup: null, bindGroupKey: '' };

  if (emitted.kind === 'band-layer') {
    // Identical to the shipped layer pipeline — same layout, same MSAA count,
    // same two uniform buffers. The only thing the graph changes is which
    // fragment source goes in, and for the default graph that is the same text.
    const layer = ctx.pipelines.createLayerPipeline(emitted.fragment, ctx.sampleCount);
    return {
      ...base,
      pipeline: layer.pipeline,
      bindGroupLayout: layer.bindGroupLayout,
      uniformBuffer: null,
      uniformData: null,
      layer,
    };
  }

  const bindGroupLayout = ctx.device.createBindGroupLayout({
    entries: bindGroupLayoutEntries(emitted, ctx.layerCount),
  });

  const pipeline = ctx.device.createRenderPipeline({
    layout: ctx.device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    vertex: {
      module: ctx.device.createShaderModule({ code: fullscreenVertexSource }),
      entryPoint: 'main',
    },
    fragment: {
      module: ctx.device.createShaderModule({ code: emitted.fragment }),
      entryPoint: 'main',
      targets: targetFormats(emitted.kind, ctx.internalFormat, ctx.outputFormat)
        .map((format) => ({ format })),
    },
    primitive: { topology: 'triangle-list' },
    multisample: { count: 1 },
  });

  const bytes = uniformBytes(emitted.kind, ctx.layerCount);
  return {
    ...base,
    pipeline,
    bindGroupLayout,
    uniformBuffer: bytes > 0
      ? ctx.device.createBuffer({
        size: bytes,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      })
      : null,
    uniformData: bytes > 0 ? new ArrayBuffer(bytes) : null,
    layer: null,
  };
}

/** Release the GPU resources one node pipeline owns. */
export function destroyNodePipeline(node: NodePipeline): void {
  node.uniformBuffer?.destroy();
  node.layer?.rotationBuffer.destroy();
  node.layer?.fragUniformBuffer.destroy();
}
