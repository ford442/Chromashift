import { buildGraphPreset, type GraphPresetName } from './altGraphs';
import type { GraphNode, PassGraph } from './types';

/**
 * The parts of a graph's *structure* a frame decides.
 *
 * A preset names a shape; the session decides how many band layers it has and
 * whether the temporal tracer term is on. Both change emitted code, so each
 * combination is its own compiled graph — cached on the structural hash, so a
 * variant switched back to compiles nothing and builds nothing.
 */
export interface GraphVariant {
  /** Band layers the frame draws. */
  readonly layerCount: number;
  /**
   * The temporal tracer term: a motion mode is selected *and* the motion chore
   * produced a field this frame. With it off the graph has no `motion` node at
   * all, so `motionMode: 'off'` binds the pre-motion program, not an
   * equivalent of it.
   */
  readonly motion: boolean;
}

/** A selected graph shape, built for whichever variant a frame asks for. */
export interface PassGraphSource {
  readonly name: GraphPresetName;
  build(variant: GraphVariant): PassGraph;
}

/** Stable key for a variant, for memoising what is built from it. */
export function graphVariantKey(variant: GraphVariant): string {
  return `${variant.layerCount}:${variant.motion ? 'motion' : 'still'}`;
}

/** The named preset as a source: its shape at the variant's layer count, plus the variant's terms. */
export function presetGraphSource(name: GraphPresetName): PassGraphSource {
  return {
    name,
    build: (variant) => applyGraphVariant(buildGraphPreset(name, variant.layerCount), variant),
  };
}

/** Add the terms a variant switches on to an already-built shape. */
export function applyGraphVariant(graph: PassGraph, variant: GraphVariant): PassGraph {
  return variant.motion ? withMotionTerm(graph) : graph;
}

/** Id of the motion-field source `withMotionTerm` adds when the graph has none. */
export const MOTION_FIELD_SOURCE_ID = 'motion-field';

/**
 * The temporal tracer term, added to a graph.
 *
 * Every `decay` node's stamp is routed through a `motion` node that also reads
 * the motion field: `stamp → motion(stamp, field) → decay`. The executor fuses
 * the `motion` node into each decay pass (see `exec/plan.ts`), so the frame is
 * the hand encoder's motion persistence pass — the same program, uniforms and
 * field — rather than an extra pass.
 *
 * A graph that already reads the motion field (the body-smear starter steers a
 * `displace` with it) keeps its own source; otherwise one is added. A graph
 * with no `decay` has nothing for the term to weight and comes back unchanged.
 */
export function withMotionTerm(graph: PassGraph): PassGraph {
  const decays = graph.nodes.filter((node) => node.kind === 'decay' && node.inputs[0] !== node.id);
  if (decays.length === 0) return graph;

  const taken = new Set(graph.nodes.map((node) => node.id));
  const unique = (base: string): string => {
    let id = base;
    for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
    taken.add(id);
    return id;
  };

  const existingField = graph.nodes.find(
    (node) => node.kind === 'source' && node.params.role === 'motion-field',
  );
  const fieldId = existingField?.id ?? unique(MOTION_FIELD_SOURCE_ID);
  const added: GraphNode[] = existingField
    ? []
    : [{ id: fieldId, kind: 'source', inputs: [], params: { role: 'motion-field' } }];

  // One motion node per stamp, shared by every decay that reads that stamp —
  // the two tracer timescales weight the same stamp by the same field.
  const termFor = new Map<string, string>();
  for (const decay of decays) {
    const stamp = decay.inputs[0];
    if (termFor.has(stamp)) continue;
    const id = unique(`${stamp}-motion`);
    termFor.set(stamp, id);
    added.push({ id, kind: 'motion', inputs: [stamp, fieldId], params: {} });
  }

  return {
    nodes: [
      ...graph.nodes.map((node) => (decays.includes(node)
        ? { ...node, inputs: [termFor.get(node.inputs[0])!] }
        : node)),
      ...added,
    ],
    output: graph.output,
  };
}
