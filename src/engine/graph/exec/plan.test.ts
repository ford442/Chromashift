import { describe, expect, it } from 'vitest';
import { TRAILS3_ECHO_ID, buildBlurGraph, buildGraphPreset, buildTrails3Graph, buildWarpGraph } from '../altGraphs';
import { compileGraph, resetGraphCompileCache } from '../compile';
import { buildDefaultGraph, DEFAULT_GRAPH_IDS } from '../defaultGraph';
import { PassGraphError } from '../errors';
import type { PassGraph } from '../types';
import { MOTION_FIELD_SOURCE_ID, withMotionTerm } from '../variants';
import { buildEncodePlan, encodedPassOrder, historyWeights } from './plan';

const compile = (graph: PassGraph) => {
  resetGraphCompileCache();
  return compileGraph(graph, 'webgpu');
};

describe('encode plan — default graph', () => {
  const plan = buildEncodePlan(compile(buildDefaultGraph()));

  it('fuses the coincidence node into its decay consumers', () => {
    // This is the whole pixel-identity argument: `PersistencePass` runs the
    // overlap math once per tracer timescale and has no standalone stamp pass,
    // so the executor must not add one.
    expect([...plan.fused]).toEqual([DEFAULT_GRAPH_IDS.coincidence]);
  });

  it('encodes the five passes the hand encoder encodes, in the same order', () => {
    expect(encodedPassOrder(plan)).toEqual([
      'layer0', 'layer1', 'layer2', 'tracer-below', 'tracer-above', 'composite',
    ]);
  });

  it('gives each decay the coincidence node’s layer inputs', () => {
    const decays = plan.steps.filter((step) => step.kind === 'decay');
    expect(decays).toHaveLength(2);
    for (const decay of decays) {
      if (decay.kind !== 'decay') throw new Error('unreachable');
      expect(decay.stampInputs).toEqual(['layer0', 'layer1', 'layer2']);
    }
    // Roles come from the compositor's input order, not a node param, so a
    // structural-cache hit on an earlier graph of the same shape cannot swap
    // the two timescales.
    expect(decays.map((d) => (d.kind === 'decay' ? d.role : null))).toEqual(['below', 'above']);
  });

  it('splits the blend inputs into layers and the two tracers', () => {
    const blend = plan.steps.find((step) => step.kind === 'blend');
    if (blend?.kind !== 'blend') throw new Error('no blend step');
    expect(blend.layerInputs).toEqual(['layer0', 'layer1', 'layer2']);
    expect(blend.tracerInputs).toEqual(['tracer-below', 'tracer-above']);
  });

  it('names the role textures the renderer’s preview passes read', () => {
    expect(plan.roles).toEqual({
      layers: ['layer0', 'layer1', 'layer2'],
      tracerBelow: 'tracer-below',
      tracerAbove: 'tracer-above',
    });
  });
});

describe('encode plan — non-default shapes', () => {
  it('encodes the blur graph’s two extra passes per layer', () => {
    const plan = buildEncodePlan(compile(buildBlurGraph()));
    // The schedule is a post-order DFS from the output, so the compositor's
    // sharp layer inputs are visited before the blur chain that coincidence
    // reaches — the band layers land first, then the six blur passes.
    expect(encodedPassOrder(plan)).toEqual([
      'layer0', 'layer1', 'layer2',
      'layer0-blur-x', 'layer0-blur-y',
      'layer1-blur-x', 'layer1-blur-y',
      'layer2-blur-x', 'layer2-blur-y',
      'tracer-below', 'tracer-above', 'composite',
    ]);
  });

  it('stamps the blurred layers while the compositor keeps the sharp ones', () => {
    const plan = buildEncodePlan(compile(buildBlurGraph()));
    const decay = plan.steps.find((step) => step.kind === 'decay');
    const blend = plan.steps.find((step) => step.kind === 'blend');
    if (decay?.kind !== 'decay' || blend?.kind !== 'blend') throw new Error('missing steps');
    expect(decay.stampInputs).toEqual(['layer0-blur-y', 'layer1-blur-y', 'layer2-blur-y']);
    expect(blend.layerInputs).toEqual(['layer0', 'layer1', 'layer2']);
  });

  it('reuses one pooled target for the horizontal blur results', () => {
    const compiled = compile(buildBlurGraph());
    // Nine nodes write a layer-class target (3 band layers + 6 blur passes).
    // Each layer's horizontal result dies the instant its vertical pass reads
    // it, so all three share one slot and the pool sizes fewer than nine.
    expect(compiled.allocation.slotsByResolution.layer).toBeLessThan(9);
    const shared = compiled.allocation.slots.filter((slot) => slot.nodes.length > 1);
    expect(shared).toHaveLength(1);
    expect(shared[0].nodes).toEqual(['layer0-blur-x', 'layer1-blur-x', 'layer2-blur-x']);
  });

  it('takes the tracer roles from the compositor\u2019s input order', () => {
    // Swap which accumulator the compositor binds first and the timescales
    // follow. Roles are topology-derived precisely so that a structural-cache
    // hit — which returns the first graph compiled for a shape — cannot serve
    // a stale role and swap the two tracers.
    const base = buildDefaultGraph();
    const swapped: PassGraph = {
      ...base,
      nodes: base.nodes.map((node) => (
        node.id === DEFAULT_GRAPH_IDS.composite
          ? {
            ...node,
            inputs: [
              'layer0', 'layer1', 'layer2',
              DEFAULT_GRAPH_IDS.tracerAbove, DEFAULT_GRAPH_IDS.tracerBelow,
            ],
          }
          : node
      )),
    };
    const plan = buildEncodePlan(compile(swapped));
    // Asserted as a mapping, not a list: reordering the compositor's inputs
    // also reorders the schedule, and it is the id → timescale pairing that
    // matters here.
    const roles = Object.fromEntries(
      plan.steps
        .filter((step) => step.kind === 'decay')
        .map((step) => (step.kind === 'decay' ? [step.nodeId, step.role] : ['', ''])),
    );
    expect(roles).toEqual({
      [DEFAULT_GRAPH_IDS.tracerAbove]: 'below',
      [DEFAULT_GRAPH_IDS.tracerBelow]: 'above',
    });
    expect(plan.roles.tracerBelow).toBe(DEFAULT_GRAPH_IDS.tracerAbove);
  });

  it('routes the warped layer into coincidence only', () => {
    const plan = buildEncodePlan(compile(buildWarpGraph()));
    const warp = plan.steps.find((step) => step.kind === 'warp');
    const decay = plan.steps.find((step) => step.kind === 'decay');
    const blend = plan.steps.find((step) => step.kind === 'blend');
    if (warp?.kind !== 'warp' || decay?.kind !== 'decay' || blend?.kind !== 'blend') {
      throw new Error('missing steps');
    }
    expect(warp.inputs).toEqual(['layer0']);
    expect(decay.stampInputs).toEqual(['layer0-warp', 'layer1', 'layer2']);
    expect(blend.layerInputs).toEqual(['layer0', 'layer1', 'layer2']);
  });
});

describe('encode plan — refusals', () => {
  it('refuses a decay that would stamp the wrong number of inputs', () => {
    // `d1` reads a single band layer instead of a coincidence over all three.
    // The emitted shader unrolls three stamp samplers, so binding one of them
    // is not an option — it is a named refusal.
    const graph: PassGraph = {
      nodes: [
        { id: 'src', kind: 'source', inputs: [], params: {} },
        ...[0, 1, 2].map((i) => ({
          id: `l${i}`,
          kind: 'band-layer' as const,
          inputs: ['src'],
          params: { layerIndex: i, layerCount: 3 },
        })),
        { id: 'coin', kind: 'coincidence', inputs: ['l0', 'l1', 'l2'], params: {} },
        { id: 'd0', kind: 'decay', inputs: ['coin'], params: {} },
        { id: 'd1', kind: 'decay', inputs: ['l0'], params: {} },
        {
          id: 'blend',
          kind: 'blend',
          inputs: ['l0', 'l1', 'l2', 'd0', 'd1'],
          params: { layerInputs: 3 },
        },
        { id: 'out', kind: 'output', inputs: ['blend'], params: {} },
      ],
      output: 'out',
    };

    expect(() => buildEncodePlan(compile(graph))).toThrow(PassGraphError);
    expect(() => buildEncodePlan(compile(graph))).toThrow(/would stamp 1 input/);
  });

  it('refuses a coincidence node that is not absorbed by its decay consumers', () => {
    // `coin` also feeds the compositor, so it needs a pass of its own — and the
    // executor has no history texture to bind its `prevTex` with.
    const base = buildDefaultGraph();
    const graph: PassGraph = {
      ...base,
      nodes: base.nodes.map((node) => (
        node.id === DEFAULT_GRAPH_IDS.composite
          ? {
            ...node,
            inputs: [
              'layer0', 'layer1', DEFAULT_GRAPH_IDS.coincidence,
              DEFAULT_GRAPH_IDS.tracerBelow, DEFAULT_GRAPH_IDS.tracerAbove,
            ],
          }
          : node
      )),
    };
    expect(() => buildEncodePlan(compile(graph))).toThrow(/no history texture/);
  });

  it('refuses a blend whose tracerInputs param disagrees with its edges', () => {
    const base = buildDefaultGraph();
    const graph: PassGraph = {
      ...base,
      nodes: base.nodes.map((node) => (
        node.id === DEFAULT_GRAPH_IDS.composite
          ? { ...node, inputs: [...node.inputs, DEFAULT_GRAPH_IDS.tracerAbove] }
          : node
      )),
    };
    expect(() => buildEncodePlan(compile(graph))).toThrow(/declares tracerInputs 2 but reads 3/);
  });

  it('refuses a blend with fewer than the shipped two tracers', () => {
    const base = buildDefaultGraph();
    const graph: PassGraph = {
      ...base,
      nodes: base.nodes.map((node) => (
        node.id === DEFAULT_GRAPH_IDS.composite
          ? { ...node, inputs: node.inputs.slice(0, -1), params: { ...node.params, tracerInputs: 1 } }
          : node
      )),
    };
    expect(() => compile(graph)).toThrow(/blends at least 2 \(below, above\)/);
  });

  it('refuses a motion term read by anything but an accumulator', () => {
    // Its decay-rate bias acts on the accumulator, so a weighted stamp on its
    // own would have lost half of the term.
    const moving = withMotionTerm(buildDefaultGraph());
    const term = moving.nodes.find((node) => node.kind === 'motion')!;
    const graph: PassGraph = {
      ...moving,
      nodes: moving.nodes.map((node) => (
        node.id === DEFAULT_GRAPH_IDS.composite
          ? { ...node, inputs: [term.id, ...node.inputs.slice(1)] }
          : node
      )),
    };
    expect(() => buildEncodePlan(compile(graph))).toThrow(/temporal term is part of the accumulator pass/);
  });
});

describe('encode plan — the temporal term', () => {
  const plan = buildEncodePlan(compile(withMotionTerm(buildDefaultGraph())));

  it('fuses the motion node and the coincidence it reads into both accumulators', () => {
    expect(plan.fused.has(DEFAULT_GRAPH_IDS.coincidence)).toBe(true);
    expect([...plan.fused].some((id) => id.endsWith('-motion'))).toBe(true);
    expect(encodedPassOrder(plan)).toEqual([
      'layer0', 'layer1', 'layer2', 'tracer-below', 'tracer-above', 'composite',
    ]);
  });

  it('hands each accumulator the stamp layers and the field to weight them by', () => {
    for (const step of plan.steps) {
      if (step.kind !== 'decay') continue;
      expect(step.stampInputs).toEqual(['layer0', 'layer1', 'layer2']);
      expect(step.motionField).toBe(MOTION_FIELD_SOURCE_ID);
    }
    expect(plan.wantsMotionField).toBe(true);
    expect(plan.motionFieldNeedsFlow).toBe(false);
  });

  it('leaves the pre-motion accumulators reading no field', () => {
    const still = buildEncodePlan(compile(buildDefaultGraph()));
    for (const step of still.steps) {
      if (step.kind === 'decay') expect(step.motionField).toBeNull();
    }
  });
});

describe('encode plan — body smear', () => {
  const plan = buildEncodePlan(compile(buildGraphPreset('smear')));

  it('runs history, then displace, then the band layers it feeds', () => {
    expect(encodedPassOrder(plan)).toEqual([
      'smear-history', 'smear-displace',
      'layer0', 'layer1', 'layer2', 'tracer-below', 'tracer-above', 'composite',
    ]);
    expect(plan.steps[0]).toEqual({
      kind: 'history', nodeId: 'smear-history', input: 'source', frames: 4,
    });
    expect(plan.steps[1]).toEqual({
      kind: 'displace', nodeId: 'smear-displace', inputs: ['smear-history', 'motion'],
    });
  });

  it('asks for the motion field only when a source binds it', () => {
    expect(plan.wantsMotionField).toBe(true);
    expect(buildEncodePlan(compile(buildDefaultGraph())).wantsMotionField).toBe(false);
    expect(buildEncodePlan(compile(buildGraphPreset('feedback'))).wantsMotionField).toBe(false);
  });

  it('keeps the band-layer roles the preview passes read', () => {
    expect(plan.roles.layers).toEqual(['layer0', 'layer1', 'layer2']);
    expect(plan.roles.tracerAbove).toBe('tracer-above');
  });
});

describe('historyWeights', () => {
  const sum = (weights: number[]) => weights.reduce((a, b) => a + b, 0);

  it('reads one slot, `delay` frames behind the head, in tap mode', () => {
    // head 1: slot 1 is this frame, slot 0 last frame, slot 3 two frames ago.
    expect(historyWeights(4, 1, 4, { mode: 'tap', delay: 0, falloff: 0 })).toEqual([0, 1, 0, 0]);
    expect(historyWeights(4, 1, 4, { mode: 'tap', delay: 1, falloff: 0 })).toEqual([1, 0, 0, 0]);
    expect(historyWeights(4, 1, 4, { mode: 'tap', delay: 2, falloff: 0 })).toEqual([0, 0, 0, 1]);
  });

  it('never taps a slot the ring has not filled yet', () => {
    // Two frames written: a delay of 3 reads the oldest real one, not black.
    expect(historyWeights(4, 1, 2, { mode: 'tap', delay: 3, falloff: 0 })).toEqual([1, 0, 0, 0]);
  });

  it('decays a trail by age and normalises it', () => {
    const weights = historyWeights(4, 0, 4, { mode: 'trail', delay: 0, falloff: 0.5 });
    // Ages: slot 0 → 0, slot 3 → 1, slot 2 → 2, slot 1 → 3.
    expect(sum(weights)).toBeCloseTo(1, 6);
    expect(weights[0]).toBeGreaterThan(weights[3]);
    expect(weights[3]).toBeGreaterThan(weights[2]);
    expect(weights[2]).toBeGreaterThan(weights[1]);
    expect(weights[3] / weights[0]).toBeCloseTo(0.5, 6);
  });

  it('weights only the filled slots while the ring warms up', () => {
    const weights = historyWeights(8, 1, 2, { mode: 'trail', delay: 0, falloff: 1 });
    expect(weights).toEqual([0.5, 0.5, 0, 0, 0, 0, 0, 0]);
  });

  it('wraps the head around the ring', () => {
    const weights = historyWeights(3, 0, 3, { mode: 'tap', delay: 1, falloff: 0 });
    expect(weights).toEqual([0, 0, 1]);
  });
});

describe('encode plan — a third tracer timescale', () => {
  const plan = buildEncodePlan(compile(buildTrails3Graph()));

  it('accumulates the one stamp three times and blends all three', () => {
    expect(encodedPassOrder(plan)).toEqual([
      'layer0', 'layer1', 'layer2', 'tracer-below', 'tracer-above', TRAILS3_ECHO_ID, 'composite',
    ]);
    const roles = plan.steps.flatMap((step) => (step.kind === 'decay' ? [[step.nodeId, step.role]] : []));
    // The shipped pair keep their roles (the session times them); the third is
    // an extra timescale, timed by its own node.
    expect(roles).toEqual([['tracer-below', 'below'], ['tracer-above', 'above'], [TRAILS3_ECHO_ID, 'extra']]);
    const blend = plan.steps.find((step) => step.kind === 'blend');
    expect(blend?.kind === 'blend' && blend.tracerInputs).toEqual(['tracer-below', 'tracer-above', TRAILS3_ECHO_ID]);
    // The readback roles are still the shipped pair.
    expect(plan.roles.tracerBelow).toBe('tracer-below');
    expect(plan.roles.tracerAbove).toBe('tracer-above');
  });

  it('gives the temporal term to all three accumulators through one motion node', () => {
    const moving = buildEncodePlan(compile(withMotionTerm(buildTrails3Graph())));
    const fields = moving.steps.flatMap((step) => (step.kind === 'decay' ? [step.motionField] : []));
    expect(fields).toEqual([MOTION_FIELD_SOURCE_ID, MOTION_FIELD_SOURCE_ID, MOTION_FIELD_SOURCE_ID]);
  });
});
