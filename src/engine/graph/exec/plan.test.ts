import { describe, expect, it } from 'vitest';
import { buildBlurGraph, buildWarpGraph } from '../altGraphs';
import { compileGraph, resetGraphCompileCache } from '../compile';
import { buildDefaultGraph, DEFAULT_GRAPH_IDS } from '../defaultGraph';
import { PassGraphError } from '../errors';
import type { PassGraph } from '../types';
import { buildEncodePlan, encodedPassOrder } from './plan';

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
        { id: 'd0', kind: 'decay', inputs: ['coin'], params: { role: 'below' } },
        { id: 'd1', kind: 'decay', inputs: ['l0'], params: { role: 'above' } },
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

  it('refuses a blend with more than two tracer inputs', () => {
    const base = buildDefaultGraph();
    const graph: PassGraph = {
      ...base,
      nodes: base.nodes.map((node) => (
        node.id === DEFAULT_GRAPH_IDS.composite
          ? { ...node, inputs: [...node.inputs, DEFAULT_GRAPH_IDS.tracerAbove] }
          : node
      )),
    };
    expect(() => buildEncodePlan(compile(graph))).toThrow(/binds exactly two/);
  });
});
