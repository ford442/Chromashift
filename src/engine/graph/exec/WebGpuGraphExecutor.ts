import { layerRotationUniforms } from '../../math/rotation';
import type { RendererState } from '../../types/RendererState';
import {
  BAND_LAYER_UNIFORMS,
  BLUR_UNIFORMS,
  DISPLACE_UNIFORMS,
  HISTORY_LOOP_UNIFORMS,
  HISTORY_UNIFORMS,
  LUT_UNIFORMS,
  WARP_UNIFORMS,
  compositorUniformLayout,
  persistUniformLayout,
} from '../templates/wgsl';
import { packUniforms, type UniformLayout, type UniformValues } from '../templates/uniformLayout';
import { ADVECT_UNIFORMS, EMIT_UNIFORMS, SPLAT_UNIFORMS } from '../templates/particles';
import { APPEND_DISPATCH_ARGS_OFFSET, APPEND_DRAW_ARGS_OFFSET, EMIT_WORKGROUP, isHistoryLoop } from '../nodeKinds';
import {
  EXTRA_TRACER_DURATION_MS,
  EXTRA_TRACER_INTENSITY,
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
  loopReadAge,
  ringSlotOfAge,
  type EncodePlan,
  type EncodeStep,
} from './plan';
import {
  createNodeProgram,
  emittedHasProgram,
  instantiateNodePipeline,
  destroyNodePipeline,
  type NodePipeline,
  type NodeProgram,
  type NodeProgramContext,
} from './nodePipelines';
import { resourceKey } from '../../webgpu/bindGroups';
import { GraphTexturePool, type PoolSizes } from './pool';
import { GraphBufferPool } from './bufferPool';
import { GraphProgramCache, type ProgramSet } from './programCache';
import type { CompiledGraph, EmittedPass } from '../types';
import type { CanvasPresentation } from '../../gpu/gpuOptions';

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

/**
 * `CompiledGraph.outputs`, resolved to this frame's textures — what the
 * inspect views, readbacks and exports read instead of a pass of their own.
 */
export interface GraphOutputTextures {
  /** Every band layer, in order. */
  layers: GPUTexture[];
  /** Every accumulator's read side (the last frame's result), in the compositor's order. */
  tracers: GPUTexture[];
  /** The shipped pair: `tracers[0]` and `tracers[1]`. */
  tracerBelow: GPUTexture;
  tracerAbove: GPUTexture;
  /** The `above` accumulator's stamp diagnostic, read side. */
  diagnostic: GPUTexture;
  pingPong: 0 | 1;
}

/**
 * Timestamp markers, fired at the stage boundaries the Perf HUD already knows.
 * The executor encodes one flat list of passes; these keep the HUD's
 * layers / particles (emit, advect, splat) / persistence / compositor buckets
 * meaningful anyway. The scheduler keeps a buffer chain contiguous and ahead
 * of the accumulators (`schedule.ts`), which is what lets each marker bracket
 * one stage. A graph with no chain fires the three particle markers together,
 * so those rows read 0.
 */
export interface GraphEncodeMarks {
  layersEnd?: () => void;
  emitEnd?: () => void;
  advectEnd?: () => void;
  splatEnd?: () => void;
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
  /**
   * `false` encodes every pass but the compositor — the layers and the
   * accumulators advance as usual and nothing is written to `outputView`. For
   * a frame whose canvas shows one of the graph's outputs (the full-res
   * tracer, a band layer, the heatmap) rather than its composite.
   */
  composite?: boolean;
}

const MARK_ORDER = ['layersEnd', 'emitEnd', 'advectEnd', 'splatEnd', 'stampEnd', 'compositorEnd'] as const;

/**
 * The marker a step crosses on its way in (the end of the stage before it):
 * every marker up to it fires first. A chain step also fires the next one —
 * its own stage's end — once it is encoded.
 */
const STEP_MARK: Partial<Record<EncodeStep['kind'], number>> = {
  emit: 0,
  advect: 1,
  splat: 2,
  decay: 3,
  blend: 4,
};

/** A node's program, known to be a render pass. */
type RenderNodePipeline = NodePipeline & { readonly pipeline: GPURenderPipeline };

/**
 * Defaults for the particle chain's value params — what an `emit` / `advect` /
 * `splat` node does not say. Every one is resolution- and frame-rate-free: the
 * emitter grid is `cells` across whatever the mask's size, births are a rate
 * per cell per second, and the dot radius is a fraction of the target height —
 * so a 1080p canvas and a 192-px golden hold the same particles.
 */
const PARTICLE_DEFAULTS = {
  /** Emitter cells across the mask's width. */
  cells: 128,
  /** Births per cell per second, where the mask fires. */
  spawnRate: 0.6,
  lifetimeSec: 2.5,
  boost: 1.6,
  speed: 0.02,
  flowGain: 1,
  curl: 0.06,
  noiseScale: 6,
  inertia: 0.9,
  /** Dot radius as a fraction of the target height (never under a pixel). */
  radius: 0.004,
  intensity: 0.9,
} as const;

/**
 * One drawable configuration: a compiled graph at a sample count, with this
 * executor's pipelines for it. What `readyFrame()` hands back and `encode()`
 * draws.
 */
export interface GraphFrame {
  readonly compiled: CompiledGraph;
  readonly sampleCount: number;
}

interface Frame extends GraphFrame {
  readonly plan: EncodePlan;
  readonly set: PipelineSet;
}

/**
 * Executes a `CompiledGraph` on WebGPU.
 *
 * Phase 1 compiled a graph and drew nothing with it. This walks
 * `compiled.passes` in schedule order, binds each pass's inputs out of the
 * allocator's pool, writes its uniforms and encodes it — so a graph with a
 * different *shape* draws without anyone editing a renderer.
 *
 * Two invariants are load-bearing:
 *
 * - **Pipelines are cached on the structural hash.** A parameter change
 *   re-enters `encode()` with the same `CompiledGraph`, so nothing is created
 *   and `graphCompileCount()` does not move. `pipelineBuildCount` below makes
 *   that observable from a unit test.
 * - **No compute op is assumed.** Every `decay` pass runs the *fragment* fused
 *   coincidence+decay shader the compiler emits — what the hand encoder ran
 *   when compute storage textures were unavailable. Its compute-fed stamp was
 *   an optimisation, not a requirement of the graph (docs/PASS_GRAPH.md).
 *
 * The graph `setGraph()` adopts is the *target*; what a frame draws is a
 * {@link GraphFrame}. They differ only while the device is still validating
 * the target's pipelines, when `readyFrame()` keeps drawing the last frame.
 */
export class WebGpuGraphExecutor {
  private readonly device: GPUDevice;
  private readonly internalFormat: GPUTextureFormat;
  private readonly outputFormat: GPUTextureFormat;
  private readonly layerSampler: GPUSampler;
  private readonly passSampler: GPUSampler;
  private readonly pool: GraphTexturePool;
  private readonly buffers: GraphBufferPool;
  private readonly programs: GraphProgramCache;
  /**
   * Frames encoded since the last clear — the particle chain's clock. `emit`
   * hashes it into its spawn roll and `advect` derives its curl phase from
   * it, so it restarts with the trails: two exports of the same settings
   * spawn the same particles.
   */
  private particleFrame = 0;
  private zeroField: GPUTexture | null = null;

  /** The target graph: what `setGraph()` adopted. */
  private compiled: CompiledGraph | null = null;
  private plan: EncodePlan | null = null;
  /** What the frame being encoded draws — and, between frames, what the last one drew. */
  private frame: Frame | null = null;
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
  /** The set for the target graph and sample count, once built. */
  private current: PipelineSet | null = null;

  /** Pipelines created since construction — the "no churn" probe for tests. */
  pipelineBuildCount = 0;

  constructor(
    device: GPUDevice,
    internalFormat: GPUTextureFormat,
    outputFormat: GPUTextureFormat,
    layerSampler: GPUSampler,
    passSampler: GPUSampler,
  ) {
    this.device = device;
    this.internalFormat = internalFormat;
    this.outputFormat = outputFormat;
    this.layerSampler = layerSampler;
    this.passSampler = passSampler;
    this.pool = new GraphTexturePool(device, internalFormat);
    this.buffers = new GraphBufferPool(device);
    this.programs = GraphProgramCache.for(device);
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
    this.plan = compiled ? this.planFor(compiled) : null;
    this.compiled = compiled;
    this.current = null;
  }

  private planFor(compiled: CompiledGraph): EncodePlan {
    const plan = this.plans.get(compiled.hash) ?? buildEncodePlan(compiled);
    this.plans.set(compiled.hash, plan);
    return plan;
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
   * back, `readyFrame()` keeps drawing the last frame instead.
   */
  get ready(): boolean {
    if (!this.active) return false;
    const set = this.pipelineSets.get(pipelineSetKey(this.compiled!, this.sampleCount));
    return set?.programs.valid === true;
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
    return this.ensurePipelines(this.compiled).programs.verdict;
  }

  /**
   * What a frame presenting to `presentation` can draw right now without
   * binding a pipeline the device has not accepted: the target, once
   * validated; otherwise the last frame drawn, if its pipelines are still
   * cached and it presents to the same canvas format (an SDR graph cannot draw
   * into an `rgba16float` canvas, nor the reverse). `null` when neither — the
   * caller clears.
   *
   * So a structural switch — the temporal term on, a layer count, MSAA —
   * keeps the previous variant on screen for the moment the device takes to
   * validate the new one, instead of a black frame.
   */
  readyFrame(presentation: CanvasPresentation = 'sdr'): GraphFrame | null {
    const target = this.compiled && this.plan ? this.targetFrame() : null;
    if (target?.set.programs.valid === true && presentationOf(target.compiled) === presentation) {
      return target;
    }
    const last = this.frame;
    if (
      last
      && last.set.programs.valid === true
      && this.pipelineSets.get(pipelineSetKey(last.compiled, last.sampleCount)) === last.set
      && presentationOf(last.compiled) === presentation
    ) {
      return last;
    }
    return null;
  }

  /** The graph the last encoded frame drew, or `null` before the first. */
  get drawnGraph(): CompiledGraph | null {
    return this.frame?.compiled ?? null;
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

  /** Node ids this executor encodes for `compiled` (the target by default), in order. */
  encodedPasses(compiled: CompiledGraph | null = this.compiled): string[] {
    if (!compiled) return [];
    const plan = compiled === this.compiled ? this.plan : this.planFor(compiled);
    return plan ? encodedPassOrder(plan) : [];
  }

  setSampleCount(sampleCount: number): void {
    if (sampleCount === this.sampleCount) return;
    this.sampleCount = sampleCount;
    this.current = null;
  }

  /**
   * The graph's named outputs as this frame's textures. `null` when the graph
   * does not have them — a graph with no band layer or fewer than two
   * accumulators is legal, and the views that need them simply do not run —
   * or before the first frame has sized the pool.
   */
  outputTextures(): GraphOutputTextures | null {
    // The last frame's graph: the pool holds *its* textures, and the target
    // may not have drawn yet.
    const outputs = (this.frame?.compiled ?? this.compiled)?.outputs;
    if (!outputs || outputs.layers.length === 0 || outputs.tracers.length < 2 || !outputs.diagnostic) {
      return null;
    }
    try {
      const tracers = outputs.tracers.map((id) => this.pool.pingPong(id).read);
      return {
        layers: outputs.layers.map((id) => this.pool.transient(id)),
        tracers,
        tracerBelow: tracers[0]!,
        tracerAbove: tracers[1]!,
        diagnostic: this.pool.diagnostic(outputs.diagnostic).read,
        pingPong: this.pool.readPhase,
      };
    } catch {
      // Sizes not configured yet — the first frame has not been encoded.
      return null;
    }
  }

  /**
   * Encode the whole graph into `outputView`: `frame` (from `readyFrame()`),
   * or the target graph — which the caller has then made sure the device
   * accepted (`prepare()`).
   */
  encode(
    enc: GPUCommandEncoder,
    inputs: GraphExternalInputs,
    params: GraphEncodeParams,
    frame?: GraphFrame,
  ): void {
    const drawn = (frame as Frame | undefined) ?? (this.compiled && this.plan ? this.targetFrame() : null);
    if (!drawn) return;
    this.frame = drawn;
    const { compiled, plan } = drawn;

    const { state, width, height } = params;
    const layerScale = rendererStateValue(state, 'layerScale');
    const tracerScale = rendererStateValue(state, 'tracerScale');
    const sizes: PoolSizes = {
      source: { width: inputs.source.width, height: inputs.source.height },
      layer: scaled(width, height, layerScale),
      tracer: scaled(width, height, tracerScale),
      output: { width, height },
    };

    this.pool.configure(compiled.allocation, sizes, drawn.sampleCount);
    this.buffers.configure(compiled.allocation, sizes);

    // Stage markers are fired by crossing a boundary, and flushed in order at
    // the end, so a graph that skips a stage (a paused frame encodes no
    // accumulator pass) still resolves every query the HUD asked for.
    let marksFired = 0;
    const fireThrough = (limit: number): void => {
      while (marksFired <= limit) {
        params.marks?.[MARK_ORDER[marksFired]!]?.();
        marksFired += 1;
      }
    };

    const paused = state.paused === true;
    const composite = params.composite !== false;
    for (const step of plan.steps) {
      const mark = STEP_MARK[step.kind];
      if (mark !== undefined) fireThrough(mark);
      // A paused session freezes the tracers exactly as the hand encoder did:
      // the accumulator passes are not encoded and the ping-pong never flips.
      // The particles freeze with them — no spawn, no step — and `splat` still
      // draws where they stopped.
      const frozen = paused && (step.kind === 'decay' || step.kind === 'emit' || step.kind === 'advect');
      const skipped = frozen || (!composite && step.kind === 'blend');
      if (!skipped) this.encodeStep(enc, step, inputs, params);
      if (step.kind === 'emit' || step.kind === 'advect' || step.kind === 'splat') fireThrough(mark! + 1);
    }
    fireThrough(MARK_ORDER.length - 1);
    if (!paused) {
      this.pool.flip();
      this.particleFrame += 1;
    }
  }

  /**
   * Clear the tracer accumulators the pool owns — the graph's ping-pong pairs
   * are the tracer state, so this is what `WebGPURenderer.clearPersistence()`
   * drops — and the `history` rings with them.
   */
  clearAccumulators(): void {
    const textures = this.pool.accumulatorTextures();
    const buffers = this.buffers.liveBuffers();
    this.pool.resetRings();
    // The particle ring is trail state too: emptied, and its clock restarted.
    this.particleFrame = 0;
    if (textures.length === 0 && buffers.length === 0) return;

    const enc = this.device.createCommandEncoder();
    for (const texture of textures) {
      enc.beginRenderPass({
        colorAttachments: [clearAttachment(texture.createView())],
      }).end();
    }
    for (const pooled of buffers) {
      enc.clearBuffer(pooled.items);
      if (pooled.control) enc.clearBuffer(pooled.control);
    }
    this.device.queue.submit([enc.finish()]);
  }

  destroy(): void {
    for (const set of this.pipelineSets.values()) destroyPipelineSet(set);
    this.pipelineSets.clear();
    this.current = null;
    this.frame = null;
    this.plans.clear();
    this.pool.release();
    this.buffers.release();
    this.zeroField?.destroy();
    this.zeroField = null;
  }

  /** Ring textures the pool holds right now — `history`'s live VRAM, for tests. */
  ringTextureCount(): number {
    return this.pool.ringTextureCount();
  }

  /**
   * Bytes of every buffer the pool holds right now — the buffer half of the
   * VRAM bound. 0 for a graph without a buffer resource (the default graph).
   */
  bufferBytes(): number {
    return this.buffers.allocatedBytes();
  }

  /**
   * The particle ring `nodeId` (an `emit`, `advect` or `splat`) reads or
   * writes: its element and control buffers, for a readback that checks the
   * live count stays within capacity. `null` before a frame has created it.
   */
  particleBuffers(nodeId: string): { items: GPUBuffer; control: GPUBuffer | null; capacity: number } | null {
    const resourceOf = (id: string): string | undefined => this.frame?.compiled.allocation.assignment[id];
    const graph = this.frame?.compiled.graph;
    const node = graph?.nodes.find((n) => n.id === nodeId);
    // `splat` reads its producer's resource; the others hold their own.
    const holder = node?.kind === 'splat' ? node.inputs[0]! : nodeId;
    if (!resourceOf(holder)) return null;
    const pooled = this.buffers.liveBuffers().find((b) => b.resource.id === resourceOf(holder));
    if (!pooled) return null;
    const { elements } = pooled.resource;
    return { items: pooled.items, control: pooled.control, capacity: typeof elements === 'number' ? elements : 0 };
  }

  // ─── pipelines ────────────────────────────────────────────────────────────

  /** The target graph at the target sample count, its pipelines built. */
  private targetFrame(): Frame {
    const compiled = this.compiled!;
    const set = this.current ?? this.ensurePipelines(compiled);
    return { compiled, plan: this.plan!, set, sampleCount: this.sampleCount };
  }

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

    const ctx: NodeProgramContext = {
      device: this.device,
      internalFormat: this.internalFormat,
      outputFormat: this.outputFormat,
      sampleCount: this.sampleCount,
    };
    const emittedById = new Map<string, EmittedPass>(
      compiled.emitted.map((pass) => [pass.nodeId, pass]),
    );

    // The programs are shared by every executor on the device (see
    // `programCache.ts`); this executor's buffers and bind groups are its own.
    const { set: programs, built } = this.programs.obtain(
      `${key}@${this.internalFormat}@${this.outputFormat}`,
      () => {
        const compiledPrograms = new Map<string, NodeProgram>();
        for (const step of this.plan!.steps) {
          const emitted = emittedById.get(step.nodeId);
          if (!emitted || !emittedHasProgram(emitted)) continue;
          compiledPrograms.set(step.nodeId, createNodeProgram(ctx, emitted));
        }
        return compiledPrograms;
      },
    );
    this.pipelineBuildCount += built;
    const set: PipelineSet = { programs, nodes: new Map() };
    for (const [nodeId, program] of programs.programs) {
      set.nodes.set(nodeId, instantiateNodePipeline(this.device, emittedById.get(nodeId)!, program));
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
      // Neither the target's nor the one on screen, which may be drawing
      // while the target validates.
      if (set === this.current || set === this.frame?.set) continue;
      destroyPipelineSet(set);
      this.pipelineSets.delete(key);
    }
  }

  private nodePipeline(nodeId: string): RenderNodePipeline {
    const node = this.frame?.set.nodes.get(nodeId);
    if (!node?.pipeline) throw new Error(`Graph node '${nodeId}' has no render pipeline.`);
    return node as RenderNodePipeline;
  }

  private computeNode(nodeId: string): NodePipeline {
    const node = this.frame?.set.nodes.get(nodeId);
    if (!node || node.computePipelines.length === 0) throw new Error(`Graph node '${nodeId}' has no compute pipelines.`);
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
      case 'emit':
        this.encodeEmit(enc, step, inputs, params);
        break;
      case 'advect':
        this.encodeAdvect(enc, step, inputs, params);
        break;
      case 'splat':
        this.encodeSplat(enc, step);
        break;
    }
  }

  /**
   * `emit`: a compute pass of two dispatches over one bind group — the append
   * over the mask's emitter grid, then the one-invocation kernel that turns
   * the head into `advect`'s and `splat`'s indirect arguments. Same command
   * encoder as the render passes around it: no extra submit.
   */
  private encodeEmit(
    enc: GPUCommandEncoder,
    step: Extract<EncodeStep, { kind: 'emit' }>,
    inputs: GraphExternalInputs,
    params: GraphEncodeParams,
  ): void {
    const node = this.computeNode(step.nodeId);
    const ring = this.buffers.buffersFor(step.nodeId);
    const masks = step.maskInputs.map((id) => this.textureFor(id, inputs));
    const graphNode = this.graphNode(step.nodeId);
    const mask = masks[0]!;
    const cells = Math.max(1, numberParam(graphNode.params.cells, PARTICLE_DEFAULTS.cells));
    const spacing = Math.max(1, Math.round(mask.width / cells));
    const dt = 1 / Math.max(1, params.fps);
    this.writeUniforms(node, EMIT_UNIFORMS, {
      frameIndex: this.particleFrame,
      spacing,
      spawnChance: Math.min(1, numberParam(graphNode.params.spawnRate, PARTICLE_DEFAULTS.spawnRate) * dt),
      lifetime: numberParam(graphNode.params.lifetimeSec, PARTICLE_DEFAULTS.lifetimeSec),
      colorThresh: rendererStateValue(params.state, 'tracerThreshold'),
      boost: numberParam(graphNode.params.boost, PARTICLE_DEFAULTS.boost),
      speed: numberParam(graphNode.params.speed, PARTICLE_DEFAULTS.speed),
    });
    this.bindIfChanged(node, [...masks, ring.control!, ring.items], () => [
      ...masks.map((texture, i) => ({ binding: i, resource: texture.createView() })),
      { binding: masks.length, resource: { buffer: ring.control! } },
      { binding: masks.length + 1, resource: { buffer: ring.items } },
      { binding: masks.length + 2, resource: { buffer: node.uniformBuffer! } },
    ]);

    const [append, args] = node.computePipelines;
    const groups = (extent: number, workgroup: number) =>
      Math.max(1, Math.ceil(Math.ceil(extent / spacing) / workgroup));
    const pass = enc.beginComputePass();
    pass.setBindGroup(0, node.bindGroup);
    pass.setPipeline(append!);
    pass.dispatchWorkgroups(groups(mask.width, EMIT_WORKGROUP[0]), groups(mask.height, EMIT_WORKGROUP[1]));
    pass.setPipeline(args!);
    pass.dispatchWorkgroups(1);
    pass.end();
  }

  /** `advect`: one compute dispatch, sized by the live count on the GPU (`dispatchWorkgroupsIndirect`). */
  private encodeAdvect(
    enc: GPUCommandEncoder,
    step: Extract<EncodeStep, { kind: 'advect' }>,
    inputs: GraphExternalInputs,
    params: GraphEncodeParams,
  ): void {
    const node = this.computeNode(step.nodeId);
    const ring = this.buffers.buffersFor(step.nodeId);
    const field = this.textureFor(step.field, inputs);
    const graphNode = this.graphNode(step.nodeId);
    // The export loop's FrameClock steps 1000 / fps ms, so this is its dt.
    const fps = Math.max(1, params.fps);
    const dt = 1 / fps;
    const inertia = Math.min(Math.max(numberParam(graphNode.params.inertia, PARTICLE_DEFAULTS.inertia), 0), 0.999);
    this.writeUniforms(node, ADVECT_UNIFORMS, {
      dt,
      time: this.particleFrame * dt,
      fps,
      flowGain: numberParam(graphNode.params.flowGain, PARTICLE_DEFAULTS.flowGain),
      curl: numberParam(graphNode.params.curl, PARTICLE_DEFAULTS.curl),
      noiseScale: numberParam(graphNode.params.noiseScale, PARTICLE_DEFAULTS.noiseScale),
      keep: inertia ** (dt * 60),
    });
    this.bindIfChanged(node, [field, ring.control!, ring.items], () => [
      { binding: 0, resource: field.createView() },
      { binding: 1, resource: { buffer: ring.control! } },
      { binding: 2, resource: { buffer: ring.items } },
      { binding: 3, resource: { buffer: node.uniformBuffer! } },
    ]);

    const pass = enc.beginComputePass();
    pass.setPipeline(node.computePipelines[0]!);
    pass.setBindGroup(0, node.bindGroup);
    pass.dispatchWorkgroupsIndirect(ring.control!, APPEND_DISPATCH_ARGS_OFFSET);
    pass.end();
  }

  /** `splat`: the ring as instance attributes, `drawIndirect` over the live count, additive. */
  private encodeSplat(enc: GPUCommandEncoder, step: Extract<EncodeStep, { kind: 'splat' }>): void {
    const node = this.nodePipeline(step.nodeId);
    const ring = this.buffers.buffersFor(step.particles);
    const target = this.pool.transient(step.nodeId);
    const graphNode = this.graphNode(step.nodeId);
    const radius = Math.max(1, numberParam(graphNode.params.radius, PARTICLE_DEFAULTS.radius) * target.height);
    this.writeUniforms(node, SPLAT_UNIFORMS, {
      radiusX: (radius * 2) / Math.max(1, target.width),
      radiusY: (radius * 2) / Math.max(1, target.height),
      intensity: numberParam(graphNode.params.intensity, PARTICLE_DEFAULTS.intensity),
    });
    this.bindIfChanged(node, [], () => [
      { binding: 0, resource: { buffer: node.uniformBuffer! } },
    ]);

    const pass = enc.beginRenderPass({
      colorAttachments: [clearAttachment(target.createView())],
    });
    pass.setPipeline(node.pipeline);
    pass.setBindGroup(0, node.bindGroup);
    pass.setVertexBuffer(0, ring.items);
    pass.drawIndirect(ring.control!, APPEND_DRAW_ARGS_OFFSET);
    pass.end();
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
    pass.setBindGroup(0, node.bindGroup);
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
    pass.setBindGroup(0, node.bindGroup);
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
    pass.setBindGroup(0, node.bindGroup);
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
    if (step.fed !== null) {
      this.encodeHistoryLoop(enc, step, step.fed, inputs, params);
      return;
    }
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
        colorAttachments: [clearAttachment(ring.textures[ring.head]!.createView())],
      });
      pass.setPipeline(write.pipeline);
      pass.setBindGroup(0, write.bindGroup);
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
    pass.setBindGroup(0, node.bindGroup);
    pass.draw(6);
    pass.end();
  }

  /**
   * `history` in `loop` mode: one pass, the mixing write of `live` and `fed`
   * into the ring head. There is no taps pass — every reader of the node binds
   * a previous slot ({@link textureFor}) — and `fed` is normally one of them,
   * already drawn this frame from that slot. A paused frame skips the write and
   * the pool does not flip, so the loop holds still with the tracers.
   *
   * The first frames read slots nothing has written yet: zeroed textures, so
   * the loop starts empty and catches as the ring fills, the way a decay warms
   * up. No frame is special-cased into a copy of the live picture.
   */
  private encodeHistoryLoop(
    enc: GPUCommandEncoder,
    step: Extract<EncodeStep, { kind: 'history' }>,
    fedId: string,
    inputs: GraphExternalInputs,
    params: GraphEncodeParams,
  ): void {
    if (params.state.paused === true) return;
    const node = this.nodePipeline(step.nodeId);
    const ring = this.pool.ring(step.nodeId);
    const target = ring.textures[ring.head]!;
    const bound = [this.textureFor(step.input, inputs), this.textureFor(fedId, inputs)];
    if (bound.includes(target)) {
      // Unreachable while `loopReadAge` keeps reads off the head; a guard
      // rather than a feedback loop inside one render pass.
      throw new Error(`Graph node '${step.nodeId}' would sample the ring slot it writes.`);
    }
    this.writeUniforms(node, HISTORY_LOOP_UNIFORMS, {
      gain: numberParam(this.graphNode(step.nodeId).params.gain, 0.96),
    });
    this.bindIfChanged(node, bound, () => [
      { binding: 0, resource: this.passSampler },
      ...bound.map((texture, i) => ({ binding: i + 1, resource: texture.createView() })),
      { binding: bound.length + 1, resource: { buffer: node.uniformBuffer! } },
    ]);
    const pass = enc.beginRenderPass({ colorAttachments: [clearAttachment(target.createView())] });
    pass.setPipeline(node.pipeline);
    pass.setBindGroup(0, node.bindGroup);
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
    const source = this.textureFor(step.inputs[0]!, inputs);
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
        ? [source, this.textureFor(step.inputs[1]!, inputs)]
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
    pass.setBindGroup(0, node.bindGroup);
    pass.draw(6);
    pass.end();
  }

  /**
   * The texture a producer node id resolves to: an external source for `source`
   * nodes, the ping-pong *read* texture for accumulators, the pooled transient
   * for everything else.
   */
  private textureFor(nodeId: string, inputs: GraphExternalInputs): GPUTexture {
    const node = this.frame!.compiled.graph.nodes.find((n) => n.id === nodeId);
    if (!node) throw new Error(`Graph input '${nodeId}' is not a node.`);
    if (node.kind === 'source') {
      return node.params.role === 'motion-field'
        ? inputs.motionField ?? this.zeroMotionField()
        : inputs.source;
    }
    // Forward edges out of an accumulator read the *history* side, not the
    // target this frame writes. That is not an oversight, it is parity: the
    // hand encoder sampled its tracers before its persistence pass flipped the
    // ping-pong, so the shipped compositor composited the previous frame's
    // accumulation. Reading the write side here would drop that frame of
    // latency and stop matching the frames pinned in e2e/__golden__.
    if (node.kind === 'decay') return this.pool.pingPong(nodeId).read;
    // Every read of a loop history is a previous-slot edge: the ring slot
    // written `delay` frames ago (one, by default), never the head this
    // frame's write fills.
    if (isHistoryLoop(node)) {
      const ring = this.pool.ring(nodeId);
      const frames = ring.textures.length;
      return ring.textures[ringSlotOfAge(frames, ring.head, loopReadAge(frames, node.params.delay))]!;
    }
    return this.pool.transient(nodeId);
  }

  private graphNode(nodeId: string) {
    return this.frame!.compiled.graph.nodes.find((n) => n.id === nodeId)!;
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
   * per frame is an allocation the frame does not need (see `bindGroups.ts`).
   */
  private bindIfChanged(
    node: Pick<NodePipeline, 'bindGroupLayout' | 'bindGroup' | 'bindGroupKey'>,
    textures: readonly object[],
    entries: () => GPUBindGroupEntry[],
  ): void {
    const key = textures.map(resourceKey).join('|');
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

/** One graph's programs at one sample count, and this executor's instances of them. */
interface PipelineSet {
  /** Shared with every other executor on the device, verdict included. */
  readonly programs: ProgramSet;
  readonly nodes: Map<string, NodePipeline>;
}

const pipelineSetKey = (compiled: CompiledGraph, sampleCount: number): string =>
  `${compiled.hash}@${sampleCount}`;

/** The canvas format family a graph's compositor writes. */
function presentationOf(compiled: CompiledGraph): CanvasPresentation {
  return compiled.emitted.find((pass) => pass.kind === 'blend')?.presentation ?? 'sdr';
}

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
