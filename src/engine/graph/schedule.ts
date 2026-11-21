import { isBufferStage, nodeKindSpec, nodeResolution } from './nodeKinds';
import type { ValidationResult } from './validate';
import type {
  BufferElements,
  BufferLayout,
  BufferLifetime,
  GraphNode,
  PassGraph,
  ResolutionClass,
  ScheduledPass,
  TextureLifetime,
} from './types';

/**
 * A buffer-producing node's output, resolved against its params: what the
 * allocator sizes a resource by (an owner), or whose resource it writes in
 * place (an in-place writer).
 */
export type ScheduledBuffer =
  | {
    owns: true;
    layout: BufferLayout;
    stride: number;
    elements: number | { perPixel: ResolutionClass };
    persistent: boolean;
  }
  | { owns: false; input: string };

export interface Schedule {
  passes: ScheduledPass[];
  /** Every scheduled node but the buffer producers, whose outputs are in {@link bufferLifetimes}. */
  lifetimes: TextureLifetime[];
  /** Buffer-producing nodes' outputs. Empty for a graph with none. */
  bufferLifetimes: BufferLifetime[];
  /** Ring length per scheduled `history` node — what the allocator sizes rings by. */
  historyFrames: Record<string, number>;
  /** Per scheduled buffer-producing node, its resolved output (see {@link ScheduledBuffer}). */
  buffers: Record<string, ScheduledBuffer>;
}

/** An element count from the owner's params: its structural param, clamped by validation already. */
function resolveElements(elements: BufferElements, node: GraphNode): number | { perPixel: ResolutionClass } {
  if ('perPixel' in elements) return { perPixel: elements.perPixel };
  const value = node.params[elements.param];
  return typeof value === 'number' ? value : elements.fallback;
}

/**
 * Topologically sort the reachable sub-graph and compute texture lifetimes.
 *
 * Feedback edges are dropped from the ordering (they read the previous frame,
 * so they impose no intra-frame dependency) but still mark their producer as
 * live for the whole frame — a ping-pong texture is never reused mid-frame.
 */
export function scheduleGraph(graph: PassGraph, validation: ValidationResult): Schedule {
  const { byId, reachable, feedbackEdges } = validation;
  const feedback = new Set(feedbackEdges.map((edge) => `${edge.consumer}->${edge.producer}`));

  const order: string[] = [];
  const visited = new Set<string>();
  // Post-order DFS from the output: an input is emitted before its consumer.
  // `next` indices make this iterative, matching validate.ts.
  const stack: { id: string; next: number }[] = [{ id: graph.output, next: 0 }];
  const onStack = new Set<string>([graph.output]);

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    const node = byId.get(frame.id)!;
    if (frame.next >= node.inputs.length) {
      stack.pop();
      onStack.delete(frame.id);
      if (!visited.has(frame.id)) {
        visited.add(frame.id);
        order.push(frame.id);
      }
      continue;
    }
    const inputId = node.inputs[frame.next]!;
    frame.next += 1;
    if (feedback.has(`${frame.id}->${inputId}`)) continue;
    if (visited.has(inputId) || onStack.has(inputId)) continue;
    onStack.add(inputId);
    stack.push({ id: inputId, next: 0 });
  }

  const ordered = hoistBufferChains(order, byId, feedback);

  const passes: ScheduledPass[] = ordered.map((id, i) => {
    const node = byId.get(id)!;
    const inputs: string[] = [];
    const feedbackInputs: string[] = [];
    for (const inputId of node.inputs) {
      if (feedback.has(`${id}->${inputId}`)) feedbackInputs.push(inputId);
      else inputs.push(inputId);
    }
    return { nodeId: id, kind: node.kind, stage: nodeKindSpec(node.kind).stage, order: i, inputs, feedbackInputs };
  });

  const lastUse = new Map<string, number>();
  for (const pass of passes) {
    for (const inputId of pass.inputs) {
      lastUse.set(inputId, Math.max(lastUse.get(inputId) ?? -1, pass.order));
    }
    // A feedback producer stays live for the entire frame — its history texture
    // must survive until the next frame reads it.
    for (const inputId of pass.feedbackInputs) {
      lastUse.set(inputId, passes.length - 1);
    }
  }

  const bufferProducer = (pass: ScheduledPass) => nodeKindSpec(pass.kind).outputType === 'buffer';
  const lifetimes: TextureLifetime[] = passes
    .filter((pass) => reachable.has(pass.nodeId) && !bufferProducer(pass))
    .map((pass) => {
      const spec = nodeKindSpec(pass.kind);
      return {
        nodeId: pass.nodeId,
        resolution: nodeResolution(byId.get(pass.nodeId)!),
        def: pass.order,
        lastUse: lastUse.get(pass.nodeId) ?? pass.order,
        persistent: spec.pingPong,
      };
    });

  const bufferLifetimes: BufferLifetime[] = passes
    .filter((pass) => reachable.has(pass.nodeId) && bufferProducer(pass))
    .map((pass) => ({
      nodeId: pass.nodeId,
      def: pass.order,
      lastUse: lastUse.get(pass.nodeId) ?? pass.order,
    }));

  const historyFrames: Record<string, number> = {};
  for (const pass of passes) {
    const frames = byId.get(pass.nodeId)!.params.frames;
    if (pass.kind === 'history' && typeof frames === 'number') historyFrames[pass.nodeId] = frames;
  }

  const buffers: Record<string, ScheduledBuffer> = {};
  for (const lifetime of bufferLifetimes) {
    const node = byId.get(lifetime.nodeId)!;
    const spec = nodeKindSpec(node.kind).buffer;
    if (!spec) throw new Error(`Node kind '${node.kind}' produces a buffer but declares none.`);
    buffers[node.id] = spec.owns
      ? {
        owns: true,
        layout: spec.layout,
        stride: spec.stride,
        elements: resolveElements(spec.elements, node),
        persistent: spec.persistent,
      }
      : { owns: false, input: node.inputs[0]! };
  }

  return { passes, lifetimes, bufferLifetimes, historyFrames, buffers };
}

/**
 * Pull every buffer chain as early as its inputs allow, in one topological
 * pass over compute and render nodes alike.
 *
 * Any topological order draws the same frame; this one keeps a chain's passes
 * contiguous and ahead of the accumulators, so the frame reads as stages —
 * layers, then `emit` → `advect` → `splat`, then the decays, then the
 * compositor — and the Perf HUD's timestamp markers bracket each stage.
 *
 * A graph with no buffer-chain node comes back in exactly the order the DFS
 * produced: the default graph's schedule, and every breadcrumb and test that
 * names it, are untouched. Otherwise it is Kahn's algorithm, taking the ready
 * node with the lowest (priority, DFS index): chain nodes and `source`s
 * (which encode nothing) first. With equal priorities that reproduces the DFS
 * order, since it is itself topological.
 */
function hoistBufferChains(
  order: readonly string[],
  byId: ReadonlyMap<string, GraphNode>,
  feedback: ReadonlySet<string>,
): string[] {
  const hasChain = order.some((id) => isBufferStage(nodeKindSpec(byId.get(id)!.kind)));
  if (!hasChain) return [...order];

  const index = new Map(order.map((id, i) => [id, i]));
  const priority = (id: string): number => {
    const node = byId.get(id)!;
    return node.kind === 'source' || isBufferStage(nodeKindSpec(node.kind)) ? 0 : 1;
  };
  const pending = new Map<string, number>();
  const consumers = new Map<string, string[]>();
  for (const id of order) {
    const deps = new Set(byId.get(id)!.inputs.filter((input) => !feedback.has(`${id}->${input}`) && index.has(input)));
    pending.set(id, deps.size);
    for (const dep of deps) consumers.set(dep, [...(consumers.get(dep) ?? []), id]);
  }
  const ready = order.filter((id) => pending.get(id) === 0);
  const out: string[] = [];
  while (ready.length > 0) {
    ready.sort((a, b) => priority(a) - priority(b) || index.get(a)! - index.get(b)!);
    const next = ready.shift()!;
    out.push(next);
    for (const consumer of consumers.get(next) ?? []) {
      const left = pending.get(consumer)! - 1;
      pending.set(consumer, left);
      if (left === 0) ready.push(consumer);
    }
  }
  return out;
}

/** Schedule order as node ids — handy in tests and breadcrumbs. */
export function passOrder(schedule: Schedule): string[] {
  return schedule.passes.map((pass) => pass.nodeId);
}
