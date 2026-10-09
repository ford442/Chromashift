import { buildDefaultGraph, DEFAULT_GRAPH_IDS } from './defaultGraph';
import { PassGraphError } from './errors';
import { CANONICAL_LAYER_COUNT } from './layerSpecs';
import { isKnownNodeKind } from './nodeKinds';
import bodySmearStarter from './starters/body-smear.json';
import feedbackWarpStarter from './starters/feedback-warp.json';
import type { GraphNode, ParamValue, PassGraph } from './types';

/**
 * Graph shapes the gate can select by name.
 *
 * These exist to prove the executor is not a second hand-written encoder: each
 * one is a *different shape* — a different pass count, a different schedule, a
 * different pool — and every one of them draws without a line changing in
 * `WebGPUPipelines.ts` or `PersistencePass.ts`.
 */
export const GRAPH_PRESETS = ['default', 'blur', 'warp', 'smear', 'feedback'] as const;
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

/**
 * Starter graphs shipped as JSON (`starters/*.json`), the format a pasted graph
 * or the node editor will use. They are authored for the canonical three bands;
 * the builders above are what scale with the layer count.
 */
export const STARTER_GRAPHS = {
  smear: bodySmearStarter,
  feedback: feedbackWarpStarter,
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isParamValue = (value: unknown): value is ParamValue =>
  typeof value === 'number'
  || typeof value === 'boolean'
  || typeof value === 'string'
  || (Array.isArray(value) && value.every((item) => typeof item === 'number'));

/**
 * Turn untyped JSON into a `PassGraph`, or refuse it.
 *
 * This checks the *shape* only — ids, kinds, inputs and params of the right
 * types. Everything a graph means (arity, edges, cycles, param ranges) is
 * `validateGraph`'s job, so a starter is held to exactly the rules a built
 * graph is. An unknown kind is refused here, by name, as `unsupported-node`.
 */
export function parsePassGraphJson(json: unknown): PassGraph {
  const malformed = (what: string, nodeId: string | null = null): PassGraphError =>
    new PassGraphError('invalid-param', `Malformed graph JSON: ${what}.`, nodeId);

  const graph = isRecord(json) && isRecord(json.graph) ? json.graph : json;
  if (!isRecord(graph)) throw malformed('expected an object');
  if (typeof graph.output !== 'string') throw malformed('`output` must be a node id');
  if (!Array.isArray(graph.nodes)) throw malformed('`nodes` must be an array');

  const nodes = graph.nodes.map((raw, index): GraphNode => {
    if (!isRecord(raw) || typeof raw.id !== 'string') throw malformed(`node ${index} has no string id`);
    const id = raw.id;
    if (typeof raw.kind !== 'string') throw malformed(`node '${id}' has no kind`, id);
    if (!isKnownNodeKind(raw.kind)) {
      throw new PassGraphError(
        'unsupported-node',
        `Unknown node kind '${raw.kind}' (node '${id}').`,
        id,
      );
    }
    const inputs = raw.inputs ?? [];
    if (!Array.isArray(inputs) || !inputs.every((input) => typeof input === 'string')) {
      throw malformed(`node '${id}' inputs must be node ids`, id);
    }
    const params = raw.params ?? {};
    if (!isRecord(params) || !Object.values(params).every(isParamValue)) {
      throw malformed(`node '${id}' params must be numbers, booleans, strings or number arrays`, id);
    }
    return { id, kind: raw.kind, inputs: [...inputs], params: { ...params } as GraphNode['params'] };
  });

  return { nodes, output: graph.output };
}

function buildStarterGraph(name: keyof typeof STARTER_GRAPHS, layerCount: number): PassGraph {
  if (layerCount !== CANONICAL_LAYER_COUNT) {
    throw new PassGraphError(
      'input-arity',
      `The '${name}' starter graph is authored for ${CANONICAL_LAYER_COUNT} colour bands, `
      + `not ${layerCount}.`,
    );
  }
  return parsePassGraphJson(STARTER_GRAPHS[name]);
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
    case 'smear':
    case 'feedback':
      return buildStarterGraph(name, layerCount);
    case 'default':
      return buildDefaultGraph(layerCount);
  }
}
