import { nodeKindSpec } from './nodeKinds';
import type { ValidationResult } from './validate';
import type { PassGraph, ScheduledPass, TextureLifetime } from './types';

export interface Schedule {
  passes: ScheduledPass[];
  lifetimes: TextureLifetime[];
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
    const frame = stack[stack.length - 1];
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
    const inputId = node.inputs[frame.next];
    frame.next += 1;
    if (feedback.has(`${frame.id}->${inputId}`)) continue;
    if (visited.has(inputId) || onStack.has(inputId)) continue;
    onStack.add(inputId);
    stack.push({ id: inputId, next: 0 });
  }

  const indexOf = new Map<string, number>();
  order.forEach((id, i) => indexOf.set(id, i));

  const passes: ScheduledPass[] = order.map((id, i) => {
    const node = byId.get(id)!;
    const inputs: string[] = [];
    const feedbackInputs: string[] = [];
    for (const inputId of node.inputs) {
      if (feedback.has(`${id}->${inputId}`)) feedbackInputs.push(inputId);
      else inputs.push(inputId);
    }
    return { nodeId: id, kind: node.kind, order: i, inputs, feedbackInputs };
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

  const lifetimes: TextureLifetime[] = passes
    .filter((pass) => reachable.has(pass.nodeId))
    .map((pass) => {
      const spec = nodeKindSpec(pass.kind);
      return {
        nodeId: pass.nodeId,
        resolution: spec.resolution,
        def: pass.order,
        lastUse: lastUse.get(pass.nodeId) ?? pass.order,
        persistent: spec.pingPong,
      };
    });

  return { passes, lifetimes };
}

/** Schedule order as node ids — handy in tests and breadcrumbs. */
export function passOrder(schedule: Schedule): string[] {
  return schedule.passes.map((pass) => pass.nodeId);
}
