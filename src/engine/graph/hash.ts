import { nodeKindSpec } from './nodeKinds';
import type { GraphBackend, PassGraph } from './types';

/**
 * Structural hash — covers topology and code-shaping params only. Value params
 * (opacity, decay factor, thresholds) are deliberately excluded so that
 * dragging a slider can never invalidate a compiled pipeline.
 */
export function structuralKey(graph: PassGraph, backend: GraphBackend): string {
  const nodes = [...graph.nodes]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((node) => {
      const spec = nodeKindSpec(node.kind);
      const structural = spec.structuralParams
        .filter((name) => node.params[name] !== undefined)
        .map((name) => `${name}=${JSON.stringify(node.params[name])}`)
        .join(',');
      return `${node.id}:${node.kind}(${node.inputs.join('|')})[${structural}]`;
    });
  return `${backend}#${graph.output}#${nodes.join(';')}`;
}

/** cyrb53 — a fast, well-distributed 53-bit string hash. */
export function structuralHash(graph: PassGraph, backend: GraphBackend): string {
  const key = structuralKey(graph, backend);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < key.length; i += 1) {
    const ch = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}
