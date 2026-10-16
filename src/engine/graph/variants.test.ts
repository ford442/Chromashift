import { beforeEach, describe, expect, it } from 'vitest';
import {
  persistenceFragmentSource,
  persistenceMotionFragmentSource,
} from '../shaders/persistence';
import { buildGraphPreset } from './altGraphs';
import { compileGraph, graphCompileCount, resetGraphCompileCache } from './compile';
import { DEFAULT_GRAPH_IDS, buildDefaultGraph } from './defaultGraph';
import { PassGraphError } from './errors';
import { buildEncodePlan, motionFieldUse } from './exec/plan';
import { PERSIST_MOTION_UNIFORMS, PERSIST_UNIFORMS } from './templates/wgsl';
import type { PassGraph } from './types';
import { validateGraph } from './validate';
import {
  MOTION_FIELD_SOURCE_ID,
  graphVariantKey,
  presetGraphSource,
  withMotionTerm,
} from './variants';

const STILL = { layerCount: 3, motion: false } as const;
const MOVING = { layerCount: 3, motion: true } as const;

const node = (graph: PassGraph, id: string) => graph.nodes.find((n) => n.id === id)!;

describe('withMotionTerm', () => {
  it('routes the stamp through one motion node that both timescales share', () => {
    const graph = withMotionTerm(buildDefaultGraph());
    const terms = graph.nodes.filter((n) => n.kind === 'motion');
    expect(terms).toHaveLength(1);
    expect(terms[0].inputs).toEqual([DEFAULT_GRAPH_IDS.coincidence, MOTION_FIELD_SOURCE_ID]);
    expect(node(graph, DEFAULT_GRAPH_IDS.tracerBelow).inputs).toEqual([terms[0].id]);
    expect(node(graph, DEFAULT_GRAPH_IDS.tracerAbove).inputs).toEqual([terms[0].id]);
    expect(node(graph, MOTION_FIELD_SOURCE_ID)).toMatchObject({ kind: 'source', params: { role: 'motion-field' } });
    expect(() => validateGraph(graph)).not.toThrow();
  });

  it('reuses a motion-field source the graph already reads', () => {
    const smear = buildGraphPreset('smear');
    const existing = smear.nodes.filter((n) => n.kind === 'source' && n.params.role === 'motion-field');
    expect(existing).toHaveLength(1);
    const graph = withMotionTerm(smear);
    const fields = graph.nodes.filter((n) => n.kind === 'source' && n.params.role === 'motion-field');
    expect(fields.map((n) => n.id)).toEqual([existing[0].id]);
    expect(graph.nodes.find((n) => n.kind === 'motion')!.inputs[1]).toBe(existing[0].id);
  });

  it('leaves a graph with no accumulator alone', () => {
    const graph: PassGraph = {
      nodes: [
        { id: 'src', kind: 'source', inputs: [], params: {} },
        { id: 'out', kind: 'output', inputs: ['src'], params: {} },
      ],
      output: 'out',
    };
    expect(withMotionTerm(graph)).toBe(graph);
  });

  it('applies to every shipped shape', () => {
    for (const name of ['default', 'blur', 'warp', 'smear', 'feedback'] as const) {
      const compiled = compileGraph(presetGraphSource(name).build(MOVING), 'webgpu');
      const plan = buildEncodePlan(compiled);
      const decays = plan.steps.filter((step) => step.kind === 'decay');
      expect(decays, name).toHaveLength(2);
      for (const decay of decays) expect(decay.motionField, name).not.toBeNull();
    }
  });
});

describe('the motion field is a source, checked by role', () => {
  it('refuses a motion node whose field is not a motion-field source', () => {
    const graph = withMotionTerm(buildDefaultGraph());
    const term = graph.nodes.find((n) => n.kind === 'motion')!;
    term.inputs = [term.inputs[0], DEFAULT_GRAPH_IDS.layer(0)];
    expect(() => validateGraph(graph)).toThrow(PassGraphError);
    expect(() => validateGraph(graph)).toThrow(/must read a 'source' node with role 'motion-field'/);
  });
});

describe('graph variants', () => {
  beforeEach(() => resetGraphCompileCache());

  it('the still variant is the preset itself, so adopting it compiles nothing new', () => {
    const source = presetGraphSource('default');
    const first = compileGraph(buildGraphPreset('default'), 'webgpu');
    const count = graphCompileCount();
    expect(compileGraph(source.build(STILL), 'webgpu')).toBe(first);
    expect(graphCompileCount()).toBe(count);
  });

  it('off is the pre-motion program; on is its motion twin, nothing else', () => {
    const source = presetGraphSource('default');
    const still = compileGraph(source.build(STILL), 'webgpu');
    const moving = compileGraph(source.build(MOVING), 'webgpu');
    expect(moving.hash).not.toBe(still.hash);

    const decaysOf = (compiled: typeof still) => compiled.emitted.filter((pass) => pass.kind === 'decay');
    // `graph/__golden__/coincidence-decay.wgsl` pins the still source; the
    // motion variant is the same template with the term switched on.
    for (const pass of decaysOf(still)) {
      expect(pass.fragment).toBe(persistenceFragmentSource);
      expect(pass.uniformLayout).toBe(PERSIST_UNIFORMS);
      expect(pass.textureBindings).not.toContain('motion');
    }
    for (const pass of decaysOf(moving)) {
      expect(pass.fragment).toBe(persistenceMotionFragmentSource);
      expect(pass.uniformLayout).toBe(PERSIST_MOTION_UNIFORMS);
      expect(pass.textureBindings.at(-1)).toBe('motion');
    }
    // Every other pass is untouched by the term.
    const others = (compiled: typeof still) => compiled.emitted
      .filter((pass) => pass.kind !== 'decay' && pass.kind !== 'motion' && pass.kind !== 'source')
      .map((pass) => [pass.nodeId, pass.fragment]);
    expect(others(moving)).toEqual(others(still));
  });

  it('the motion term encodes no pass of its own', () => {
    const plan = buildEncodePlan(compileGraph(presetGraphSource('default').build(MOVING), 'webgpu'));
    expect(plan.steps.map((step) => step.nodeId)).toEqual([
      'layer0', 'layer1', 'layer2', 'tracer-below', 'tracer-above', 'composite',
    ]);
    expect(plan.wantsMotionField).toBe(true);
  });

  it('keys variants by what they change', () => {
    expect(graphVariantKey(STILL)).not.toBe(graphVariantKey(MOVING));
    expect(graphVariantKey({ layerCount: 5, motion: false })).not.toBe(graphVariantKey(STILL));
  });
});

describe('motionFieldUse', () => {
  it('says when the chore must run, and when it must solve flow', () => {
    const use = (name: 'default' | 'smear', motion: boolean) =>
      motionFieldUse(compileGraph(presetGraphSource(name).build({ layerCount: 3, motion }), 'webgpu'));
    expect(use('default', false)).toEqual({ reads: false, needsFlow: false });
    // The temporal term reads the field but needs flow only for `direction` —
    // the renderer's call, from the motion mode.
    expect(use('default', true)).toEqual({ reads: true, needsFlow: false });
    // The smear steers a `displace` by the velocity, whatever the mode.
    expect(use('smear', false)).toEqual({ reads: true, needsFlow: true });
  });
});
