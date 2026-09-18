import { PassGraphError } from '../errors';
import type { CompiledGraph, GraphNode, NodeKind } from '../types';

/** One encodable step, with every input already resolved to a producer node id. */
export type EncodeStep =
  | {
    kind: 'band-layer';
    nodeId: string;
    /** Row of the band table this pass isolates — selects the state slice too. */
    layerIndex: number;
    source: string;
  }
  | {
    kind: 'decay';
    nodeId: string;
    /**
     * Textures the fused coincidence stamp reads. When a `coincidence` node is
     * absorbed into this pass these are *its* inputs, which is what makes the
     * default graph byte-identical to the hand encoder.
     */
    stampInputs: string[];
    /**
     * Which tracer timescale this accumulator is — picks its state uniforms.
     *
     * Derived from the compositor's input order, never from a node param:
     * `compileGraph` memoises on a structural hash and returns the *first*
     * graph compiled for a topology, so any value param read here could be a
     * stale one from an earlier graph of the same shape. Topology cannot be
     * stale — it is what the hash covers.
     */
    role: 'below' | 'above';
  }
  | {
    kind: 'blend';
    nodeId: string;
    layerInputs: string[];
    tracerInputs: string[];
  }
  | {
    kind: 'warp' | 'blur' | 'lut';
    nodeId: string;
    inputs: string[];
  };

/** Node ids playing the roles the renderer's ancillary passes still need. */
export interface GraphRoles {
  /** `band-layer` node ids in `layerIndex` order. */
  layers: string[];
  tracerBelow: string | null;
  tracerAbove: string | null;
}

export interface EncodePlan {
  steps: EncodeStep[];
  /** `coincidence` nodes whose pass their `decay` consumers absorbed. */
  fused: Set<string>;
  roles: GraphRoles;
  layerCount: number;
}

const intParam = (node: GraphNode, name: string, fallback: number): number =>
  typeof node.params[name] === 'number' ? (node.params[name] as number) : fallback;

/**
 * Turn a `CompiledGraph` into encodable steps.
 *
 * This is the half of the executor that has nothing to do with WebGPU: which
 * passes run, in what order, reading which producers. Keeping it here means the
 * fusion rule below — the one thing that has to match the hand-written encoder
 * exactly — is checked by a unit test rather than by a screenshot.
 *
 * **Fusion.** The compiler emits one fused coincidence+decay shader for both
 * kinds, because that is what shipped: `PersistencePass` runs the overlap math
 * twice, once per tracer timescale, and there is no standalone stamp pass. So a
 * `coincidence` node read *only* by `decay` nodes emits no pass of its own and
 * each consumer inherits its inputs. A `coincidence` read by anything else
 * keeps its own pass.
 */
export function buildEncodePlan(compiled: CompiledGraph): EncodePlan {
  const byId = new Map(compiled.graph.nodes.map((node) => [node.id, node]));
  const scheduled = new Set(compiled.passes.map((pass) => pass.nodeId));

  // Consumers, excluding feedback edges: those read the previous frame and so
  // cannot make a producer's pass necessary this frame.
  const consumers = new Map<string, NodeKind[]>();
  for (const pass of compiled.passes) {
    for (const inputId of pass.inputs) {
      consumers.set(inputId, [...(consumers.get(inputId) ?? []), pass.kind]);
    }
  }

  const fused = new Set<string>();
  for (const pass of compiled.passes) {
    if (pass.kind !== 'coincidence') continue;
    const kinds = consumers.get(pass.nodeId) ?? [];
    if (kinds.length > 0 && kinds.every((kind) => kind === 'decay')) fused.add(pass.nodeId);
  }

  const layerNodes = compiled.graph.nodes
    .filter((node) => node.kind === 'band-layer' && scheduled.has(node.id))
    .sort((a, b) => intParam(a, 'layerIndex', 0) - intParam(b, 'layerIndex', 0));

  const decayNodes = compiled.passes.filter((pass) => pass.kind === 'decay');

  // The compositor binds its two tracer textures as (below, above), so its
  // input order is what names the timescales. A graph whose accumulators do not
  // reach a blend falls back to schedule order.
  const blendPass = compiled.passes.find((pass) => pass.kind === 'blend');
  const blendNode = blendPass ? byId.get(blendPass.nodeId) : undefined;
  const tracerOrder = blendNode
    ? blendPass!.inputs.slice(intParam(blendNode, 'layerInputs', compiled.layerCount))
    : [];
  const roleOf = (nodeId: string, index: number): 'below' | 'above' => {
    const position = tracerOrder.indexOf(nodeId);
    if (position >= 0) return position === 0 ? 'below' : 'above';
    return index === 0 ? 'below' : 'above';
  };

  const steps: EncodeStep[] = [];
  for (const pass of compiled.passes) {
    // Neither owns a pass: a source binds an externally supplied texture and an
    // output names the target the last pass already wrote. Compared explicitly
    // rather than via a set so the switch below narrows to the drawable kinds.
    if (pass.kind === 'source' || pass.kind === 'output') continue;
    if (pass.kind === 'coincidence' && fused.has(pass.nodeId)) continue;
    const node = byId.get(pass.nodeId)!;

    // A `coincidence` node that is *not* absorbed by decay consumers would need
    // a history texture of its own to bind the emitted shader's `prevTex`, and
    // its pooled slot is shared with other nodes. Refused, with the node named,
    // rather than aliased into a read-and-write of the same target.
    if (pass.kind === 'coincidence') {
      throw new PassGraphError(
        'unsupported-node',
        `Node '${pass.nodeId}' (coincidence) is read by something other than a `
        + 'decay node, so it needs a pass of its own — which the executor has no '
        + 'history texture for. Feed it only to decay nodes.',
        pass.nodeId,
      );
    }

    switch (pass.kind) {
      case 'band-layer':
        steps.push({
          kind: 'band-layer',
          nodeId: pass.nodeId,
          layerIndex: intParam(node, 'layerIndex', 0),
          source: pass.inputs[0],
        });
        break;

      case 'decay': {
        const producerId = pass.inputs[0];
        const stampInputs = fused.has(producerId)
          ? byId.get(producerId)!.inputs
          : pass.inputs;
        // The emitted shader unrolls exactly `layerCount` stamp samplers, so a
        // decay reading a different number of textures is a refusal, not a
        // best-effort bind of whatever happens to be available.
        if (stampInputs.length !== compiled.layerCount) {
          throw new PassGraphError(
            'input-arity',
            `Node '${pass.nodeId}' (decay) would stamp ${stampInputs.length} `
            + `input(s), but its shader is emitted for ${compiled.layerCount}. `
            + 'A decay must read a coincidence node over every band layer.',
            pass.nodeId,
          );
        }
        steps.push({
          kind: 'decay',
          nodeId: pass.nodeId,
          stampInputs: [...stampInputs],
          role: roleOf(pass.nodeId, decayNodes.findIndex((d) => d.nodeId === pass.nodeId)),
        });
        break;
      }

      case 'blend': {
        const layerInputs = intParam(node, 'layerInputs', compiled.layerCount);
        const tracerInputs = pass.inputs.slice(layerInputs);
        if (tracerInputs.length !== 2) {
          throw new PassGraphError(
            'input-arity',
            `Node '${pass.nodeId}' (blend) has ${tracerInputs.length} tracer input(s); `
            + 'the compositor template binds exactly two (below, above).',
            pass.nodeId,
          );
        }
        steps.push({
          kind: 'blend',
          nodeId: pass.nodeId,
          layerInputs: pass.inputs.slice(0, layerInputs),
          tracerInputs,
        });
        break;
      }

      default:
        steps.push({ kind: pass.kind, nodeId: pass.nodeId, inputs: [...pass.inputs] });
        break;
    }
  }

  const tracerRole = (index: 0 | 1): string | null =>
    tracerOrder[index] ?? decayNodes[index]?.nodeId ?? null;

  return {
    steps,
    fused,
    roles: {
      layers: layerNodes.map((node) => node.id),
      tracerBelow: tracerRole(0),
      tracerAbove: tracerRole(1),
    },
    layerCount: compiled.layerCount,
  };
}

/** Node ids the plan actually encodes, in order — the executor's breadcrumb. */
export function encodedPassOrder(plan: EncodePlan): string[] {
  return plan.steps.map((step) => step.nodeId);
}
