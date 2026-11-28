import { fullscreenVertexSource, vertexShaderSource } from '../../shaders';
import { layoutFromReflection } from '../../shaders/bindingReflection';
import { BAND_LAYER_UNIFORMS, emitHistoryWriteWgsl } from '../templates/wgsl';
import { HDR_CANVAS_FORMAT, type CanvasPresentation } from '../../gpu/gpuOptions';
import { PARTICLE_ATTRIBUTES } from '../templates/particles';
import { createUniformData, type UniformData, type UniformLayout } from '../templates/uniformLayout';
import { PARTICLE_STRIDE } from '../nodeKinds';
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
  /** The render pipeline; `null` for a compute node. */
  readonly pipeline: GPURenderPipeline | null;
  /** A compute node's kernels, one per entry point in dispatch order; empty for a render node. */
  readonly computePipelines: readonly GPUComputePipeline[];
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
  readonly pipeline: GPURenderPipeline | null;
  readonly computePipelines: readonly GPUComputePipeline[];
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
}

/**
 * The uniform layout one emitted pass is packed with: the one its shader's
 * struct was emitted from, carried on the pass by the compiler.
 */
function uniformLayoutFor(emitted: EmittedPass): UniformLayout | null {
  return emitted.uniformLayout;
}

/** The vertex stage a pass runs: its own (`splat`), the rotating layer quad, or the fullscreen triangle. */
function vertexSourceFor(emitted: EmittedPass): string {
  if (emitted.vertex !== undefined) return emitted.vertex;
  return emitted.kind === 'band-layer' ? vertexShaderSource : fullscreenVertexSource;
}

/** True when an emitted pass has a program to build: a fragment shader or compute kernels. */
export function emittedHasProgram(emitted: EmittedPass): boolean {
  return emitted.fragment !== '' || emitted.compute !== undefined;
}

/**
 * Bind-group layout for one emitted pass, read off the shaders it runs.
 *
 * Not a convention and not a table: every binding the vertex and fragment
 * modules declare becomes an entry of the type they declare it as
 * (`shaders/bindingReflection.ts`). So whatever the compiler emits — a node
 * kind added later, a graph from the editor, a `decay` whose `prevTex` moved
 * with the layer count — gets the layout its shader needs, and the band layer
 * (rotation uniform in the vertex stage, a `uint` mask, the profile LUT) is no
 * longer a hand-written exception.
 */
export function nodeLayoutEntries(emitted: EmittedPass): GPUBindGroupLayoutEntry[] {
  if (emitted.compute) {
    return layoutFromReflection([{ code: emitted.compute.module, visibility: GPUShaderStage.COMPUTE }]);
  }
  return layoutFromReflection([
    { code: vertexSourceFor(emitted), visibility: GPUShaderStage.VERTEX },
    { code: emitted.fragment, visibility: GPUShaderStage.FRAGMENT },
  ]);
}

/**
 * Colour-attachment formats one emitted pass writes, in `@location` order.
 * `outputFormat` is the SDR canvas format; a pass presenting `hdr-extended`
 * targets the float canvas instead.
 */
function targetFormats(
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

/** Compile one emitted pass's program. */
export function createNodeProgram(ctx: NodeProgramContext, emitted: EmittedPass): NodeProgram {
  const bindGroupLayout = ctx.device.createBindGroupLayout({ entries: nodeLayoutEntries(emitted) });
  if (emitted.compute) {
    // One module, one layout, one pipeline per kernel: every kernel of a node
    // binds the same group, so one bind group serves all its dispatches.
    const layout = ctx.device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
    const module = ctx.device.createShaderModule({ code: emitted.compute.module });
    return {
      kind: emitted.kind,
      pipeline: null,
      computePipelines: emitted.compute.entryPoints.map((entryPoint) =>
        ctx.device.createComputePipeline({ layout, compute: { module, entryPoint } })),
      bindGroupLayout,
      ringWrite: null,
    };
  }
  if (emitted.kind === 'splat') {
    return {
      kind: emitted.kind,
      pipeline: createSplatPipeline(ctx, bindGroupLayout, emitted),
      computePipelines: [],
      bindGroupLayout,
      ringWrite: null,
    };
  }
  if (emitted.kind === 'band-layer') {
    // The shipped layer pipeline: the rotating vertex stage, MSAA at the
    // session's sample count. Only the fragment source is the graph's, and for
    // the default graph that is the same text.
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
    return { kind: emitted.kind, pipeline, computePipelines: [], bindGroupLayout, ringWrite: null };
  }

  const pipeline = fullscreenPipeline(
    ctx.device,
    bindGroupLayout,
    emitted.fragment,
    targetFormats(emitted.kind, ctx.internalFormat, ctx.outputFormat, emitted.presentation),
  );
  return {
    kind: emitted.kind,
    pipeline,
    computePipelines: [],
    bindGroupLayout,
    ringWrite: emitted.kind === 'history' && !emitted.historyLoop ? createRingWriteProgram(ctx) : null,
  };
}

/**
 * `splat`: the particles as instance-stepped vertex attributes (no storage
 * binding in a render stage), six vertices each, blended additively into the
 * tracer-resolution target.
 */
function createSplatPipeline(
  ctx: NodeProgramContext,
  bindGroupLayout: GPUBindGroupLayout,
  emitted: EmittedPass,
): GPURenderPipeline {
  const additive: GPUBlendComponent = { srcFactor: 'one', dstFactor: 'one', operation: 'add' };
  return ctx.device.createRenderPipeline({
    layout: ctx.device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    vertex: {
      module: ctx.device.createShaderModule({ code: emitted.vertex! }),
      entryPoint: 'main',
      buffers: [{
        arrayStride: PARTICLE_STRIDE,
        stepMode: 'instance',
        attributes: [
          { shaderLocation: 0, offset: PARTICLE_ATTRIBUTES.pos, format: 'float32x2' },
          { shaderLocation: 1, offset: PARTICLE_ATTRIBUTES.color, format: 'unorm8x4' },
          { shaderLocation: 2, offset: PARTICLE_ATTRIBUTES.age, format: 'float32' },
          { shaderLocation: 3, offset: PARTICLE_ATTRIBUTES.life, format: 'float32' },
        ],
      }],
    },
    fragment: {
      module: ctx.device.createShaderModule({ code: emitted.fragment }),
      entryPoint: 'main',
      targets: [{ format: ctx.internalFormat, blend: { color: additive, alpha: additive } }],
    },
    primitive: { topology: 'triangle-list' },
    multisample: { count: 1 },
  });
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
    computePipelines: program.computePipelines,
    bindGroupLayout: program.bindGroupLayout,
    bindGroup: null,
    bindGroupKey: '',
  };
  // Labelled by node, so a device error names the pass it came from.
  const uniformBuffer = (size: number, label = `${emitted.nodeId}:uniforms`) => device.createBuffer({
    label,
    size,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  if (program.kind === 'band-layer') {
    return {
      ...base,
      uniformBuffer: null,
      uniforms: null,
      layer: {
        rotationBuffer: uniformBuffer(16, `${emitted.nodeId}:rotation`),
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
  const fragment = emitHistoryWriteWgsl();
  const bindGroupLayout = ctx.device.createBindGroupLayout({
    entries: layoutFromReflection([
      { code: fullscreenVertexSource, visibility: GPUShaderStage.VERTEX },
      { code: fragment, visibility: GPUShaderStage.FRAGMENT },
    ]),
  });
  return {
    pipeline: fullscreenPipeline(ctx.device, bindGroupLayout, fragment, [ctx.internalFormat]),
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
