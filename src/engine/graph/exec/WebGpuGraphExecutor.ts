import { durationToDecay } from '../../math/decay';
import { layerRotationUniforms } from '../../math/rotation';
import type { WebGPUPipelines } from '../../WebGPUPipelines';
import type { RendererState } from '../../types/RendererState';
import { compositorUniformLayout } from '../templates/wgsl';
import { buildEncodePlan, encodedPassOrder, type EncodePlan, type EncodeStep } from './plan';
import {
  createNodePipeline,
  destroyNodePipeline,
  type NodePipeline,
  type NodePipelineContext,
} from './nodePipelines';
import { GraphTexturePool, type PoolSizes } from './pool';
import type { CompiledGraph, EmittedPass } from '../types';

/** Externally supplied textures a `source` node and the band layers bind. */
export interface GraphExternalInputs {
  source: GPUTexture;
  /** Band classification mask, or the 1×1 fallback when none was computed. */
  classificationMask: GPUTexture;
  /**
   * False when `classificationMask` is the fallback. The band-layer shader's
   * `useMask` uniform must not claim a mask that does not exist, exactly as the
   * hand encoder's `classificationMaskTexture && colorMode === 0` test decides.
   */
  hasClassificationMask: boolean;
  profileLut: GPUTexture;
}

/** Texture roles the renderer's preview, readback and inspect passes still need. */
export interface GraphRoleTextures {
  layers: GPUTexture[];
  tracerBelow: GPUTexture;
  tracerAbove: GPUTexture;
  diagnostic: GPUTexture;
  pingPong: 0 | 1;
}

/**
 * Timestamp markers, fired at the stage boundaries the Perf HUD already knows.
 * The executor encodes one flat list of passes; these keep the HUD's
 * layers / persistence / compositor buckets meaningful anyway.
 */
export interface GraphEncodeMarks {
  layersEnd?: () => void;
  stampEnd?: () => void;
  compositorEnd?: () => void;
}

export interface GraphEncodeParams {
  state: RendererState;
  outputView: GPUTextureView;
  width: number;
  height: number;
  fps: number;
  marks?: GraphEncodeMarks;
}

const MARK_ORDER = ['layersEnd', 'stampEnd', 'compositorEnd'] as const;

/**
 * Executes a `CompiledGraph` on WebGPU.
 *
 * Phase 1 compiled a graph and drew nothing with it. This walks
 * `compiled.passes` in schedule order, binds each pass's inputs out of the
 * allocator's pool, writes its uniforms and encodes it — so a graph with a
 * different *shape* draws without anyone editing `WebGPUPipelines.ts`.
 *
 * Two invariants are load-bearing:
 *
 * - **Pipelines are cached on the structural hash.** A parameter change
 *   re-enters `encode()` with the same `CompiledGraph`, so nothing is created
 *   and `graphCompileCount()` does not move. `pipelineBuildCount` below makes
 *   that observable from a unit test.
 * - **No compute op is assumed.** Every `decay` pass runs the *fragment* fused
 *   coincidence+decay shader the compiler emits, which is exactly the fallback
 *   `PersistencePass` uses when compute storage textures are unavailable. The
 *   compute lane is an optimisation of the hand encoder, not a requirement of
 *   the graph.
 */
export class WebGpuGraphExecutor {
  private readonly device: GPUDevice;
  private readonly pipelines: WebGPUPipelines;
  private readonly internalFormat: GPUTextureFormat;
  private readonly outputFormat: GPUTextureFormat;
  private readonly layerSampler: GPUSampler;
  private readonly passSampler: GPUSampler;
  private readonly pool: GraphTexturePool;

  private compiled: CompiledGraph | null = null;
  private plan: EncodePlan | null = null;
  private nodePipelines = new Map<string, NodePipeline>();
  private builtForHash: string | null = null;
  private builtForSampleCount = 1;
  private sampleCount = 1;

  /** Pipelines created since construction — the "no churn" probe for tests. */
  pipelineBuildCount = 0;

  constructor(
    device: GPUDevice,
    pipelines: WebGPUPipelines,
    internalFormat: GPUTextureFormat,
    outputFormat: GPUTextureFormat,
    layerSampler: GPUSampler,
    passSampler: GPUSampler,
  ) {
    this.device = device;
    this.pipelines = pipelines;
    this.internalFormat = internalFormat;
    this.outputFormat = outputFormat;
    this.layerSampler = layerSampler;
    this.passSampler = passSampler;
    this.pool = new GraphTexturePool(device, internalFormat);
  }

  /**
   * Adopt a compiled graph, or `null` to stand down.
   *
   * Throws a `PassGraphError` when the graph compiles but cannot be encoded
   * (a `decay` reading the wrong number of stamp inputs, a `blend` with the
   * wrong tracer count) — a refusal, never a silent approximation.
   */
  setGraph(compiled: CompiledGraph | null): void {
    if (compiled === this.compiled) return;
    this.compiled = compiled;
    this.plan = compiled ? buildEncodePlan(compiled) : null;
  }

  get active(): boolean {
    return this.compiled !== null && this.plan !== null;
  }

  get graphHash(): string | null {
    return this.compiled?.hash ?? null;
  }

  /** Node ids this executor actually encodes, in order. */
  encodedPasses(): string[] {
    return this.plan ? encodedPassOrder(this.plan) : [];
  }

  setSampleCount(sampleCount: number): void {
    this.sampleCount = sampleCount;
  }

  /**
   * Textures for the roles the renderer's preview / readback / inspect passes
   * read. `null` when the graph does not have them — a graph with two band
   * layers and no tracers is legal, and those extras simply do not run.
   */
  roleTextures(): GraphRoleTextures | null {
    if (!this.plan) return null;
    const { layers, tracerBelow, tracerAbove } = this.plan.roles;
    if (layers.length < 3 || !tracerBelow || !tracerAbove) return null;
    try {
      return {
        layers: layers.map((id) => this.pool.transient(id)),
        tracerBelow: this.pool.pingPong(tracerBelow).read,
        tracerAbove: this.pool.pingPong(tracerAbove).read,
        diagnostic: this.pool.diagnostic(tracerAbove).read,
        pingPong: this.pool.readPhase,
      };
    } catch {
      // Sizes not configured yet — the first frame has not been encoded.
      return null;
    }
  }

  /** Encode the whole graph into `outputView`. */
  encode(enc: GPUCommandEncoder, inputs: GraphExternalInputs, params: GraphEncodeParams): void {
    const compiled = this.compiled;
    const plan = this.plan;
    if (!compiled || !plan) return;

    const { state, width, height } = params;
    const layerScale = state.layerScale ?? 1.0;
    const tracerScale = state.tracerScale ?? 1.0;
    const sizes: PoolSizes = {
      source: { width: inputs.source.width, height: inputs.source.height },
      layer: scaled(width, height, layerScale),
      tracer: scaled(width, height, tracerScale),
      output: { width, height },
    };

    this.pool.configure(compiled.allocation, sizes, this.sampleCount);
    this.ensurePipelines(compiled);

    // Stage markers are fired by crossing a boundary, and flushed in order at
    // the end, so a graph that skips a stage (a paused frame encodes no
    // accumulator pass) still resolves every query the HUD asked for.
    let marksFired = 0;
    const fireThrough = (limit: number): void => {
      while (marksFired <= limit) {
        params.marks?.[MARK_ORDER[marksFired]]?.();
        marksFired += 1;
      }
    };

    const paused = state.paused === true;
    for (const step of plan.steps) {
      if (step.kind === 'decay') fireThrough(0);
      if (step.kind === 'blend') fireThrough(1);
      // A paused session freezes the tracers exactly as `PersistencePass` does:
      // the accumulator passes are not encoded and the ping-pong never flips.
      if (paused && step.kind === 'decay') continue;
      this.encodeStep(enc, step, inputs, params, plan);
    }
    fireThrough(MARK_ORDER.length - 1);
    if (!paused) this.pool.flip();
  }

  destroy(): void {
    for (const node of this.nodePipelines.values()) destroyNodePipeline(node);
    this.nodePipelines.clear();
    this.builtForHash = null;
    this.pool.release();
  }

  // ─── pipelines ────────────────────────────────────────────────────────────

  private ensurePipelines(compiled: CompiledGraph): void {
    if (this.builtForHash === compiled.hash && this.builtForSampleCount === this.sampleCount) {
      return;
    }
    for (const node of this.nodePipelines.values()) destroyNodePipeline(node);
    this.nodePipelines = new Map();

    const ctx: NodePipelineContext = {
      device: this.device,
      pipelines: this.pipelines,
      internalFormat: this.internalFormat,
      outputFormat: this.outputFormat,
      sampleCount: this.sampleCount,
      layerCount: compiled.layerCount,
    };
    const emittedById = new Map<string, EmittedPass>(
      compiled.emitted.map((pass) => [pass.nodeId, pass]),
    );

    for (const step of this.plan!.steps) {
      const emitted = emittedById.get(step.nodeId);
      if (!emitted || emitted.fragment === '') continue;
      this.nodePipelines.set(step.nodeId, createNodePipeline(ctx, emitted));
      this.pipelineBuildCount += 1;
    }
    this.builtForHash = compiled.hash;
    this.builtForSampleCount = this.sampleCount;
  }

  private nodePipeline(nodeId: string): NodePipeline {
    const node = this.nodePipelines.get(nodeId);
    if (!node) throw new Error(`Graph node '${nodeId}' has no pipeline.`);
    return node;
  }

  // ─── encoding ─────────────────────────────────────────────────────────────

  private encodeStep(
    enc: GPUCommandEncoder,
    step: EncodeStep,
    inputs: GraphExternalInputs,
    params: GraphEncodeParams,
    plan: EncodePlan,
  ): void {
    switch (step.kind) {
      case 'band-layer':
        this.encodeBandLayer(enc, step, inputs, params);
        break;
      case 'decay':
        this.encodeStamp(enc, step, inputs, params);
        break;
      case 'blend':
        this.encodeBlend(enc, step, inputs, params, plan);
        break;
      case 'warp':
      case 'blur':
      case 'lut':
        this.encodeSingleInput(enc, step, inputs, params);
        break;
    }
  }

  private encodeBandLayer(
    enc: GPUCommandEncoder,
    step: Extract<EncodeStep, { kind: 'band-layer' }>,
    inputs: GraphExternalInputs,
    params: GraphEncodeParams,
  ): void {
    const node = this.nodePipeline(step.nodeId);
    const lp = node.layer!;
    const { state, width, height } = params;
    const aspect = width / height;
    const layer = state.layers[step.layerIndex] ?? { angleDeg: 0 };

    const [rad, flipX, flipY, layerAspect] = layerRotationUniforms(layer, aspect);
    lp.rotationData.set([rad, flipX, flipY, layerAspect]);
    this.device.queue.writeBuffer(
      lp.rotationBuffer, 0,
      lp.rotationData.buffer as ArrayBuffer, lp.rotationData.byteOffset, 16,
    );

    const colorMode = state.colorMode ?? 1.0;
    lp.fragData.set([
      state.avgLuminance,
      layerOpacity(state, step.layerIndex),
      colorMode,
      inputs.hasClassificationMask && colorMode === 0 ? 1 : 0,
      state.sobelEnabled ? 1 : 0,
      state.softCropEnabled ? 1 : 0,
      state.colorProfileLut && state.colorProfileMode ? 1 : 0,
      state.colorProfileLightDark ?? 1,
    ]);
    this.device.queue.writeBuffer(
      lp.fragUniformBuffer, 0,
      lp.fragData.buffer as ArrayBuffer, lp.fragData.byteOffset, 32,
    );

    const source = this.textureFor(step.source, inputs);
    const target = this.pool.transient(step.nodeId);
    const msaa = this.pool.msaaTarget();

    this.bindIfChanged(node, [source, inputs.classificationMask, inputs.profileLut], () => [
      { binding: 0, resource: { buffer: lp.rotationBuffer } },
      { binding: 1, resource: this.layerSampler },
      { binding: 2, resource: source.createView() },
      { binding: 3, resource: { buffer: lp.fragUniformBuffer } },
      { binding: 4, resource: inputs.classificationMask.createView() },
      { binding: 5, resource: inputs.profileLut.createView() },
    ]);

    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: msaa ? msaa.createView() : target.createView(),
        resolveTarget: msaa ? target.createView() : undefined,
        loadOp: 'clear',
        storeOp: msaa ? 'discard' : 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      }],
    });
    pass.setPipeline(node.pipeline);
    pass.setBindGroup(0, node.bindGroup!);
    pass.draw(6);
    pass.end();
  }

  /** The fused coincidence+decay accumulator — today's persistence pass. */
  private encodeStamp(
    enc: GPUCommandEncoder,
    step: Extract<EncodeStep, { kind: 'decay' }>,
    inputs: GraphExternalInputs,
    params: GraphEncodeParams,
  ): void {
    const node = this.nodePipeline(step.nodeId);
    const { state, fps } = params;
    const stampTextures = step.stampInputs.map((id) => this.textureFor(id, inputs));

    const duration = step.role === 'below'
      ? state.tracerBelowDuration ?? 0
      : state.tracerAboveDuration ?? 1000;
    const history = this.pool.pingPong(step.nodeId);
    const diagnostic = this.pool.diagnostic(step.nodeId);

    const f32 = new Float32Array(node.uniformData!);
    const u32 = new Uint32Array(node.uniformData!);
    f32[0] = durationToDecay(duration, fps);
    f32[1] = state.tracerThreshold ?? 0.05;
    f32[2] = state.stampBoost ?? 1.8;
    u32[3] = state.tracerMode ?? 0;
    u32[4] = state.peakCollisionsOnly ? 1 : 0;
    this.device.queue.writeBuffer(node.uniformBuffer!, 0, node.uniformData!);

    this.bindIfChanged(node, [...stampTextures, history.read], () => [
      { binding: 0, resource: this.passSampler },
      ...stampTextures.map((texture, i) => ({
        binding: i + 1,
        resource: texture.createView(),
      })),
      { binding: stampTextures.length + 1, resource: history.read.createView() },
      { binding: stampTextures.length + 2, resource: { buffer: node.uniformBuffer! } },
    ]);

    const pass = enc.beginRenderPass({
      colorAttachments: [
        clearAttachment(history.write.createView()),
        clearAttachment(diagnostic.write.createView()),
      ],
    });
    pass.setPipeline(node.pipeline);
    pass.setBindGroup(0, node.bindGroup!);
    pass.draw(6);
    pass.end();
  }

  private encodeBlend(
    enc: GPUCommandEncoder,
    step: Extract<EncodeStep, { kind: 'blend' }>,
    inputs: GraphExternalInputs,
    params: GraphEncodeParams,
    plan: EncodePlan,
  ): void {
    const node = this.nodePipeline(step.nodeId);
    const { state, outputView } = params;
    const layerTextures = step.layerInputs.map((id) => this.textureFor(id, inputs));
    const tracerTextures = step.tracerInputs.map((id) => this.textureFor(id, inputs));

    const layout = compositorUniformLayout(plan.layerCount);
    const f32 = new Float32Array(node.uniformData!);
    const u32 = new Uint32Array(node.uniformData!);
    f32[layout.tracerAboveOpacity] = state.tracerAboveIntensity ?? 0.85;
    f32[layout.tracerBelowOpacity] = state.tracerBelowIntensity ?? 0.30;
    u32[layout.layerBlendMode] = state.layerBlendMode ?? 0;
    u32[layout.tracerBlendMode] = state.tracerBlendMode ?? 0;
    for (let i = 0; i < plan.layerCount; i += 1) {
      f32[layout[`layerOpacity${i}`]] = layerOpacity(state, i);
    }
    f32[layout.diagnosticsOpacity] = state.diagnosticsOpacity ?? 0.55;
    f32[layout.stampBoost] = state.stampBoost ?? 1.8;
    u32[layout.outputMode] = state.outputMode ?? 0;
    u32[layout.tracerMode] = state.tracerMode ?? 0;
    u32[layout.diagnosticsMode] = state.diagnosticsMode ? 1 : 0;
    u32[layout.viewportQuarterZoom] = 0;
    f32[layout.halfOverlayAlpha] = state.halfOverlayAlpha ?? 0.5;
    u32[layout.viewportHalfOverlay] = 0;
    this.device.queue.writeBuffer(node.uniformBuffer!, 0, node.uniformData!);

    this.bindIfChanged(node, [...layerTextures, ...tracerTextures], () => [
      { binding: 0, resource: this.passSampler },
      ...layerTextures.map((texture, i) => ({ binding: i + 1, resource: texture.createView() })),
      ...tracerTextures.map((texture, i) => ({
        binding: layerTextures.length + 1 + i,
        resource: texture.createView(),
      })),
      {
        binding: layerTextures.length + tracerTextures.length + 1,
        resource: { buffer: node.uniformBuffer! },
      },
    ]);

    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: outputView,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    pass.setPipeline(node.pipeline);
    pass.setBindGroup(0, node.bindGroup!);
    pass.draw(6);
    pass.end();
  }

  /** `warp`, `blur` and `lut`: one input texture, one 16-byte uniform block. */
  private encodeSingleInput(
    enc: GPUCommandEncoder,
    step: Extract<EncodeStep, { kind: 'warp' | 'blur' | 'lut' }>,
    inputs: GraphExternalInputs,
    params: GraphEncodeParams,
  ): void {
    const node = this.nodePipeline(step.nodeId);
    const source = this.textureFor(step.inputs[0], inputs);
    const target = this.pool.transient(step.nodeId);
    const graphNode = this.compiled!.graph.nodes.find((n) => n.id === step.nodeId)!;
    const f32 = new Float32Array(node.uniformData!);

    if (step.kind === 'warp') {
      f32[0] = ((numberParam(graphNode.params.angleDeg, 0)) * Math.PI) / 180;
      f32[1] = numberParam(graphNode.params.scale, 1);
      f32[2] = params.width / params.height;
      f32[3] = numberParam(graphNode.params.displace, 0);
    } else if (step.kind === 'blur') {
      const axis = graphNode.params.axis === 'y' ? [0, 1] : [1, 0];
      f32[0] = axis[0];
      f32[1] = axis[1];
    } else {
      f32[0] = numberParam(graphNode.params.row, 0);
      f32[1] = params.state.colorProfileLightDark ?? 1;
      f32[2] = params.state.avgLuminance;
      f32[3] = numberParam(graphNode.params.mixAmount, 1);
    }
    this.device.queue.writeBuffer(node.uniformBuffer!, 0, node.uniformData!);

    const bound = step.kind === 'lut' ? [source, inputs.profileLut] : [source];
    this.bindIfChanged(node, bound, () => [
      { binding: 0, resource: this.passSampler },
      ...bound.map((texture, i) => ({ binding: i + 1, resource: texture.createView() })),
      { binding: bound.length + 1, resource: { buffer: node.uniformBuffer! } },
    ]);

    const pass = enc.beginRenderPass({
      colorAttachments: [clearAttachment(target.createView())],
    });
    pass.setPipeline(node.pipeline);
    pass.setBindGroup(0, node.bindGroup!);
    pass.draw(6);
    pass.end();
  }

  /**
   * The texture a producer node id resolves to: an external source for `source`
   * nodes, the ping-pong *read* texture for accumulators, the pooled transient
   * for everything else.
   */
  private textureFor(nodeId: string, inputs: GraphExternalInputs): GPUTexture {
    const node = this.compiled!.graph.nodes.find((n) => n.id === nodeId);
    if (!node) throw new Error(`Graph input '${nodeId}' is not a node.`);
    if (node.kind === 'source') return inputs.source;
    // Forward edges out of an accumulator read the *history* side, not the
    // target this frame writes. That is not an oversight, it is parity:
    // `encodeFrameCore` samples `getTracerTextures()` before
    // `PersistencePass.encode()` flips the ping-pong, so the shipped compositor
    // composites the previous frame's accumulation. Reading the write side here
    // would drop that frame of latency and stop matching the hand encoder.
    if (node.kind === 'decay') return this.pool.pingPong(nodeId).read;
    return this.pool.transient(nodeId);
  }

  /**
   * Rebuild a bind group only when one of its textures changed identity.
   *
   * Every other frame binds the same views, and creating a bind group per pass
   * per frame is exactly the per-frame allocation `BindGroupCache` exists to
   * avoid on the hand-encoded path.
   */
  private bindIfChanged(
    node: NodePipeline,
    textures: GPUTexture[],
    entries: () => GPUBindGroupEntry[],
  ): void {
    const key = textures.map((texture) => textureKey(texture)).join('|');
    if (node.bindGroup && node.bindGroupKey === key) return;
    node.bindGroup = this.device.createBindGroup({
      layout: node.bindGroupLayout,
      entries: entries(),
    });
    node.bindGroupKey = key;
  }
}

const clearAttachment = (view: GPUTextureView): GPURenderPassColorAttachment => ({
  view,
  loadOp: 'clear',
  storeOp: 'store',
  clearValue: { r: 0, g: 0, b: 0, a: 0 },
});

const scaled = (width: number, height: number, scale: number) => ({
  width: Math.max(1, Math.round(width * scale)),
  height: Math.max(1, Math.round(height * scale)),
});

const numberParam = (value: unknown, fallback: number): number =>
  typeof value === 'number' ? value : fallback;

/** Global layer opacity times the per-layer one, as the hand encoder computes it. */
function layerOpacity(state: RendererState, index: number): number {
  const global = state.layerOpacity ?? 1.0;
  const perLayer = state.layerOpacities?.[index] ?? 1.0;
  return global * perLayer;
}

/**
 * Identity key for a texture. `GPUTexture` has no stable id, so a lazily
 * attached symbol gives one without a WeakMap lookup per binding.
 */
const KEY = Symbol('chromashift.textureKey');
let nextKey = 0;
function textureKey(texture: GPUTexture): number {
  const keyed = texture as GPUTexture & { [KEY]?: number };
  keyed[KEY] ??= (nextKey += 1);
  return keyed[KEY];
}
