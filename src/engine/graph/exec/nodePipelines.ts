import { fullscreenVertexSource, vertexShaderSource } from '../../shaders';
import { BAND_LAYER_UNIFORMS, emitHistoryWriteWgsl } from '../templates/wgsl';
import { HDR_CANVAS_FORMAT, type CanvasPresentation } from '../../gpuOptions';
import { createUniformData, type UniformData, type UniformLayout } from '../templates/uniformLayout';
import type { EmittedPass, NodeKind } from '../types';

/**
 * One node's compiled program: its pipeline and bind-group layout.
 *
 * Immutable, so every executor on a device can share it — the compare slots,
 * the stationary previews and the main canvas all draw the default graph, and
 * compiling its shaders once instead of once per renderer is most of what
 * opening a compare layout costs. See `programCache.ts`.
 */
export interface NodeProgram {
  readonly kind: NodeKind;
  readonly pipeline: GPURenderPipeline;
  readonly bindGroupLayout: GPUBindGroupLayout;
  /** `history` only: the blit that writes this frame's input into the ring. */
  readonly ringWrite: { readonly pipeline: GPURenderPipeline; readonly bindGroupLayout: GPUBindGroupLayout } | null;
}

/** A band layer's two uniform blocks: the vertex rotation and `BAND_LAYER_UNIFORMS`. */
export interface BandLayerBuffers {
  readonly rotationBuffer: GPUBuffer;
  readonly fragUniformBuffer: GPUBuffer;
  readonly rotationData: Float32Array;
  readonly fragUniforms: UniformData;
}

/** One executor's instance of a node's program: its uniform storage and bind groups. */
export interface NodePipeline {
  readonly kind: NodeKind;
  readonly pipeline: GPURenderPipeline;
  readonly bindGroupLayout: GPUBindGroupLayout;
  /** Single uniform block for every kind but `band-layer` (which has two). */
  readonly uniformBuffer: GPUBuffer | null;
  /** CPU side of `uniformBuffer`, laid out by {@link uniformLayoutFor}. */
  readonly uniforms: UniformData | null;
  /** `band-layer` only: the shipped layer pass's two buffers. */
  readonly layer: BandLayerBuffers | null;
  /** `history` only: the ring-write blit and its bind group. */
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

export interface NodeProgramContext {
  readonly device: GPUDevice;
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
    default:
      // `decay` binds its stamp's layers, its previous frame and — in the
      // motion variant — the field; `blend` its layers and every tracer.
      // Each reports exactly that.
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

/**
 * The band-layer bind-group layout: the vertex rotation, the sampler and
 * source, the fragment uniforms, the classification mask and the profile LUT
 * — the layout the shipped layer pipeline has always used.
 */
function bandLayerLayoutEntries(): GPUBindGroupLayoutEntry[] {
  return [
    { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'uint' } },
    // 256×N colour-profile LUT (textureLoad only — never sampled/filtered).
    { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
  ];
}

/** Compile one emitted pass's program. */
export function createNodeProgram(ctx: NodeProgramContext, emitted: EmittedPass): NodeProgram {
  if (emitted.kind === 'band-layer') {
    // The shipped layer pipeline: the rotating vertex stage, the same layout,
    // MSAA at the session's sample count. Only the fragment source is the
    // graph's, and for the default graph that is the same text.
    const bindGroupLayout = ctx.device.createBindGroupLayout({ entries: bandLayerLayoutEntries() });
    const pipeline = ctx.device.createRenderPipeline({
      layout: ctx.device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      vertex: { module: ctx.device.createShaderModule({ code: vertexShaderSource }), entryPoint: 'main' },
      fragment: {
        module: ctx.device.createShaderModule({ code: emitted.fragment }),
        entryPoint: 'main',
        targets: [{ format: ctx.internalFormat }],
      },
      primitive: { topology: 'triangle-list' },
      multisample: { count: ctx.sampleCount },
    });
    return { kind: emitted.kind, pipeline, bindGroupLayout, ringWrite: null };
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
  return {
    kind: emitted.kind,
    pipeline,
    bindGroupLayout,
    ringWrite: emitted.kind === 'history' ? createRingWriteProgram(ctx) : null,
  };
}

/** One executor's buffers and bind-group slots for a program. */
export function instantiateNodePipeline(
  device: GPUDevice,
  emitted: EmittedPass,
  program: NodeProgram,
): NodePipeline {
  const base = {
    kind: program.kind,
    pipeline: program.pipeline,
    bindGroupLayout: program.bindGroupLayout,
    bindGroup: null,
    bindGroupKey: '',
  };
  const uniformBuffer = (size: number) => device.createBuffer({
    size,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  if (program.kind === 'band-layer') {
    return {
      ...base,
      uniformBuffer: null,
      uniforms: null,
      layer: {
        rotationBuffer: uniformBuffer(16),
        fragUniformBuffer: uniformBuffer(BAND_LAYER_UNIFORMS.bytes),
        rotationData: new Float32Array(4),
        fragUniforms: createUniformData(BAND_LAYER_UNIFORMS),
      },
      ringWrite: null,
    };
  }

  const layout = uniformLayoutFor(emitted);
  return {
    ...base,
    uniformBuffer: layout ? uniformBuffer(layout.bytes) : null,
    uniforms: layout ? createUniformData(layout) : null,
    layer: null,
    ringWrite: program.ringWrite ? { ...program.ringWrite, bindGroup: null, bindGroupKey: '' } : null,
  };
}

function createRingWriteProgram(ctx: NodeProgramContext): NonNullable<NodeProgram['ringWrite']> {
  const bindGroupLayout = ctx.device.createBindGroupLayout({ entries: [sampler(0), texture(1)] });
  return {
    pipeline: fullscreenPipeline(ctx.device, bindGroupLayout, emitHistoryWriteWgsl(), [ctx.internalFormat]),
    bindGroupLayout,
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

/** Release the GPU resources one executor's instance owns. The program is shared and stays. */
export function destroyNodePipeline(node: NodePipeline): void {
  node.uniformBuffer?.destroy();
  node.layer?.rotationBuffer.destroy();
  node.layer?.fragUniformBuffer.destroy();
}
