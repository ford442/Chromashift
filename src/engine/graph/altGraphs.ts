import { buildDefaultGraph, DEFAULT_GRAPH_IDS } from './defaultGraph';
import { PassGraphError } from './errors';
import { CANONICAL_LAYER_COUNT } from './layerSpecs';
import type { GraphNode, PassGraph } from './types';

/**
 * Graph shapes the gate can select by name.
 *
 * These exist to prove the executor is not a second hand-written encoder: each
 * one is a *different shape* — a different pass count, a different schedule, a
 * different pool — and every one of them draws without a line changing in
 * `WebGPUPipelines.ts` or `PersistencePass.ts`.
 */
export const GRAPH_PRESETS = ['default', 'blur', 'warp'] as const;
export type GraphPresetName = (typeof GRAPH_PRESETS)[number];

export function isGraphPresetName(value: string): value is GraphPresetName {
  return (GRAPH_PRESETS as readonly string[]).includes(value);
}

const withoutId = (nodes: GraphNode[], id: string): GraphNode[] =>
  nodes.filter((node) => node.id !== id);

const requireNode = (graph: PassGraph, id: string): GraphNode => {
  const node = graph.nodes.find((candidate) => candidate.id === id);
  if (!node) throw new PassGraphError('unknown-input', `No node '${id}' in the graph.`, id);
  return node;
};

/**
 * Blur before persistence.
 *
 * Each band layer runs through a separable gaussian (horizontal, then vertical)
 * and the *blurred* layers feed coincidence, while the compositor keeps the
 * sharp ones. Tracers get soft, spreading edges; the live layers stay crisp.
 *
 * The two blur passes per layer are the case the transient pool was built for:
 * the horizontal result dies the moment the vertical pass reads it, so the
 * allocator hands the same target back out instead of sizing 2N of them.
 */
export function buildBlurGraph(
  layerCount: number = CANONICAL_LAYER_COUNT,
  radius = 3,
): PassGraph {
  const base = buildDefaultGraph(layerCount);
  const coincidence = requireNode(base, DEFAULT_GRAPH_IDS.coincidence);
  const layerIds = Array.from({ length: layerCount }, (_, i) => DEFAULT_GRAPH_IDS.layer(i));

  const blurNodes: GraphNode[] = [];
  const blurredIds: string[] = [];
  for (const layerId of layerIds) {
    const horizontal = `${layerId}-blur-x`;
    const vertical = `${layerId}-blur-y`;
    blurNodes.push(
      { id: horizontal, kind: 'blur', inputs: [layerId], params: { radius, axis: 'x' } },
      { id: vertical, kind: 'blur', inputs: [horizontal], params: { radius, axis: 'y' } },
    );
    blurredIds.push(vertical);
  }

  return {
    nodes: [
      ...withoutId(base.nodes, coincidence.id),
      ...blurNodes,
      { ...coincidence, inputs: blurredIds },
    ],
    output: base.output,
  };
}

/**
 * An affine warp on one band layer.
 *
 * Layer 0 is rotated and scaled before it reaches coincidence, so the tracer
 * stamps where the warped layer overlaps the other two — a look that is a
 * fifteen-line graph here and was a fork of the layer pass before.
 */
export function buildWarpGraph(
  layerCount: number = CANONICAL_LAYER_COUNT,
  options: { warpedLayer?: number; angleDeg?: number; scale?: number } = {},
): PassGraph {
  const base = buildDefaultGraph(layerCount);
  const index = options.warpedLayer ?? 0;
  const layerId = DEFAULT_GRAPH_IDS.layer(index);
  requireNode(base, layerId);
  const coincidence = requireNode(base, DEFAULT_GRAPH_IDS.coincidence);
  const warpId = `${layerId}-warp`;

  return {
    nodes: [
      ...withoutId(base.nodes, coincidence.id),
      {
        id: warpId,
        kind: 'warp',
        inputs: [layerId],
        params: {
          mode: 'affine',
          angleDeg: options.angleDeg ?? 12,
          scale: options.scale ?? 1.08,
          displace: 0,
        },
      },
      {
        ...coincidence,
        inputs: coincidence.inputs.map((id) => (id === layerId ? warpId : id)),
      },
    ],
    output: base.output,
  };
}

/** Build a named preset for `layerCount` colour bands. */
export function buildGraphPreset(
  name: GraphPresetName,
  layerCount: number = CANONICAL_LAYER_COUNT,
): PassGraph {
  switch (name) {
    case 'blur':
      return buildBlurGraph(layerCount);
    case 'warp':
      return buildWarpGraph(layerCount);
    case 'default':
      return buildDefaultGraph(layerCount);
  }
}
