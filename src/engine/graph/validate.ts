import type { DeviceCapability } from './capabilities';
import { PassGraphError } from './errors';
import {
  HISTORY_MAX_FRAMES,
  HISTORY_MIN_FRAMES,
  PARTICLE_CAPACITY_MAX,
  PARTICLE_CAPACITY_MIN,
  inputEdgeType,
  isHistoryLoop,
  isKnownNodeKind,
  nodeArity,
  nodeKindSpec,
} from './nodeKinds';
import type { GraphNode, PassGraph } from './types';

/**
 * An edge that reads a previous frame's value: a back edge into a ping-pong
 * node, or any read of a `loop` history (its previous ring slot).
 */
export interface FeedbackEdge {
  /** Node that consumes the previous frame's value. */
  consumer: string;
  /** Node whose previous-frame output is read: a ping-pong kind or a `loop` history. */
  producer: string;
}

export interface ValidationResult {
  /** Nodes reachable from `graph.output`, in no particular order. */
  reachable: Set<string>;
  feedbackEdges: FeedbackEdge[];
  byId: Map<string, GraphNode>;
}

export interface ValidateOptions {
  /**
   * What the device grants. When given, a graph that needs anything else — a
   * buffer edge into a render node that binds it as fragment storage, say —
   * is an `unsupported-capability` refusal naming the node. Omitted (the
   * compiler's own call), only the structure is checked: the compiled graph
   * is cached per topology, not per device.
   */
  granted?: ReadonlySet<DeviceCapability>;
}

/**
 * Validate a graph: unique ids, resolvable edges, arity, edge types, and
 * fixed-point detection. Cycles are legal, but only when the edge that closes
 * them reads a ping-pong node's output — the ping-pong pair is what makes that
 * read return the previous frame instead of a half-written target — or a
 * `loop` history's, whose every read is the ring slot a previous frame wrote.
 */
export function validateGraph(graph: PassGraph, options: ValidateOptions = {}): ValidationResult {
  const byId = new Map<string, GraphNode>();
  for (const node of graph.nodes) {
    if (byId.has(node.id)) {
      throw new PassGraphError('duplicate-node', `Duplicate node id '${node.id}'.`, node.id);
    }
    if (!isKnownNodeKind(node.kind)) {
      throw new PassGraphError(
        'unsupported-node',
        `Unknown node kind '${String((node as { kind: unknown }).kind)}' (node '${node.id}').`,
        node.id,
      );
    }
    byId.set(node.id, node);
  }

  const outputNode = byId.get(graph.output);
  if (!outputNode) {
    throw new PassGraphError('missing-output', `Graph output '${graph.output}' is not a node.`);
  }
  if (outputNode.kind !== 'output') {
    throw new PassGraphError(
      'output-kind',
      `Graph output '${graph.output}' must be an 'output' node, got '${outputNode.kind}'.`,
      graph.output,
    );
  }

  for (const node of graph.nodes) {
    const spec = nodeKindSpec(node.kind);
    // Checked before arity, which it decides. Structural: a trail and a loop
    // are different graphs, with different hashes, never a uniform flip.
    if (node.kind === 'history' && node.params.loop !== undefined && typeof node.params.loop !== 'boolean') {
      throw new PassGraphError(
        'invalid-param',
        `Node '${node.id}' (history) has loop ${JSON.stringify(node.params.loop)}; expected true or false.`,
        node.id,
      );
    }
    const arity = nodeArity(node);
    if (node.inputs.length < arity.min || node.inputs.length > arity.max) {
      const max = arity.max === Number.POSITIVE_INFINITY ? '∞' : String(arity.max);
      throw new PassGraphError(
        'input-arity',
        `Node '${node.id}' (${node.kind}${isHistoryLoop(node) ? ', loop' : ''}) takes ${arity.min}–${max} inputs, got ${node.inputs.length}.`,
        node.id,
      );
    }
    for (const [position, inputId] of node.inputs.entries()) {
      const producer = byId.get(inputId);
      if (!producer) {
        throw new PassGraphError(
          'unknown-input',
          `Node '${node.id}' reads unknown node '${inputId}'.`,
          node.id,
        );
      }
      // A loop history may read itself: that read is its previous slot, like
      // every other read of it.
      if (inputId === node.id && !spec.pingPong && !isHistoryLoop(node)) {
        throw new PassGraphError(
          'self-reference',
          `Node '${node.id}' (${node.kind}) reads itself, but '${node.kind}' has no ping-pong history.`,
          node.id,
        );
      }
      const producerType = nodeKindSpec(producer.kind).outputType;
      if (producerType === null) {
        throw new PassGraphError(
          'edge-type',
          `Node '${node.id}' reads '${inputId}' (${producer.kind}), which produces no value.`,
          node.id,
        );
      }
      const expected = inputEdgeType(spec, position);
      if (producerType !== expected) {
        throw new PassGraphError(
          'edge-type',
          spec.inputTypes
            ? `Node '${node.id}' (${node.kind}) expects a ${expected} at input ${position} but '${inputId}' produces ${producerType}.`
            : `Node '${node.id}' expects ${expected} inputs but '${inputId}' produces ${producerType}.`,
          node.id,
        );
      }
    }
    validateParams(node);
    if (node.kind === 'motion' || node.kind === 'advect') validateMotionField(node, byId);
  }

  const { reachable, feedbackEdges } = walk(graph, byId);
  if (options.granted) {
    const missing = bufferEdgeNeeds(graph).find(({ need }) => !options.granted!.has(need));
    if (missing) {
      throw new PassGraphError(
        'unsupported-capability',
        `Node '${missing.nodeId}' reads a buffer as fragment-stage storage, which this device does not grant ('${missing.need}').`,
        missing.nodeId,
      );
    }
  }
  return { reachable, feedbackEdges, byId };
}

/**
 * What a graph's buffer edges need from the device, per consuming node.
 *
 * A compute node binds storage buffers in a compute stage, which every
 * WebGPU device — compatibility mode included — allows. A *render* node that
 * binds a buffer input as storage puts it in a fragment (or vertex) stage,
 * which a compatibility-mode device may withhold: that edge needs
 * `fragment-storage`. One that reads it as instance attributes (`splat`)
 * needs nothing.
 */
export function bufferEdgeNeeds(graph: { nodes: readonly GraphNode[] }): { nodeId: string; need: DeviceCapability }[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const needs: { nodeId: string; need: DeviceCapability }[] = [];
  for (const node of graph.nodes) {
    const spec = nodeKindSpec(node.kind);
    if (spec.stage !== 'render' || spec.bufferAccess !== 'storage') continue;
    const readsBuffer = node.inputs.some((id) => {
      const producer = byId.get(id);
      return producer !== undefined && nodeKindSpec(producer.kind).outputType === 'buffer';
    });
    if (readsBuffer) needs.push({ nodeId: node.id, need: 'fragment-storage' });
  }
  return needs;
}

/**
 * Structural params that select emitted code or a binding. A typo here would
 * otherwise fall through to a default and quietly draw something else.
 */
function validateParams(node: GraphNode): void {
  const oneOf = (name: string, allowed: readonly string[], fallback: string): void => {
    const value = node.params[name] ?? fallback;
    if (typeof value !== 'string' || !allowed.includes(value)) {
      throw new PassGraphError(
        'invalid-param',
        `Node '${node.id}' (${node.kind}) has ${name} ${JSON.stringify(value)}; `
        + `expected one of ${allowed.map((v) => `'${v}'`).join(', ')}.`,
        node.id,
      );
    }
  };

  switch (node.kind) {
    case 'source':
      oneOf('role', ['image', 'motion-field'], 'image');
      break;
    case 'history': {
      const frames = node.params.frames;
      if (
        typeof frames !== 'number'
        || !Number.isInteger(frames)
        || frames < HISTORY_MIN_FRAMES
        || frames > HISTORY_MAX_FRAMES
      ) {
        throw new PassGraphError(
          'invalid-param',
          `Node '${node.id}' (history) has frames ${JSON.stringify(frames)}; `
          + `expected an integer from ${HISTORY_MIN_FRAMES} to ${HISTORY_MAX_FRAMES}.`,
          node.id,
        );
      }
      oneOf('resolution', ['layer', 'tracer'], 'layer');
      break;
    }
    case 'displace':
      oneOf('field', ['motion', 'color'], 'motion');
      break;
    case 'output':
      oneOf('presentation', ['sdr', 'hdr-extended'], 'sdr');
      break;
    case 'emit': {
      // The ring's size is the chain's VRAM; an unbounded one is refused.
      const capacity = node.params.capacity;
      if (
        capacity !== undefined
        && (typeof capacity !== 'number'
          || !Number.isInteger(capacity)
          || capacity < PARTICLE_CAPACITY_MIN
          || capacity > PARTICLE_CAPACITY_MAX)
      ) {
        throw new PassGraphError(
          'invalid-param',
          `Node '${node.id}' (emit) has capacity ${JSON.stringify(capacity)}; `
          + `expected an integer from ${PARTICLE_CAPACITY_MIN} to ${PARTICLE_CAPACITY_MAX}.`,
          node.id,
        );
      }
      break;
    }
    default:
      break;
  }
}

/**
 * A `motion` (or `advect`) node's second input is the field it weights the
 * stamp by (or moves the particles along), and the executor binds that by the
 * producer's `role`. Anything else in that slot would bind an arbitrary
 * texture as velocities, so it is refused by name.
 */
function validateMotionField(node: GraphNode, byId: Map<string, GraphNode>): void {
  const field = byId.get(node.inputs[1]!)!;
  if (field.kind !== 'source' || field.params.role !== 'motion-field') {
    throw new PassGraphError(
      'edge-type',
      `Node '${node.id}' (${node.kind}) reads '${field.id}' (${field.kind}) as its field; `
      + "it must read a 'source' node with role 'motion-field'.",
      node.id,
    );
  }
}

type Colour = 'grey' | 'black';

function walk(graph: PassGraph, byId: Map<string, GraphNode>): {
  reachable: Set<string>;
  feedbackEdges: FeedbackEdge[];
} {
  const colour = new Map<string, Colour>();
  const reachable = new Set<string>();
  const feedbackEdges: FeedbackEdge[] = [];

  // `loop` histories reached only through their previous-slot edges. Each is
  // walked as a root of its own once the current walk is done: its inputs are
  // this frame's, so they must not be on the stack of the node reading it, or
  // the edge that feeds the loop would look like a second back edge.
  const loopRoots: string[] = [];

  // Iterative DFS over input edges, so a deep graph cannot blow the stack.
  const stack: { id: string; next: number }[] = [{ id: graph.output, next: 0 }];
  colour.set(graph.output, 'grey');
  reachable.add(graph.output);

  while (stack.length > 0 || loopRoots.length > 0) {
    if (stack.length === 0) {
      const root = loopRoots.shift()!;
      if (colour.has(root)) continue;
      colour.set(root, 'grey');
      stack.push({ id: root, next: 0 });
      continue;
    }
    const frame = stack[stack.length - 1]!;
    const node = byId.get(frame.id)!;
    if (frame.next >= node.inputs.length) {
      colour.set(frame.id, 'black');
      stack.pop();
      continue;
    }
    const inputId = node.inputs[frame.next]!;
    frame.next += 1;
    const producer = byId.get(inputId)!;
    if (isHistoryLoop(producer)) {
      // A previous-slot edge, wherever the walk meets it: the ring slot a
      // previous frame wrote, never the one this frame's write fills. It
      // imposes no order this frame, so it is feedback whether or not it
      // closes a cycle — which is what lets `warp → history(loop) → warp`
      // be written in either direction.
      feedbackEdges.push({ consumer: node.id, producer: inputId });
      reachable.add(inputId);
      if (!colour.has(inputId)) loopRoots.push(inputId);
      continue;
    }
    const state = colour.get(inputId);
    if (state === 'grey') {
      // Back edge: `inputId` transitively depends on `node`, so this read has
      // to come from the previous frame. Only a ping-pong producer can serve
      // one — it keeps last frame's texture while this frame writes the other.
      if (!nodeKindSpec(producer.kind).pingPong) {
        throw new PassGraphError(
          'illegal-cycle',
          `Cycle '${node.id}' → '${inputId}' (${producer.kind}) has no ping-pong node or loop history to break it.`,
          node.id,
        );
      }
      feedbackEdges.push({ consumer: node.id, producer: inputId });
      continue;
    }
    if (state === 'black') continue;
    colour.set(inputId, 'grey');
    reachable.add(inputId);
    stack.push({ id: inputId, next: 0 });
  }

  return { reachable, feedbackEdges };
}
