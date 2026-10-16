import { fullscreenVertexSource } from '../../shaders';
import type { LayerPipeline, WebGPUPipelines } from '../../WebGPUPipelines';
import { emitHistoryWriteWgsl } from '../templates/wgsl';
import { HDR_CANVAS_FORMAT, type CanvasPresentation } from '../../gpuOptions';
import { createUniformData, type UniformData, type UniformLayout } from '../templates/uniformLayout';
import type { EmittedPass, NodeKind } from '../types';

/** Pipeline + bind-group layout + uniform storage for one graph node. */
export interface NodePipeline {
  readonly kind: NodeKind;
  readonly pipeline: GPURenderPipeline;
  readonly bindGroupLayout: GPUBindGroupLayout;
  /** Single uniform block for every kind but `band-layer` (which has two). */
  readonly uniformBuffer: GPUBuffer | null;
  /** CPU side of `uniformBuffer`, laid out by {@link uniformLayoutFor}. */
  readonly uniforms: UniformData | null;
  /** `band-layer` reuses the shipped layer pipeline, buffers and all. */
  readonly layer: LayerPipeline | null;
  /** `history` only: the blit that writes this frame's input into the ring. */
  readonly ringWrite: RingWritePipeline | null;
  /** Cached views so a bind group is only rebuilt when a texture changes. */
  bindGroup: GPUBindGroup | null;
  bindGroupKey: string;
}

/** The write half of a `history` node: one texture in, the ring slot out. */
export interface RingWritePipeline {
  readonly pipeline: GPURenderPipeline;
  readonly bindGroupLayout: GPUBindGroupLayout;
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

/**
 * The uniform layout one emitted pass is packed with: the one its shader's
 * struct was emitted from, carried on the pass by the compiler.
 */
export function uniformLayoutFor(emitted: EmittedPass): UniformLayout | null {
  return emitted.uniformLayout;
}

/** Uniform block size, in bytes, for one emitted pass. */
export function uniformBytes(emitted: EmittedPass): number {
  return emitted.uniformLayout?.bytes ?? 0;
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
 * Not the input count: a `decay` binds the fused stamp's `layerCount` inputs
 * plus its own previous-frame texture (and the motion field, if it carries the
 * temporal term).
 */
export function textureBindingCount(emitted: EmittedPass, layerCount: number): number {
  switch (emitted.kind) {
    case 'coincidence':
      return layerCount + 1;
    case 'blend':
      return layerCount + 2;
    default:
      // `decay` binds its stamp's layers, its previous frame and — in the
      // motion variant — the field, which is exactly what it reports.
      return emitted.textureBindings.length;
  }
}

/**
 * Colour-attachment formats one emitted pass writes, in `@location` order.
 * `outputFormat` is the SDR canvas format; a pass presenting `hdr-extended`
 * targets the float canvas instead.
 */
export function targetFormats(
  kind: NodeKind,
  internalFormat: GPUTextureFormat,
  outputFormat: GPUTextureFormat,
  presentation?: CanvasPresentation,
): GPUTextureFormat[] {
  switch (kind) {
    // The fused coincidence/decay shader always writes the stamp-diagnostic
    // side channel at @location(1); it is not optional.
    case 'coincidence':
    case 'decay':
      return [internalFormat, 'rgba8unorm'];
    case 'blend':
      return [presentation === 'hdr-extended' ? HDR_CANVAS_FORMAT : outputFormat];
    default:
      return [internalFormat];
  }
}

/** Create the pipeline for one emitted pass. */
export function createNodePipeline(
  ctx: NodePipelineContext,
  emitted: EmittedPass,
): NodePipeline {
  const base = { kind: emitted.kind, bindGroup: null, bindGroupKey: '', ringWrite: null };

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
      uniforms: null,
      layer,
    };
  }

  const bindGroupLayout = ctx.device.createBindGroupLayout({
    entries: bindGroupLayoutEntries(emitted, ctx.layerCount),
  });

  const pipeline = fullscreenPipeline(
    ctx.device,
    bindGroupLayout,
    emitted.fragment,
    targetFormats(emitted.kind, ctx.internalFormat, ctx.outputFormat, emitted.presentation),
  );

  const layout = uniformLayoutFor(emitted);
  return {
    ...base,
    pipeline,
    bindGroupLayout,
    uniformBuffer: layout
      ? ctx.device.createBuffer({
        size: layout.bytes,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      })
      : null,
    uniforms: layout ? createUniformData(layout) : null,
    layer: null,
    ringWrite: emitted.kind === 'history' ? createRingWritePipeline(ctx) : null,
  };
}

function createRingWritePipeline(ctx: NodePipelineContext): RingWritePipeline {
  const bindGroupLayout = ctx.device.createBindGroupLayout({ entries: [sampler(0), texture(1)] });
  return {
    pipeline: fullscreenPipeline(
      ctx.device,
      bindGroupLayout,
      emitHistoryWriteWgsl(),
      [ctx.internalFormat],
    ),
    bindGroupLayout,
    bindGroup: null,
    bindGroupKey: '',
  };
}

function fullscreenPipeline(
  device: GPUDevice,
  bindGroupLayout: GPUBindGroupLayout,
  fragment: string,
  formats: GPUTextureFormat[],
): GPURenderPipeline {
  return device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    vertex: {
      module: device.createShaderModule({ code: fullscreenVertexSource }),
      entryPoint: 'main',
    },
    fragment: {
      module: device.createShaderModule({ code: fragment }),
      entryPoint: 'main',
      targets: formats.map((format) => ({ format })),
    },
    primitive: { topology: 'triangle-list' },
    multisample: { count: 1 },
  });
}

/** Release the GPU resources one node pipeline owns. */
export function destroyNodePipeline(node: NodePipeline): void {
  node.uniformBuffer?.destroy();
  node.layer?.rotationBuffer.destroy();
  node.layer?.fragUniformBuffer.destroy();
}
