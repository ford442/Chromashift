import { PassGraphError } from './errors';
import { isKnownNodeKind, nodeKindSpec } from './nodeKinds';
import type { GraphNode, PassGraph } from './types';

/** An edge that closes a cycle — legal only when its producer ping-pongs. */
export interface FeedbackEdge {
  /** Node that consumes the previous frame's value. */
  consumer: string;
  /** Node whose previous-frame output is read. Must be a ping-pong kind. */
  producer: string;
}

export interface ValidationResult {
  /** Nodes reachable from `graph.output`, in no particular order. */
  reachable: Set<string>;
  feedbackEdges: FeedbackEdge[];
  byId: Map<string, GraphNode>;
}

/**
 * Validate a graph: unique ids, resolvable edges, arity, edge types, and
 * fixed-point detection. Cycles are legal, but only when the edge that closes
 * them reads a ping-pong node's output — the ping-pong pair is what makes that
 * read return the previous frame instead of a half-written target.
 */
export function validateGraph(graph: PassGraph): ValidationResult {
  const byId = new Map<string, GraphNode>();
  for (const node of graph.nodes) {
    if (byId.has(node.id)) {
      throw new PassGraphError('duplicate-node', `Duplicate node id '${node.id}'.`, node.id);
    }
    if (!isKnownNodeKind(node.kind)) {
      throw new PassGraphError(
        'unsupported-node',
        `Unknown node kind '${node.kind}' (node '${node.id}').`,
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
    if (node.inputs.length < spec.minInputs || node.inputs.length > spec.maxInputs) {
      const max = spec.maxInputs === Number.POSITIVE_INFINITY ? '∞' : String(spec.maxInputs);
      throw new PassGraphError(
        'input-arity',
        `Node '${node.id}' (${node.kind}) takes ${spec.minInputs}–${max} inputs, got ${node.inputs.length}.`,
        node.id,
      );
    }
    for (const inputId of node.inputs) {
      const producer = byId.get(inputId);
      if (!producer) {
        throw new PassGraphError(
          'unknown-input',
          `Node '${node.id}' reads unknown node '${inputId}'.`,
          node.id,
        );
      }
      if (inputId === node.id && !spec.pingPong) {
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
      if (producerType !== spec.inputType) {
        throw new PassGraphError(
          'edge-type',
          `Node '${node.id}' expects ${spec.inputType} inputs but '${inputId}' produces ${producerType}.`,
          node.id,
        );
      }
    }
  }

  const { reachable, feedbackEdges } = walk(graph, byId);
  return { reachable, feedbackEdges, byId };
}

type Colour = 'grey' | 'black';

function walk(graph: PassGraph, byId: Map<string, GraphNode>): {
  reachable: Set<string>;
  feedbackEdges: FeedbackEdge[];
} {
  const colour = new Map<string, Colour>();
  const reachable = new Set<string>();
  const feedbackEdges: FeedbackEdge[] = [];

  // Iterative DFS over input edges, so a deep graph cannot blow the stack.
  const stack: { id: string; next: number }[] = [{ id: graph.output, next: 0 }];
  colour.set(graph.output, 'grey');
  reachable.add(graph.output);

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const node = byId.get(frame.id)!;
    if (frame.next >= node.inputs.length) {
      colour.set(frame.id, 'black');
      stack.pop();
      continue;
    }
    const inputId = node.inputs[frame.next];
    frame.next += 1;
    const state = colour.get(inputId);
    if (state === 'grey') {
      // Back edge: `inputId` transitively depends on `node`, so this read has
      // to come from the previous frame. Only a ping-pong producer can serve
      // one — it keeps last frame's texture while this frame writes the other.
      const producer = byId.get(inputId)!;
      if (!nodeKindSpec(producer.kind).pingPong) {
        throw new PassGraphError(
          'illegal-cycle',
          `Cycle '${node.id}' → '${inputId}' (${producer.kind}) has no ping-pong node to break it.`,
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
