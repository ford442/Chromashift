/**
 * Pass-graph IR — the declarative description the renderers compile instead of
 * a pipeline they hard-code. See docs/PASS_GRAPH.md.
 *
 * Nothing in this file knows about WebGPU or WebGL; the backend-specific parts
 * live in `templates/` (shader emission) and `capabilities.ts` (what each
 * backend can emit).
 */

import type { CanvasPresentation } from '../gpuOptions';
import type { UniformLayout } from './templates/uniformLayout';

/** Backends a graph can be compiled for. */
export type GraphBackend = 'webgpu' | 'webgl';

/** What flows along an edge. Only textures are schedulable render-pass inputs. */
export type EdgeType = 'texture' | 'scalar';

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
  /** Edge type every input must carry. */
  inputType: EdgeType;
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
}

/** One scheduled render pass, in execution order. */
export interface ScheduledPass {
  nodeId: string;
  kind: NodeKind;
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

export interface AllocationPlan {
  slots: PoolSlot[];
  /** `history` rings, one per node. Their textures are counted here, not in `slots`. */
  rings: HistoryRing[];
  /** node id → pool slot id (or a dedicated persistent/ external slot id). */
  assignment: Record<string, string>;
  lifetimes: TextureLifetime[];
  /** Slot count per resolution class — the VRAM proxy the budget test asserts on. */
  slotsByResolution: Record<ResolutionClass, number>;
}

/** Shader source emitted for one pass. */
export interface EmittedPass {
  nodeId: string;
  kind: NodeKind;
  /** Fragment shader source for the compile target backend. */
  fragment: string;
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
