import { layerRotationUniforms } from '../../math/rotation';
import type { WebGPUPipelines } from '../../WebGPUPipelines';
import type { RendererState } from '../../types/RendererState';
import {
  BAND_LAYER_UNIFORMS,
  BLUR_UNIFORMS,
  DISPLACE_UNIFORMS,
  HISTORY_UNIFORMS,
  LUT_UNIFORMS,
  WARP_UNIFORMS,
  compositorUniformLayout,
  persistUniformLayout,
} from '../templates/wgsl';
import { packUniforms, type UniformLayout, type UniformValues } from '../templates/uniformLayout';
import {
  bandLayerUniforms,
  compositorUniforms,
  graphTracerDuration,
  persistUniforms,
  rendererStateValue,
} from './uniforms';
import {
  buildEncodePlan,
  encodedPassOrder,
  historyWeights,
  type EncodePlan,
  type EncodeStep,
} from './plan';
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
  /**
   * The motion-field chore's output, bound by a `source` node with
   * `role: 'motion-field'`. Absent when the plan does not want it or the lane
   * declined; the executor then binds a zero field, so `displace` is the
   * identity rather than a missing binding.
   */
  motionField?: GPUTexture | null;
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
 * What an extra tracer timescale (a third accumulator and on) is drawn with
 * when its node does not say: a slow, faint echo under the shipped pair.
 */
const EXTRA_TRACER_DURATION_MS = 4000;
const EXTRA_TRACER_INTENSITY = 0.4;

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
  private zeroField: GPUTexture | null = null;

  private compiled: CompiledGraph | null = null;
  private plan: EncodePlan | null = null;
  /** Encode plans by structural hash: a graph switched back to is not re-planned. */
  private readonly plans = new Map<string, EncodePlan>();
  private sampleCount = 1;
  /**
   * Built pipelines by structural hash and sample count, least recently used
   * first. A renderer moves between a handful of variants of one graph — the
   * temporal term on and off, MSAA on and off, a few layer counts — and
   * switching back to one it has drawn must not rebuild or revalidate it.
   */
  private readonly pipelineSets = new Map<string, PipelineSet>();
  /** The set for the current graph and sample count, once built. */
  private current: PipelineSet | null = null;

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
    let plan: EncodePlan | null = null;
    if (compiled) {
      plan = this.plans.get(compiled.hash) ?? buildEncodePlan(compiled);
      this.plans.set(compiled.hash, plan);
    }
    this.compiled = compiled;
    this.plan = plan;
    this.current = null;
  }

  get active(): boolean {
    return this.compiled !== null && this.plan !== null;
  }

  /**
   * True once the device has accepted every pipeline this graph encodes with,
   * at the current sample count.
   *
   * `active` is not enough to draw with. WGSL the device rejects does not
   * throw: it yields an invalid shader module, an invalid pipeline, and a
   * command buffer the queue drops whole — every pass in the frame, not just
   * the broken one, so the canvas goes black. Until `prepare()` has heard
   * back, the renderer keeps drawing with the hand encoder.
   */
  get ready(): boolean {
    if (!this.active) return false;
    const set = this.pipelineSets.get(pipelineSetKey(this.compiled!, this.sampleCount));
    return set?.valid === true;
  }

  /**
   * Build the pipelines now and resolve with the device's verdict on them:
   * `null` when every one validated, otherwise the device's first error.
   *
   * Idempotent for an unchanged graph and sample count. When a later build
   * supersedes this one (the sample count changed mid-flight), the promise
   * answers for the current build rather than the stale one.
   */
  prepare(): Promise<string | null> {
    if (!this.compiled || !this.plan) return Promise.resolve(null);
    return this.ensurePipelines(this.compiled).verdict;
  }

  /** True when the adopted graph binds the motion field — the renderer runs the chore for it. */
  get wantsMotionField(): boolean {
    return this.plan?.wantsMotionField ?? false;
  }

  /** True when the adopted graph reads the field's velocity, so the chore must solve flow. */
  get motionFieldNeedsFlow(): boolean {
    return this.plan?.motionFieldNeedsFlow ?? false;
  }

  get graphHash(): string | null {
    return this.compiled?.hash ?? null;
  }

  /** Node ids this executor actually encodes, in order. */
  encodedPasses(): string[] {
    return this.plan ? encodedPassOrder(this.plan) : [];
  }

  setSampleCount(sampleCount: number): void {
    if (sampleCount === this.sampleCount) return;
    this.sampleCount = sampleCount;
    this.current = null;
  }

  /**
   * Textures for the roles the renderer's preview / readback / inspect passes
   * read: every band layer the graph draws, in order, and the two tracers.
   * `null` when the graph does not have them — a graph with no tracers is
   * legal, and those extras simply do not run.
   */
  roleTextures(): GraphRoleTextures | null {
    if (!this.plan) return null;
    const { layers, tracerBelow, tracerAbove } = this.plan.roles;
    if (layers.length === 0 || !tracerBelow || !tracerAbove) return null;
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
    const layerScale = rendererStateValue(state, 'layerScale');
    const tracerScale = rendererStateValue(state, 'tracerScale');
    const sizes: PoolSizes = {
      source: { width: inputs.source.width, height: inputs.source.height },
      layer: scaled(width, height, layerScale),
      tracer: scaled(width, height, tracerScale),
      output: { width, height },
    };

    this.pool.configure(compiled.allocation, sizes, this.sampleCount);
    if (!this.current) this.ensurePipelines(compiled);

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
      this.encodeStep(enc, step, inputs, params);
    }
    fireThrough(MARK_ORDER.length - 1);
    if (!paused) this.pool.flip();
  }

  /**
   * Clear the tracer accumulators the pool owns.
   *
   * The graph's ping-pong pairs are the tracer state while the executor draws,
   * so `WebGPURenderer.clearPersistence()` has to reach them — clearing only
   * the hand encoder's `PersistencePass` would leave the next graph frame
   * accumulating from the trails the user just asked to drop.
   */
  clearAccumulators(): void {
    const textures = this.pool.accumulatorTextures();
    this.pool.resetRings();
    if (textures.length === 0) return;

    const enc = this.device.createCommandEncoder();
    for (const texture of textures) {
      enc.beginRenderPass({
        colorAttachments: [clearAttachment(texture.createView())],
      }).end();
    }
    this.device.queue.submit([enc.finish()]);
  }

  destroy(): void {
    for (const set of this.pipelineSets.values()) destroyPipelineSet(set);
    this.pipelineSets.clear();
    this.current = null;
    this.plans.clear();
    this.pool.release();
    this.zeroField?.destroy();
    this.zeroField = null;
  }

  /** Ring textures the pool holds right now — `history`'s live VRAM, for tests. */
  ringTextureCount(): number {
    return this.pool.ringTextureCount();
  }

  // ─── pipelines ────────────────────────────────────────────────────────────

  /**
   * The pipeline set for `compiled` at the current sample count, built on
   * first use. A set switched back to is reused, verdict and all.
   */
  private ensurePipelines(compiled: CompiledGraph): PipelineSet {
    const key = pipelineSetKey(compiled, this.sampleCount);
    const cached = this.pipelineSets.get(key);
    if (cached) {
      // Most recently used goes last; eviction takes from the front.
      this.pipelineSets.delete(key);
      this.pipelineSets.set(key, cached);
      this.current = cached;
      return cached;
    }

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
    const set: PipelineSet = { nodes: new Map(), valid: null, verdict: Promise.resolve(null) };

    // Every object the build creates is created inside these scopes, and
    // nothing else runs between the push and the pops, so an error they catch
    // belongs to this graph's pipelines.
    this.device.pushErrorScope('internal');
    this.device.pushErrorScope('validation');
    try {
      for (const step of this.plan!.steps) {
        const emitted = emittedById.get(step.nodeId);
        if (!emitted || emitted.fragment === '') continue;
        set.nodes.set(step.nodeId, createNodePipeline(ctx, emitted));
        this.pipelineBuildCount += 1;
      }
    } finally {
      const validation = this.device.popErrorScope();
      const internal = this.device.popErrorScope();
      set.verdict = Promise.all([validation, internal]).then(([invalid, failed]) => {
        const error = invalid ?? failed;
        set.valid = error === null;
        return error ? error.message : null;
      });
    }

    this.pipelineSets.set(key, set);
    this.current = set;
    this.evictPipelineSets();
    return set;
  }

  /** Destroy the least recently used sets beyond {@link MAX_PIPELINE_SETS}. */
  private evictPipelineSets(): void {
    for (const [key, set] of this.pipelineSets) {
      if (this.pipelineSets.size <= MAX_PIPELINE_SETS) return;
      if (set === this.current) continue;
      destroyPipelineSet(set);
      this.pipelineSets.delete(key);
    }
  }

  private nodePipeline(nodeId: string): NodePipeline {
    const node = this.current?.nodes.get(nodeId);
    if (!node) throw new Error(`Graph node '${nodeId}' has no pipeline.`);
    return node;
  }

  // ─── encoding ─────────────────────────────────────────────────────────────

  private encodeStep(
    enc: GPUCommandEncoder,
    step: EncodeStep,
    inputs: GraphExternalInputs,
    params: GraphEncodeParams,
  ): void {
    switch (step.kind) {
      case 'band-layer':
        this.encodeBandLayer(enc, step, inputs, params);
        break;
      case 'decay':
        this.encodeStamp(enc, step, inputs, params);
        break;
      case 'blend':
        this.encodeBlend(enc, step, inputs, params);
        break;
      case 'history':
        this.encodeHistory(enc, step, inputs, params);
        break;
      case 'warp':
      case 'blur':
      case 'lut':
      case 'displace':
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

    packUniforms(BAND_LAYER_UNIFORMS, bandLayerUniforms(state, {
      layerIndex: step.layerIndex,
      hasClassificationMask: inputs.hasClassificationMask,
    }), lp.fragUniforms);
    this.device.queue.writeBuffer(lp.fragUniformBuffer, 0, lp.fragUniforms.buffer);

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
    const history = this.pool.pingPong(step.nodeId);
    const diagnostic = this.pool.diagnostic(step.nodeId);
    // The temporal term's variant binds the field after the previous frame and
    // fills the uniform block's motion fields; without it this is the pass, the
    // layout and the block that shipped before the term existed.
    const field = step.motionField ? this.textureFor(step.motionField, inputs) : null;

    // The shipped pair are timed by the session; an extra timescale by its own node.
    const role = step.role;
    this.writeUniforms(
      node,
      persistUniformLayout(field !== null),
      persistUniforms(state, {
        role: role === 'extra' ? 'above' : role,
        fps,
        durationMs: role === 'extra'
          ? graphTracerDuration(numberParam(this.graphNode(step.nodeId).params.durationMs, EXTRA_TRACER_DURATION_MS), fps)
          : undefined,
      }),
    );

    const bound = [...stampTextures, history.read, ...(field ? [field] : [])];
    this.bindIfChanged(node, bound, () => [
      { binding: 0, resource: this.passSampler },
      ...bound.map((texture, i) => ({ binding: i + 1, resource: texture.createView() })),
      { binding: bound.length + 1, resource: { buffer: node.uniformBuffer! } },
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
  ): void {
    const node = this.nodePipeline(step.nodeId);
    const { state, outputView } = params;
    const layerTextures = step.layerInputs.map((id) => this.textureFor(id, inputs));
    const tracerTextures = step.tracerInputs.map((id) => this.textureFor(id, inputs));

    // Opacities of the timescales past the shipped two come from their own nodes.
    const extraTracerOpacities = step.tracerInputs.slice(2).map((id) =>
      numberParam(this.graphNode(id).params.intensity, EXTRA_TRACER_INTENSITY));
    this.writeUniforms(
      node,
      compositorUniformLayout(step.layerInputs.length, step.tracerInputs.length),
      compositorUniforms(state, step.layerInputs.length, { extraTracerOpacities }),
    );

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

  /**
   * `history`: blit this frame's input into the ring slot at the head, then mix
   * every slot by age into the node's pooled target.
   *
   * Two passes, because the taps pass samples the slot the write pass targets.
   * The taps bind group is the ring in physical order, so it is built once and
   * the moving head is only ever a uniform write. A paused frame skips the write
   * — the pool does not flip either — so the ring freezes like a tracer.
   */
  private encodeHistory(
    enc: GPUCommandEncoder,
    step: Extract<EncodeStep, { kind: 'history' }>,
    inputs: GraphExternalInputs,
    params: GraphEncodeParams,
  ): void {
    const node = this.nodePipeline(step.nodeId);
    const write = node.ringWrite!;
    const ring = this.pool.ring(step.nodeId);

    if (params.state.paused !== true) {
      const source = this.textureFor(step.input, inputs);
      this.bindIfChanged(write, [source], () => [
        { binding: 0, resource: this.passSampler },
        { binding: 1, resource: source.createView() },
      ]);
      const pass = enc.beginRenderPass({
        colorAttachments: [clearAttachment(ring.textures[ring.head].createView())],
      });
      pass.setPipeline(write.pipeline);
      pass.setBindGroup(0, write.bindGroup!);
      pass.draw(6);
      pass.end();
    }

    const graphNode = this.graphNode(step.nodeId);
    const weights = historyWeights(step.frames, ring.head, ring.filled, {
      mode: graphNode.params.mode === 'tap' ? 'tap' : 'trail',
      delay: numberParam(graphNode.params.delay, 0),
      falloff: numberParam(graphNode.params.falloff, 0.6),
    });
    // Slots past `frames` keep weight 0; the block is always the full eight.
    const weightValues: Record<string, number> = {};
    HISTORY_UNIFORMS.fields.forEach((field, i) => { weightValues[field.name] = weights[i] ?? 0; });
    this.writeUniforms(node, HISTORY_UNIFORMS, weightValues);

    this.bindIfChanged(node, ring.textures, () => [
      { binding: 0, resource: this.passSampler },
      ...ring.textures.map((texture, i) => ({ binding: i + 1, resource: texture.createView() })),
      { binding: ring.textures.length + 1, resource: { buffer: node.uniformBuffer! } },
    ]);

    const pass = enc.beginRenderPass({
      colorAttachments: [clearAttachment(this.pool.transient(step.nodeId).createView())],
    });
    pass.setPipeline(node.pipeline);
    pass.setBindGroup(0, node.bindGroup!);
    pass.draw(6);
    pass.end();
  }

  /**
   * `warp`, `blur`, `lut` and `displace`: sampled inputs (one, or `displace`'s
   * source + field), one 16-byte uniform block.
   */
  private encodeSingleInput(
    enc: GPUCommandEncoder,
    step: Extract<EncodeStep, { kind: 'warp' | 'blur' | 'lut' | 'displace' }>,
    inputs: GraphExternalInputs,
    params: GraphEncodeParams,
  ): void {
    const node = this.nodePipeline(step.nodeId);
    const source = this.textureFor(step.inputs[0], inputs);
    const target = this.pool.transient(step.nodeId);
    const graphNode = this.graphNode(step.nodeId);

    if (step.kind === 'displace') {
      this.writeUniforms(node, DISPLACE_UNIFORMS, {
        gain: numberParam(graphNode.params.gain, 1),
        sign: graphNode.params.mode === 'forward' ? 1 : -1,
      });
    } else if (step.kind === 'warp') {
      this.writeUniforms(node, WARP_UNIFORMS, {
        angleRad: (numberParam(graphNode.params.angleDeg, 0) * Math.PI) / 180,
        scale: numberParam(graphNode.params.scale, 1),
        aspect: params.width / params.height,
        displace: numberParam(graphNode.params.displace, 0),
      });
    } else if (step.kind === 'blur') {
      const vertical = graphNode.params.axis === 'y';
      this.writeUniforms(node, BLUR_UNIFORMS, { axisX: vertical ? 0 : 1, axisY: vertical ? 1 : 0 });
    } else {
      this.writeUniforms(node, LUT_UNIFORMS, {
        row: numberParam(graphNode.params.row, 0),
        lightDark: rendererStateValue(params.state, 'colorProfileLightDark'),
        avgLuminance: params.state.avgLuminance,
        mixAmount: numberParam(graphNode.params.mixAmount, 1),
      });
    }

    const bound = step.kind === 'lut'
      ? [source, inputs.profileLut]
      : step.kind === 'displace'
        ? [source, this.textureFor(step.inputs[1], inputs)]
        : [source];
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
    if (node.kind === 'source') {
      return node.params.role === 'motion-field'
        ? inputs.motionField ?? this.zeroMotionField()
        : inputs.source;
    }
    // Forward edges out of an accumulator read the *history* side, not the
    // target this frame writes. That is not an oversight, it is parity:
    // `encodeFrameCore` samples `getTracerTextures()` before
    // `PersistencePass.encode()` flips the ping-pong, so the shipped compositor
    // composites the previous frame's accumulation. Reading the write side here
    // would drop that frame of latency and stop matching the hand encoder.
    if (node.kind === 'decay') return this.pool.pingPong(nodeId).read;
    return this.pool.transient(nodeId);
  }

  private graphNode(nodeId: string) {
    return this.compiled!.graph.nodes.find((n) => n.id === nodeId)!;
  }

  /** Pack one node's uniform block with the layout its shader was emitted from, and upload it. */
  private writeUniforms<N extends string>(
    node: NodePipeline,
    layout: UniformLayout<N>,
    values: NoInfer<UniformValues<N>>,
  ): void {
    const data = node.uniforms!;
    packUniforms(layout, values, data);
    this.device.queue.writeBuffer(node.uniformBuffer!, 0, data.buffer);
  }

  /** 1×1 zero velocity — what a `motion-field` source binds when the lane has no field. */
  private zeroMotionField(): GPUTexture {
    this.zeroField ??= this.device.createTexture({
      size: [1, 1, 1],
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    return this.zeroField;
  }

  /**
   * Rebuild a bind group only when one of its textures changed identity.
   *
   * Every other frame binds the same views, and creating a bind group per pass
   * per frame is exactly the per-frame allocation `BindGroupCache` exists to
   * avoid on the hand-encoded path.
   */
  private bindIfChanged(
    node: Pick<NodePipeline, 'bindGroupLayout' | 'bindGroup' | 'bindGroupKey'>,
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

/**
 * Pipeline sets kept per executor. Enough for every variant a session moves
 * between in practice (two motion states × two MSAA states × a couple of layer
 * counts); a slider swept through all ten layer counts evicts the oldest.
 */
const MAX_PIPELINE_SETS = 8;

/** One graph's pipelines at one sample count, and the device's verdict on them. */
interface PipelineSet {
  readonly nodes: Map<string, NodePipeline>;
  /** `null` until the device has answered. */
  valid: boolean | null;
  verdict: Promise<string | null>;
}

const pipelineSetKey = (compiled: CompiledGraph, sampleCount: number): string =>
  `${compiled.hash}@${sampleCount}`;

function destroyPipelineSet(set: PipelineSet): void {
  for (const node of set.nodes.values()) destroyNodePipeline(node);
  set.nodes.clear();
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
