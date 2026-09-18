import { CANONICAL_LAYER_COUNT } from './layerSpecs';
import type { GraphNode, PassGraph } from './types';

/** Stable node ids the renderers and tests refer to. */
export const DEFAULT_GRAPH_IDS = {
  source: 'source',
  layer: (index: number) => `layer${index}`,
  coincidence: 'coincidence',
  tracerBelow: 'tracer-below',
  tracerAbove: 'tracer-above',
  composite: 'composite',
  output: 'swapchain',
} as const;

/**
 * The shipped pipeline, expressed as a graph.
 *
 * ```
 *            ┌─ band-layer 0 ─┐
 *  source ───┼─ band-layer 1 ─┼─┬─► coincidence ─┬─► decay (below) ─┐
 *            └─ band-layer 2 ─┘ │                └─► decay (above) ─┤
 *                               └──────────────────────────────────┴─► blend ─► output
 * ```
 *
 * `buildDefaultGraph()` with no argument reproduces today's 5-pass pipeline
 * exactly — same band table, same pass order, same shaders (see
 * `shaderParity.test.ts`). Pass a different count and every stage scales with
 * it; nothing downstream reads a literal 3.
 */
export function buildDefaultGraph(layerCount: number = CANONICAL_LAYER_COUNT): PassGraph {
  if (!Number.isInteger(layerCount) || layerCount < 1) {
    throw new RangeError(`layerCount must be a positive integer, got ${layerCount}.`);
  }

  const layerIds = Array.from({ length: layerCount }, (_, i) => DEFAULT_GRAPH_IDS.layer(i));

  const nodes: GraphNode[] = [
    { id: DEFAULT_GRAPH_IDS.source, kind: 'source', inputs: [], params: {} },
    ...layerIds.map((id, index) => ({
      id,
      kind: 'band-layer' as const,
      inputs: [DEFAULT_GRAPH_IDS.source],
      params: { layerIndex: index, layerCount, angleDeg: 0, flipX: false, flipY: false },
    })),
    {
      id: DEFAULT_GRAPH_IDS.coincidence,
      kind: 'coincidence',
      inputs: layerIds,
      // Two overlapping layers are enough to stamp a tracer; the diagnostic
      // target is the second render target the persistence pass already writes.
      params: { minOverlap: 2, emitDiagnostic: true, colorThresh: 0.05, stampBoost: 1.8 },
    },
    {
      id: DEFAULT_GRAPH_IDS.tracerBelow,
      kind: 'decay',
      inputs: [DEFAULT_GRAPH_IDS.coincidence],
      // `role` names which tracer timescale the executor feeds this
      // accumulator from. It is a value param, not a structural one, so adding
      // it leaves the structural hash — and the compile cache — untouched.
      params: { durationMs: 0, role: 'below' },
    },
    {
      id: DEFAULT_GRAPH_IDS.tracerAbove,
      kind: 'decay',
      inputs: [DEFAULT_GRAPH_IDS.coincidence],
      params: { durationMs: 1000, role: 'above' },
    },
    {
      id: DEFAULT_GRAPH_IDS.composite,
      kind: 'blend',
      inputs: [...layerIds, DEFAULT_GRAPH_IDS.tracerBelow, DEFAULT_GRAPH_IDS.tracerAbove],
      params: { layerInputs: layerCount, tracerInputs: 2 },
    },
    {
      id: DEFAULT_GRAPH_IDS.output,
      kind: 'output',
      inputs: [DEFAULT_GRAPH_IDS.composite],
      params: {},
    },
  ];

  return { nodes, output: DEFAULT_GRAPH_IDS.output };
}

/** The default graph's layer count — the one remaining "how many bands" literal. */
export const DEFAULT_LAYER_COUNT = CANONICAL_LAYER_COUNT;
