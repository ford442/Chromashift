import { layerRotationUniforms } from '../../math/rotation';
import type { RendererState } from '../../types/RendererState';
import {
  activateProgram,
  bindTexture,
  type ProgramInfo,
  uniform1f,
  uniform1i,
} from '../../webgl/programUtils';
import type { WebGLInternalFormat } from '../../gpuOptions';
import {
  createMultisampleTarget,
  createTarget,
  destroyMultisampleTarget,
  destroyTarget,
  resolveMultisampleTarget,
  selectWebGLInternalFormat,
  supportedSampleCount,
  type MultisampleTarget,
  type RenderTarget,
} from '../../webgl/resources';
import {
  BLIT_FRAGMENT_SOURCE,
  PASSTHROUGH_VERTEX_SOURCE,
  ROTATION_VERTEX_SOURCE,
} from '../../webgl/shaders/common';
import type { WebGLRenderViewport } from '../../webgl/types';
import type { CompiledGraph, EmittedPass } from '../types';
import {
  buildEncodePlan,
  encodedPassOrder,
  historyWeights,
  type EncodePlan,
  type EncodeStep,
} from './plan';
import { TexturePool, type ClassSize, type PoolTextureFactory } from './pool';
import {
  EXTRA_TRACER_DURATION_MS,
  EXTRA_TRACER_INTENSITY,
  bandLayerUniforms,
  compositorUniforms,
  graphTracerDuration,
  persistUniforms,
  rendererStateValue,
} from './uniforms';
import { WebGLProgramCache, type WebGLProgramSet } from './webglProgramCache';

/** Externally supplied textures a `source` node and the band layers bind. */
export interface WebGLGraphInputs {
  /** The image (or live frame), with its size — the `source` resolution class. */
  source: { texture: WebGLTexture; width: number; height: number };
  /** The colour-profile LUT the band layers and `lut` nodes sample. */
  profileLut: WebGLTexture;
  /**
   * The CPU lanes' motion field, bound by a `source` with `role:
   * 'motion-field'`, or `null`; the executor then binds a zero field, so
   * `displace` is the identity rather than a missing binding.
   */
  motionField: WebGLTexture | null;
}

export interface WebGLGraphEncodeParams {
  state: RendererState;
  fps: number;
  /** Target sizes of the layer- and tracer-scaled classes. */
  layer: ClassSize;
  tracer: ClassSize;
  /** Width / height the band layers rotate against. */
  aspect: number;
  /** Where the compositor draws: a render target, or `framebuffer` (the canvas when `null`). */
  output: WebGLOutput;
  /**
   * `false` runs every pass but the compositor: the layers draw and the
   * tracers accumulate, and nothing is written to `output`.
   */
  composite?: boolean;
  /**
   * Draws a band layer instead of its emitted program — the WebGL debug views
   * (luminance mask, UV grid, layer isolation), which are inspection tools, not
   * graph nodes. The layer's target is bound and cleared when it is called.
   * Return `false` to draw the emitted program after all.
   */
  drawLayer?: (layerIndex: number, source: WebGLTexture) => boolean;
}

/** Where a compositor pass lands. */
export interface WebGLOutput {
  /** A render target, or `null` for `framebuffer`. */
  target: RenderTarget | null;
  /** The framebuffer drawn when `target` is `null` — an XR layer's; `null` is the canvas. */
  framebuffer?: WebGLFramebuffer | null;
  /** The rectangle drawn into. Its size is the `output` resolution class. */
  viewport: WebGLRenderViewport;
}

/** `CompiledGraph.outputs`, resolved to the last frame's targets. */
export interface WebGLGraphOutputTargets {
  layers: RenderTarget[];
  /** Every accumulator's read side, in the compositor's order. */
  tracers: RenderTarget[];
}

/** One drawable configuration: a compiled graph and the context's programs for it. */
export interface WebGLGraphFrame {
  readonly compiled: CompiledGraph;
}

interface Frame extends WebGLGraphFrame {
  readonly plan: EncodePlan;
  readonly set: WebGLProgramSet;
}

/**
 * The pool's textures on WebGL: FBO targets in the context's internal format.
 * No stamp side-channel on this backend, and the MSAA renderbuffer is not a
 * texture, so the executor owns it: every pooled use is a colour target.
 */
function webglTargetFactory(gl: WebGL2RenderingContext, format: WebGLInternalFormat): PoolTextureFactory<RenderTarget> {
  return {
    create: (size) => createTarget(gl, Math.max(1, size.width), Math.max(1, size.height), format),
    destroy: (target) => destroyTarget(gl, target),
  };
}

/** Program-cache key for the `history` write blit, which no graph node emits. */
const RING_WRITE = '\u0000ring-write';

/**
 * Executes a `CompiledGraph` on WebGL2 — the twin of `WebGpuGraphExecutor`.
 *
 * It walks the same `EncodePlan` (so the fusion rule, the tracer roles and
 * every refusal the plan makes are shared, not re-derived), binds the same
 * allocator's pool through `TexturePool` (transients, ping-pong pairs and
 * `history` rings with the WebGPU lifetime rules), and reads every uniform
 * from `uniforms.ts`.
 *
 * What differs is the backend's own: programs bind uniforms by name rather
 * than through packed blocks, and a shader the driver rejects is a
 * synchronous compile or link failure, so `prepare()` answers at once. Until
 * a target has validated — and forever, for one that does not — `readyFrame()`
 * keeps drawing the last frame that did.
 */
export class WebGLGraphExecutor {
  private readonly gl: WebGL2RenderingContext;
  private readonly pool: TexturePool<RenderTarget>;
  private readonly programs: WebGLProgramCache;
  private zeroField: WebGLTexture | null = null;
  /** Format of every pooled target: `rgba16f` where the context renders it. */
  readonly internalFormat: WebGLInternalFormat;
  /** Requested band-layer samples — 1, or 4 under MSAA. */
  private sampleCount = 1;
  /**
   * The band layers' shared multisample renderbuffer, as WebGPU shares one
   * MSAA texture: each layer draws into it and resolves into its pooled
   * target. Reallocated when the layer size or the sample count changes.
   */
  private msaa: MultisampleTarget | null = null;
  /** Size and request `msaa` was made for — set even when the format allows no multisampling. */
  private msaaKey: string | null = null;

  /** The target graph: what `setGraph()` adopted. */
  private compiled: CompiledGraph | null = null;
  private plan: EncodePlan | null = null;
  /** What the frame being encoded draws — and, between frames, what the last one drew. */
  private frame: Frame | null = null;
  private readonly plans = new Map<string, EncodePlan>();
  private readonly sets = new Map<string, WebGLProgramSet>();

  /** Programs this executor's builds linked — the "no churn" probe for tests. */
  programBuildCount = 0;
  private destroyed = false;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.internalFormat = selectWebGLInternalFormat(gl);
    this.pool = new TexturePool(webglTargetFactory(gl, this.internalFormat));
    this.programs = WebGLProgramCache.retain(gl);
  }

  /**
   * Band-layer MSAA: `4` draws every band layer into a multisample
   * renderbuffer and blits it into the layer's target; `1` draws the target
   * directly. Persistence and the compositor are always single-sample, as on
   * WebGPU. Programs do not depend on it, so nothing relinks — the next frame
   * reallocates the renderbuffer.
   */
  setSampleCount(sampleCount: number): void {
    this.sampleCount = Math.max(1, Math.floor(sampleCount));
  }

  /** Samples the last frame's band layers drew at: the request, capped by what the format supports. */
  get layerSampleCount(): number {
    return this.msaa?.samples ?? 1;
  }

  /**
   * Adopt a compiled graph, or `null` to stand down. Throws a `PassGraphError`
   * when the graph compiles but cannot be encoded — the plan's refusal.
   */
  setGraph(compiled: CompiledGraph | null): void {
    if (compiled === this.compiled) return;
    this.plan = compiled ? this.planFor(compiled) : null;
    this.compiled = compiled;
  }

  private planFor(compiled: CompiledGraph): EncodePlan {
    const plan = this.plans.get(compiled.hash) ?? buildEncodePlan(compiled);
    this.plans.set(compiled.hash, plan);
    return plan;
  }

  get active(): boolean {
    return this.compiled !== null && this.plan !== null;
  }

  /** True once every program the target graph draws with has compiled and linked. */
  get ready(): boolean {
    return this.active && this.sets.get(this.compiled!.hash)?.error === null;
  }

  /**
   * Compile and link the target's programs, and answer with the context's
   * verdict: `null` when every one linked, otherwise the driver's log.
   * Idempotent; a graph switched back to answers from the cache.
   */
  prepare(): string | null {
    if (!this.compiled || !this.plan) return null;
    return this.ensurePrograms(this.compiled, this.plan).error;
  }

  /**
   * What a frame can draw right now: the target once its programs linked,
   * otherwise the last frame drawn — so a refused variant leaves the previous
   * graph on the canvas. `null` when neither.
   */
  readyFrame(): WebGLGraphFrame | null {
    if (this.compiled && this.plan) {
      const set = this.ensurePrograms(this.compiled, this.plan);
      if (set.error === null) {
        const target: Frame = { compiled: this.compiled, plan: this.plan, set };
        return target;
      }
    }
    return this.frame?.set.error === null ? this.frame : null;
  }

  /** The graph the last encoded frame drew, or `null` before the first. */
  get drawnGraph(): CompiledGraph | null {
    return this.frame?.compiled ?? null;
  }

  /** True when the adopted graph binds the motion field. */
  get wantsMotionField(): boolean {
    return this.plan?.wantsMotionField ?? false;
  }

  /** True when the adopted graph reads the field's velocity, so the lane must solve flow. */
  get motionFieldNeedsFlow(): boolean {
    return this.plan?.motionFieldNeedsFlow ?? false;
  }

  /** Node ids this executor encodes for `compiled` (the target by default), in order. */
  encodedPasses(compiled: CompiledGraph | null = this.compiled): string[] {
    if (!compiled) return [];
    return encodedPassOrder(compiled === this.compiled && this.plan ? this.plan : this.planFor(compiled));
  }

  /** The last frame's named outputs as targets, or `null` before the first frame or for a graph without them. */
  outputTargets(): WebGLGraphOutputTargets | null {
    const outputs = this.frame?.compiled.outputs;
    if (!outputs || outputs.layers.length === 0 || outputs.tracers.length < 2) return null;
    try {
      return {
        layers: outputs.layers.map((id) => this.pool.transient(id)),
        tracers: outputs.tracers.map((id) => this.pool.pingPong(id).read),
      };
    } catch {
      return null;
    }
  }

  /** Draw the whole graph: `frame` (from `readyFrame()`), or the target, which must have validated. */
  encode(inputs: WebGLGraphInputs, params: WebGLGraphEncodeParams, frame?: WebGLGraphFrame): void {
    const drawn = (frame as Frame | undefined) ?? this.readyFrame() as Frame | null;
    if (!drawn || drawn.set.error !== null) return;
    this.frame = drawn;

    const { viewport } = params.output;
    this.pool.configure(drawn.compiled.allocation, {
      source: { width: inputs.source.width, height: inputs.source.height },
      layer: params.layer,
      tracer: params.tracer,
      output: { width: viewport.width, height: viewport.height },
    }, 1);

    const paused = params.state.paused === true;
    const composite = params.composite !== false;
    for (const step of drawn.plan.steps) {
      // A paused session freezes the tracers: no accumulator pass, no flip.
      if (paused && step.kind === 'decay') continue;
      if (!composite && step.kind === 'blend') continue;
      this.encodeStep(step, inputs, params);
    }
    if (!paused) this.pool.flip();
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
  }

  /**
   * Re-run only the last frame's compositor, with `state`, into `output` — the
   * collision-stats heatmap, the tracer export and the stationary previews
   * read the graph this way instead of drawing a pass of their own. Returns
   * whether there was a frame to composite.
   */
  composite(inputs: WebGLGraphInputs, state: RendererState, output: WebGLOutput): boolean {
    const drawn = this.frame;
    const blend = drawn?.plan.steps.find((step) => step.kind === 'blend');
    if (!drawn || !blend || blend.kind !== 'blend') return false;
    try {
      this.encodeBlend(blend, inputs, state, output);
    } catch {
      // The pool has not been sized yet: nothing has been drawn to composite.
      return false;
    } finally {
      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    }
    return true;
  }

  /** Clear the accumulators and `history` rings — the tracer state "Reset trails" drops. */
  clearAccumulators(): void {
    const gl = this.gl;
    this.pool.resetRings();
    for (const target of this.pool.accumulatorTextures()) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.viewport(0, 0, target.width, target.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Drop this executor's targets and its hold on the context's programs. Idempotent. */
  destroy(): void {
    if (!this.destroyed) {
      this.destroyed = true;
      this.programs.release();
    }
    this.pool.release();
    this.releaseMsaa();
    this.frame = null;
    this.compiled = null;
    this.plan = null;
    this.plans.clear();
    this.sets.clear();
    if (this.zeroField) {
      this.gl.deleteTexture(this.zeroField);
      this.zeroField = null;
    }
  }

  // ─── programs ─────────────────────────────────────────────────────────────

  private ensurePrograms(compiled: CompiledGraph, plan: EncodePlan): WebGLProgramSet {
    const own = this.sets.get(compiled.hash);
    if (own) return own;
    const emittedById = new Map<string, EmittedPass>(compiled.emitted.map((pass) => [pass.nodeId, pass]));
    const { set, built } = this.programs.obtain(compiled.hash, (program) => {
      const programs = new Map<string, ProgramInfo>();
      for (const step of plan.steps) {
        const emitted = emittedById.get(step.nodeId);
        if (!emitted || emitted.fragment === '') continue;
        const vertex = step.kind === 'band-layer' ? ROTATION_VERTEX_SOURCE : PASSTHROUGH_VERTEX_SOURCE;
        programs.set(step.nodeId, program(vertex, emitted.fragment));
      }
      if (plan.steps.some((step) => step.kind === 'history')) {
        programs.set(RING_WRITE, program(PASSTHROUGH_VERTEX_SOURCE, BLIT_FRAGMENT_SOURCE));
      }
      return programs;
    });
    this.programBuildCount += built;
    this.sets.set(compiled.hash, set);
    return set;
  }

  private program(nodeId: string): ProgramInfo {
    const info = this.frame?.set.programs.get(nodeId);
    if (!info) throw new Error(`Graph node '${nodeId}' has no program.`);
    return info;
  }

  // ─── encoding ─────────────────────────────────────────────────────────────

  private encodeStep(step: EncodeStep, inputs: WebGLGraphInputs, params: WebGLGraphEncodeParams): void {
    switch (step.kind) {
      case 'band-layer':
        this.encodeBandLayer(step, inputs, params);
        break;
      case 'decay':
        this.encodeStamp(step, inputs, params);
        break;
      case 'blend':
        this.encodeBlend(step, inputs, params.state, params.output);
        break;
      case 'history':
        this.encodeHistory(step, inputs, params);
        break;
      case 'warp':
      case 'blur':
      case 'lut':
      case 'displace':
        this.encodeSingleInput(step, inputs, params);
        break;
    }
  }

  private encodeBandLayer(
    step: Extract<EncodeStep, { kind: 'band-layer' }>,
    inputs: WebGLGraphInputs,
    params: WebGLGraphEncodeParams,
  ): void {
    const gl = this.gl;
    const { state } = params;
    const source = this.textureFor(step.source, inputs);
    const target = this.pool.transient(step.nodeId);
    const msaa = this.msaaTargetFor(target);
    this.beginPass(msaa ?? target);
    if (params.drawLayer?.(step.layerIndex, source)) {
      if (msaa) resolveMultisampleTarget(gl, msaa, target);
      return;
    }

    const program = this.program(step.nodeId);
    // The same `FragUniforms` values WebGPU packs. This backend has no
    // classification mask, so `useMask` is never set.
    const values = bandLayerUniforms(state, { layerIndex: step.layerIndex, hasClassificationMask: false });
    const layer = state.layers[step.layerIndex] ?? { angleDeg: 0 };
    const [rad, flipX, flipY, layerAspect] = layerRotationUniforms(layer, params.aspect);
    activateProgram(gl, program);
    bindTexture(gl, program, 'u_source', 0, source);
    bindTexture(gl, program, 'u_profileLut', 1, inputs.profileLut);
    uniform1i(gl, program, 'u_layerIndex', step.layerIndex);
    uniform1f(gl, program, 'u_angleRad', rad);
    uniform1f(gl, program, 'u_flipX', flipX);
    uniform1f(gl, program, 'u_flipY', flipY);
    uniform1f(gl, program, 'u_aspect', layerAspect);
    uniform1f(gl, program, 'u_avgLuminance', values.avgLuminance);
    // The GLSL band shader multiplies its output alpha by this, and the
    // compositor applies the layer opacity again — so the band pass stays
    // opaque here, where the WGSL band shader ignores the field.
    uniform1f(gl, program, 'u_layerOpacity', 1);
    uniform1f(gl, program, 'u_colorMode', values.colorMode);
    uniform1f(gl, program, 'u_sobelEnabled', values.sobelEnabled);
    uniform1f(gl, program, 'u_softCropEnabled', values.softCropEnabled);
    uniform1f(gl, program, 'u_profileMode', values.profileMode);
    uniform1f(gl, program, 'u_profileLightDark', values.profileLightDark);
    this.draw();
    if (msaa) resolveMultisampleTarget(gl, msaa, target);
  }

  /** The fused coincidence+decay accumulator — the shipped persistence pass. */
  private encodeStamp(
    step: Extract<EncodeStep, { kind: 'decay' }>,
    inputs: WebGLGraphInputs,
    params: WebGLGraphEncodeParams,
  ): void {
    const gl = this.gl;
    const { state, fps } = params;
    const program = this.program(step.nodeId);
    const history = this.pool.pingPong(step.nodeId);
    const role = step.role;
    // The shipped pair are timed by the session; an extra timescale by its own node.
    const values = persistUniforms(state, {
      role: role === 'extra' ? 'above' : role,
      fps,
      durationMs: role === 'extra'
        ? graphTracerDuration(numberParam(this.graphNode(step.nodeId).params.durationMs, EXTRA_TRACER_DURATION_MS), fps)
        : undefined,
    });

    const stamps = step.stampInputs.map((id) => this.textureFor(id, inputs));
    const field = step.motionField ? this.textureFor(step.motionField, inputs) : null;

    this.beginPass(history.write, false);
    activateProgram(gl, program);
    stamps.forEach((texture, i) => bindTexture(gl, program, `u_layer${i}`, i, texture));
    bindTexture(gl, program, 'u_previous', stamps.length, history.read.texture);
    uniform1f(gl, program, 'u_decay', values.decayFactor);
    uniform1f(gl, program, 'u_stampBoost', values.stampBoost);
    uniform1i(gl, program, 'u_tracerMode', values.tracerMode);
    uniform1i(gl, program, 'u_peakMode', values.peakMode);
    if (field) {
      // The temporal term's variant: without it this is the pre-motion program.
      bindTexture(gl, program, 'u_motion', stamps.length + 1, field);
      uniform1i(gl, program, 'u_motionMode', values.motionMode);
      uniform1f(gl, program, 'u_motionGain', values.motionGain);
      uniform1f(gl, program, 'u_motionDecayBias', values.motionDecayBias);
    }
    this.draw();
  }

  private encodeBlend(
    step: Extract<EncodeStep, { kind: 'blend' }>,
    inputs: WebGLGraphInputs,
    state: RendererState,
    output: WebGLOutput,
  ): void {
    const gl = this.gl;
    const program = this.program(step.nodeId);
    const layers = step.layerInputs.map((id) => this.textureFor(id, inputs));
    const tracers = step.tracerInputs.map((id) => this.textureFor(id, inputs));
    // Opacities of the timescales past the shipped two come from their own nodes.
    const extraTracerOpacities = step.tracerInputs.slice(2).map((id) =>
      numberParam(this.graphNode(id).params.intensity, EXTRA_TRACER_INTENSITY));
    const values = compositorUniforms(state, layers.length, { extraTracerOpacities });

    const { viewport } = output;
    gl.bindFramebuffer(gl.FRAMEBUFFER, output.target?.framebuffer ?? output.framebuffer ?? null);
    gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
    // Cleared within the viewport only: an XR layer holds both eyes.
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(viewport.x, viewport.y, viewport.width, viewport.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.SCISSOR_TEST);

    activateProgram(gl, program);
    layers.forEach((texture, i) => bindTexture(gl, program, `u_layer${i}`, i, texture));
    const tracerName = (k: number) => (k === 0 ? 'u_tracerBelow' : k === 1 ? 'u_tracerAbove' : `u_tracer${k}`);
    tracers.forEach((texture, k) => bindTexture(gl, program, tracerName(k), layers.length + k, texture));
    for (let i = 0; i < layers.length; i += 1) {
      uniform1f(gl, program, `u_layerOpacity${i}`, values[`layerOpacity${i}`]);
    }
    uniform1f(gl, program, 'u_tracerBelowOpacity', values.tracerBelowOpacity);
    uniform1f(gl, program, 'u_tracerAboveOpacity', values.tracerAboveOpacity);
    extraTracerOpacities.forEach((_, k) => {
      uniform1f(gl, program, `u_tracerOpacity${k + 2}`, values[`tracerOpacity${k + 2}`]);
    });
    uniform1i(gl, program, 'u_layerBlendMode', values.layerBlendMode);
    uniform1i(gl, program, 'u_tracerBlendMode', values.tracerBlendMode);
    uniform1i(gl, program, 'u_outputMode', values.outputMode);
    uniform1i(gl, program, 'u_mainViewMode', rendererStateValue(state, 'mainViewMode'));
    uniform1i(gl, program, 'u_diagnosticsMode', values.diagnosticsMode);
    uniform1f(gl, program, 'u_diagnosticsOpacity', values.diagnosticsOpacity);
    uniform1i(gl, program, 'u_viewportQuarterZoom', values.viewportQuarterZoom);
    uniform1i(gl, program, 'u_viewportHalfOverlay', values.viewportHalfOverlay);
    uniform1f(gl, program, 'u_halfOverlayAlpha', values.halfOverlayAlpha);
    this.draw();
  }

  /**
   * `history`: blit this frame's input into the ring slot at the head, then mix
   * every slot by age into the node's pooled target — the WebGPU executor's two
   * passes. A paused frame skips the write, so the ring freezes like a tracer.
   */
  private encodeHistory(
    step: Extract<EncodeStep, { kind: 'history' }>,
    inputs: WebGLGraphInputs,
    params: WebGLGraphEncodeParams,
  ): void {
    const gl = this.gl;
    const ring = this.pool.ring(step.nodeId);

    if (params.state.paused !== true) {
      const write = this.program(RING_WRITE);
      const source = this.textureFor(step.input, inputs);
      this.beginPass(ring.textures[ring.head], false);
      activateProgram(gl, write);
      bindTexture(gl, write, 'u_source', 0, source);
      this.draw();
    }

    const node = this.graphNode(step.nodeId);
    const weights = historyWeights(step.frames, ring.head, ring.filled, {
      mode: node.params.mode === 'tap' ? 'tap' : 'trail',
      delay: numberParam(node.params.delay, 0),
      falloff: numberParam(node.params.falloff, 0.6),
    });
    const program = this.program(step.nodeId);
    this.beginPass(this.pool.transient(step.nodeId));
    activateProgram(gl, program);
    ring.textures.forEach((target, i) => {
      bindTexture(gl, program, `u_ring${i}`, i, target.texture);
      uniform1f(gl, program, `u_weight${i}`, weights[i] ?? 0);
    });
    this.draw();
  }

  /** `warp`, `blur`, `lut` and `displace`: one or two sampled inputs and a few value uniforms. */
  private encodeSingleInput(
    step: Extract<EncodeStep, { kind: 'warp' | 'blur' | 'lut' | 'displace' }>,
    inputs: WebGLGraphInputs,
    params: WebGLGraphEncodeParams,
  ): void {
    const gl = this.gl;
    const program = this.program(step.nodeId);
    const node = this.graphNode(step.nodeId);
    const source = this.textureFor(step.inputs[0], inputs);
    const field = step.kind === 'displace' ? this.textureFor(step.inputs[1], inputs) : null;
    this.beginPass(this.pool.transient(step.nodeId));
    activateProgram(gl, program);
    bindTexture(gl, program, 'u_source', 0, source);

    if (field) {
      bindTexture(gl, program, 'u_field', 1, field);
      uniform1f(gl, program, 'u_gain', numberParam(node.params.gain, 1));
      uniform1f(gl, program, 'u_sign', node.params.mode === 'forward' ? 1 : -1);
    } else if (step.kind === 'warp') {
      const { viewport } = params.output;
      uniform1f(gl, program, 'u_angleRad', (numberParam(node.params.angleDeg, 0) * Math.PI) / 180);
      uniform1f(gl, program, 'u_scale', numberParam(node.params.scale, 1));
      uniform1f(gl, program, 'u_aspect', viewport.width / viewport.height);
      uniform1f(gl, program, 'u_displace', numberParam(node.params.displace, 0));
    } else if (step.kind === 'blur') {
      const vertical = node.params.axis === 'y';
      uniform1f(gl, program, 'u_axisX', vertical ? 0 : 1);
      uniform1f(gl, program, 'u_axisY', vertical ? 1 : 0);
    } else {
      bindTexture(gl, program, 'u_lut', 1, inputs.profileLut);
      uniform1f(gl, program, 'u_row', numberParam(node.params.row, 0));
      uniform1f(gl, program, 'u_lightDark', rendererStateValue(params.state, 'colorProfileLightDark'));
      uniform1f(gl, program, 'u_avgLuminance', params.state.avgLuminance);
      uniform1f(gl, program, 'u_mixAmount', numberParam(node.params.mixAmount, 1));
    }
    this.draw();
  }

  /**
   * Every pass resolves its textures *before* binding any: resolving one can
   * create it (a pool target on first use, the zero field), and creating a
   * texture binds it on the active unit — which would replace an input the
   * pass had already bound there.
   *
   * The texture a producer node id resolves to: an external source, the
   * ping-pong *read* side for accumulators (the WebGPU executor's parity rule:
   * the compositor composites the previous frame's accumulation), the pooled
   * transient for everything else.
   */
  private textureFor(nodeId: string, inputs: WebGLGraphInputs): WebGLTexture {
    const node = this.graphNode(nodeId);
    if (node.kind === 'source') {
      return node.params.role === 'motion-field'
        ? inputs.motionField ?? this.zeroMotionField()
        : inputs.source.texture;
    }
    if (node.kind === 'decay') return this.pool.pingPong(nodeId).read.texture;
    return this.pool.transient(nodeId).texture;
  }

  private graphNode(nodeId: string) {
    const node = this.frame!.compiled.graph.nodes.find((n) => n.id === nodeId);
    if (!node) throw new Error(`Graph input '${nodeId}' is not a node.`);
    return node;
  }

  /**
   * The multisample renderbuffer a band layer drawing into `target` renders
   * to, or `null` to draw the target itself — MSAA off, or no multisampling
   * for this format on this context.
   */
  private msaaTargetFor(target: RenderTarget): MultisampleTarget | null {
    if (this.sampleCount <= 1) {
      this.releaseMsaa();
      return null;
    }
    const key = `${target.width}x${target.height}@${this.sampleCount}`;
    if (key === this.msaaKey) return this.msaa;
    this.releaseMsaa();
    this.msaaKey = key;
    const samples = supportedSampleCount(this.gl, this.internalFormat, this.sampleCount);
    if (samples > 1) {
      this.msaa = createMultisampleTarget(this.gl, target.width, target.height, samples, this.internalFormat);
    }
    return this.msaa;
  }

  private releaseMsaa(): void {
    if (this.msaa) destroyMultisampleTarget(this.gl, this.msaa);
    this.msaa = null;
    this.msaaKey = null;
  }

  /** Bind `target`, size the viewport to it and, unless the pass overwrites every texel anyway, clear it. */
  private beginPass(target: Pick<RenderTarget, 'framebuffer' | 'width' | 'height'>, clear = true): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    if (clear) {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
  }

  private draw(): void {
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);
  }

  /** 1×1 zero velocity — what a `motion-field` source binds when the lanes have no field. */
  private zeroMotionField(): WebGLTexture {
    if (this.zeroField) return this.zeroField;
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error('Failed to create the zero motion field.');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.zeroField = texture;
    return texture;
  }
}

const numberParam = (value: unknown, fallback: number): number =>
  typeof value === 'number' ? value : fallback;
