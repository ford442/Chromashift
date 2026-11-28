/**
 * Pass-graph IR — the declarative description the renderers compile instead of
 * a pipeline they hard-code. See docs/PASS_GRAPH.md.
 *
 * Nothing in this file knows about WebGPU or WebGL; the backend-specific parts
 * live in `templates/` (shader emission) and `capabilities.ts` (what each
 * backend can emit).
 */

import type { CanvasPresentation } from '../gpu/gpuOptions';
import type { UniformLayout } from './templates/uniformLayout';

/** Backends a graph can be compiled for. */
export type GraphBackend = 'webgpu' | 'webgl';

/**
 * What flows along an edge: a texture (every render pass's input and output),
 * a GPU buffer (what a compute stage writes and the passes after it read), or
 * a scalar.
 */
export type EdgeType = 'texture' | 'scalar' | 'buffer';

/**
 * Where a node's work runs. Every kind before the particle chain is `render`:
 * a fullscreen fragment pass that reads textures and writes one. A `compute`
 * node is encoded as a compute pass in the same command encoder as the render
 * passes around it, so it costs no extra submit.
 */
export type NodeStage = 'render' | 'compute';

/**
 * How a node reads a buffer input. `vertex`: as instance-stepped vertex
 * attributes, which every device can do. `storage`: bound as a storage buffer
 * in the pass's shaders — in a *render* node that means fragment-stage storage,
 * which a compatibility-mode device may withhold (`fragment-storage`).
 */
export type BufferAccess = 'vertex' | 'storage';

/**
 * How many elements a buffer holds: a structural param of the node that owns
 * it (resolved at compile time, so it is part of the structural hash), or one
 * per pixel of a resolution class (resolved when the pool knows the frame's
 * size).
 */
export type BufferElements =
  | { readonly param: string; readonly fallback: number; readonly min: number; readonly max: number }
  | { readonly perPixel: ResolutionClass };

/**
 * `plain`: an array of elements. `append`: an array plus a control block — an
 * `atomic<u32>` head a compute stage appends at, and the indirect dispatch and
 * draw arguments derived from it — so the passes after it run over the live
 * count without the CPU ever reading it back.
 */
export type BufferLayout = 'plain' | 'append';

/** The buffer a buffer-producing node kind writes. */
export type BufferOutputSpec =
  | {
    /** The node allocates the buffer. */
    readonly owns: true;
    readonly layout: BufferLayout;
    /** Bytes per element. */
    readonly stride: number;
    readonly elements: BufferElements;
    /** True when the contents outlive the frame (particles do); never pooled then. */
    readonly persistent: boolean;
  }
  | {
    /**
     * The node updates its first input's buffer in place, and its output *is*
     * that buffer: `advect` moves the particles `emit` appended.
     */
    readonly owns: false;
  };

/**
 * Resolution classes. The renderer allocates layer-scaled and tracer-scaled
 * targets at different sizes (`layerScale` / `tracerScale`), so a texture can
 * only be pooled with another texture of the same class.
 */
export type ResolutionClass = 'source' | 'layer' | 'tracer' | 'output';

export type NodeKind =
  | 'source'        // externally supplied texture: `role` 'image' (default) or 'motion-field'
  | 'band-layer'    // luminance→colour band isolation, rotation, flip
  | 'lut'           // colorProfile 256×3 LUT sample
  | 'coincidence'   // N-input overlap detection (generalises today's persistence stamp)
  | 'motion'        // the temporal tracer term: [stamp, motion field] → a motion-weighted stamp
  | 'decay'         // ping-pong accumulator with a per-frame multiplier
  | 'blend'         // alpha / add / subtract / multiply / screen
  | 'warp'          // UV transform: rotate, scale, feedback displacement
  | 'blur'          // separable gaussian
  | 'history'       // N-frame delay line: a ring of textures that outlives the frame
  | 'displace'      // warp UVs by a field texture (motion field or colour-as-flow)
  | 'emit'          // compute: append particles where layers coincide, into a fixed-capacity ring
  | 'advect'        // compute: move particles along the motion field + curl noise, age and kill them
  | 'splat'         // render: one instanced quad per particle, additive, into a tracer-res target
  | 'output';       // swapchain

export type ParamValue = number | boolean | string | readonly number[];

export interface GraphNode {
  id: string;
  kind: NodeKind;
  inputs: string[];
  params: Record<string, ParamValue>;
}

export interface PassGraph {
  nodes: GraphNode[];
  /** Id of the node whose result reaches the swapchain. Must be an `output` node. */
  output: string;
}

/** Static description of one node kind — arity, edge types, codegen inputs. */
export interface NodeKindSpec {
  kind: NodeKind;
  /** Inclusive input-count bounds. `Infinity` for variadic kinds. */
  minInputs: number;
  maxInputs: number;
  /** Edge type every input must carry, unless {@link inputTypes} names it per position. */
  inputType: EdgeType;
  /**
   * Edge type per input position, for kinds whose inputs differ (`advect`
   * reads `[particles, motion field]`). Positions past the end use
   * {@link inputType}.
   */
  inputTypes?: readonly EdgeType[];
  /** Edge type this node produces; `null` for terminal nodes (`output`). */
  outputType: EdgeType | null;
  /** Resolution class of this node's render target. */
  resolution: ResolutionClass;
  /** True when the node reads its own previous-frame result (ping-pong pair). */
  pingPong: boolean;
  /**
   * Params that change *emitted code* rather than uniform values. The structural
   * hash covers these and nothing else, so a parameter tweak never recompiles.
   */
  structuralParams: readonly string[];
  /** Render pass or compute pass. */
  stage: NodeStage;
  /** `@workgroup_size` of a compute node's kernels; absent for render nodes. */
  workgroup?: readonly [number, number, number];
  /** The buffer a node whose `outputType` is `buffer` writes. */
  buffer?: BufferOutputSpec;
  /** How the node reads its buffer inputs, when it has any. */
  bufferAccess?: BufferAccess;
}

/** One scheduled pass — render or compute — in execution order. */
export interface ScheduledPass {
  nodeId: string;
  kind: NodeKind;
  stage: NodeStage;
  /** Position in the topological order. */
  order: number;
  /** Input node ids, excluding feedback edges (those read the ping-pong history). */
  inputs: string[];
  /** Input node ids reached through a feedback (back) edge. */
  feedbackInputs: string[];
}

/** Half-open [def, lastUse] interval over the scheduled pass order. */
export interface TextureLifetime {
  nodeId: string;
  resolution: ResolutionClass;
  /** Pass index that writes the texture. */
  def: number;
  /** Last pass index that reads it; equals `def` when nothing reads it. */
  lastUse: number;
  /** Ping-pong nodes hold two textures across frames and are never pooled. */
  persistent: boolean;
}

/** A pooled render target shared by every node whose lifetime maps to it. */
export interface PoolSlot {
  id: string;
  resolution: ResolutionClass;
  /** Node ids that write this slot, in schedule order. */
  nodes: string[];
}

/**
 * The ring of textures a `history` node keeps across frames. Never pooled:
 * every slot holds a frame some later frame will read, exactly as a ping-pong
 * pair does — just `frames` of them instead of two.
 */
export interface HistoryRing {
  id: string;
  nodeId: string;
  resolution: ResolutionClass;
  /** Ring length; also the texture count. Bounded to 2–8 by validation. */
  frames: number;
}

/** Half-open [def, lastUse] interval of one buffer-producing node's output. */
export interface BufferLifetime {
  nodeId: string;
  def: number;
  lastUse: number;
}

/**
 * One GPU buffer resource: the element array, plus — for an `append` buffer —
 * its control block. Created lazily by the executor's buffer pool, so a plan
 * with no buffers allocates none.
 */
export interface BufferResource {
  id: string;
  /** The node that owns (allocates) it. */
  owner: string;
  /** Every node whose output is this buffer: the owner, then in-place writers, in schedule order. */
  nodes: string[];
  layout: BufferLayout;
  stride: number;
  /** Element count, or one per pixel of a resolution class. */
  elements: number | { perPixel: ResolutionClass };
  /** Survives the frame (and is never pooled). */
  persistent: boolean;
  /** Bytes of the control block: 0 for `plain`. */
  controlBytes: number;
}

export interface AllocationPlan {
  slots: PoolSlot[];
  /** `history` rings, one per node. Their textures are counted here, not in `slots`. */
  rings: HistoryRing[];
  /**
   * Buffer resources. Empty for every graph without a buffer-producing node,
   * the default graph included.
   */
  buffers: BufferResource[];
  /** node id → pool slot id (or a dedicated persistent/ external slot id, or a buffer resource id). */
  assignment: Record<string, string>;
  lifetimes: TextureLifetime[];
  /** Slot count per resolution class — the VRAM proxy the budget test asserts on. */
  slotsByResolution: Record<ResolutionClass, number>;
}

/** A compute node's module and the kernels it dispatches, in order. */
export interface EmittedCompute {
  module: string;
  entryPoints: readonly string[];
  workgroup: readonly [number, number, number];
}

/** Shader source emitted for one pass. */
export interface EmittedPass {
  nodeId: string;
  kind: NodeKind;
  /** Fragment shader source for the compile target backend; `''` for a compute node. */
  fragment: string;
  /** A compute node's kernels. Absent for every render pass. */
  compute?: EmittedCompute;
  /**
   * A render pass that draws its own geometry (`splat`): its vertex module.
   * Absent for the fullscreen passes, which share the fullscreen vertex stage.
   */
  vertex?: string;
  /** Texture binding names in binding order, for the renderer to wire up. */
  textureBindings: string[];
  /**
   * The uniform block `fragment` declares — the layout its struct was emitted
   * from — or `null` when it has none of its own (`band-layer` keeps the
   * shipped layer pipeline's buffers; passes with no shader have nothing).
   * WebGPU only: the GLSL emitters bind uniforms by name.
   */
  uniformLayout: UniformLayout | null;
  /**
   * For a pass that writes the canvas: the presentation it encodes for, which
   * also picks its target format. Absent for every pass that writes the pool.
   */
  presentation?: CanvasPresentation;
  /**
   * `history` in `loop` mode: `fragment` is the mixing write into the ring
   * head, and there is no taps pass or ring-write blit. Absent otherwise.
   */
  historyLoop?: true;
}

/**
 * What the rest of the renderer reads out of a graph, by what it is — the
 * inspect views, the readbacks, the exports and the stationary previews. Node
 * ids; the executor resolves them to this frame's textures.
 */
export interface GraphOutputs {
  /** The pass whose result reaches the swapchain (the `blend`), or `null`. */
  composite: string | null;
  /** `band-layer` nodes, in `layerIndex` order. */
  layers: string[];
  /**
   * The accumulators, in the compositor's input order: the shipped below /
   * above pair first, then any extra timescales. Schedule order for a graph
   * whose accumulators reach no compositor.
   */
  tracers: string[];
  /** The accumulator whose stamp diagnostic the readbacks sample (the `above` tracer). */
  diagnostic: string | null;
}

export interface CompiledGraph {
  backend: GraphBackend;
  /** Structural hash — the cache key. Identical topology ⇒ identical hash. */
  hash: string;
  graph: PassGraph;
  passes: ScheduledPass[];
  allocation: AllocationPlan;
  emitted: EmittedPass[];
  /** Number of `band-layer` nodes, i.e. the colour-band count this graph renders. */
  layerCount: number;
  outputs: GraphOutputs;
}
