import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_GRAPH_IDS,
  PassGraphError,
  allocateTextures,
  buildDefaultGraph,
  buildGraphPreset,
  buildLayerSpecs,
  compileGraph,
  estimateVram,
  graphCompileCount,
  parsePassGraphJson,
  passOrder,
  resetGraphCompileCache,
  ringTexturesByResolution,
  scheduleGraph,
  sharedSlots,
  structuralHash,
  structuralKey,
  supportedNodeKinds,
  validateGraph,
} from './index';
import {
  emitBlurWgsl,
  emitDisplaceWgsl,
  emitHistoryTapsWgsl,
  emitHistoryWriteWgsl,
  emitWarpWgsl,
} from './templates/wgsl';
import type { GraphNode, PassGraph, ResolutionClass } from './types';

const node = (
  id: string,
  kind: GraphNode['kind'],
  inputs: string[] = [],
  params: GraphNode['params'] = {},
): GraphNode => ({ id, kind, inputs, params });

const graphOf = (nodes: GraphNode[], output: string): PassGraph => ({ nodes, output });

const plan = (graph: PassGraph) => allocateTextures(scheduleGraph(graph, validateGraph(graph)));

beforeEach(() => {
  resetGraphCompileCache();
});

describe('validation', () => {
  it('accepts the default graph', () => {
    const validation = validateGraph(buildDefaultGraph());
    expect(validation.feedbackEdges).toEqual([]);
    expect(validation.reachable.size).toBe(buildDefaultGraph().nodes.length);
  });

  it('rejects duplicate node ids', () => {
    const graph = graphOf(
      [node('a', 'source'), node('a', 'source'), node('out', 'output', ['a'])],
      'out',
    );
    expect(() => validateGraph(graph)).toThrow(
      expect.objectContaining({ code: 'duplicate-node' }),
    );
  });

  it('rejects an edge to a node that does not exist', () => {
    const graph = graphOf([node('out', 'output', ['ghost'])], 'out');
    expect(() => validateGraph(graph)).toThrow(
      expect.objectContaining({ code: 'unknown-input', nodeId: 'out' }),
    );
  });

  it('rejects a node with too few inputs for its kind', () => {
    const graph = graphOf(
      [node('src', 'source'), node('b', 'blend', ['src']), node('out', 'output', ['b'])],
      'out',
    );
    expect(() => validateGraph(graph)).toThrow(
      expect.objectContaining({ code: 'input-arity', nodeId: 'b' }),
    );
  });

  it('rejects reading a node that produces no value', () => {
    const graph = graphOf(
      [
        node('src', 'source'),
        node('terminal', 'output', ['src']),
        node('blur', 'blur', ['terminal']),
        node('out', 'output', ['blur']),
      ],
      'out',
    );
    expect(() => validateGraph(graph)).toThrow(
      expect.objectContaining({ code: 'edge-type', nodeId: 'blur' }),
    );
  });

  it('requires the graph output to be an output node', () => {
    const graph = graphOf([node('src', 'source')], 'src');
    expect(() => validateGraph(graph)).toThrow(
      expect.objectContaining({ code: 'output-kind' }),
    );
  });

  it('treats a decay self-loop as a legal feedback edge', () => {
    const graph = graphOf(
      [node('d', 'decay', ['d']), node('out', 'output', ['d'])],
      'out',
    );
    const validation = validateGraph(graph);
    expect(validation.feedbackEdges).toEqual([{ consumer: 'd', producer: 'd' }]);
  });

  it('routes a fixed point through the ping-pong node that breaks it', () => {
    // warp → decay → warp: legal, because the decay reads the previous frame.
    const graph = graphOf(
      [
        node('src', 'source'),
        node('w', 'warp', ['d']),
        node('d', 'decay', ['w']),
        node('out', 'output', ['d']),
      ],
      'out',
    );
    const validation = validateGraph(graph);
    expect(validation.feedbackEdges).toEqual([{ consumer: 'w', producer: 'd' }]);
  });

  it('refuses a cycle with no ping-pong node to break it', () => {
    const graph = graphOf(
      [
        node('a', 'blur', ['b']),
        node('b', 'blur', ['a']),
        node('out', 'output', ['a']),
      ],
      'out',
    );
    expect(() => validateGraph(graph)).toThrow(
      expect.objectContaining({ code: 'illegal-cycle' }),
    );
  });

  it('refuses a self-reference on a kind without ping-pong history', () => {
    const graph = graphOf([node('b', 'blur', ['b']), node('out', 'output', ['b'])], 'out');
    expect(() => validateGraph(graph)).toThrow(
      expect.objectContaining({ code: 'self-reference', nodeId: 'b' }),
    );
  });
});

describe('scheduling', () => {
  it('emits every input before its consumer', () => {
    const graph = buildDefaultGraph();
    const order = passOrder(scheduleGraph(graph, validateGraph(graph)));
    const at = (id: string) => order.indexOf(id);

    expect(at(DEFAULT_GRAPH_IDS.source)).toBeLessThan(at(DEFAULT_GRAPH_IDS.layer(0)));
    for (let i = 0; i < 3; i += 1) {
      expect(at(DEFAULT_GRAPH_IDS.layer(i))).toBeLessThan(at(DEFAULT_GRAPH_IDS.coincidence));
    }
    expect(at(DEFAULT_GRAPH_IDS.coincidence)).toBeLessThan(at(DEFAULT_GRAPH_IDS.tracerBelow));
    expect(at(DEFAULT_GRAPH_IDS.coincidence)).toBeLessThan(at(DEFAULT_GRAPH_IDS.tracerAbove));
    expect(at(DEFAULT_GRAPH_IDS.tracerAbove)).toBeLessThan(at(DEFAULT_GRAPH_IDS.composite));
    expect(at(DEFAULT_GRAPH_IDS.composite)).toBeLessThan(at(DEFAULT_GRAPH_IDS.output));
  });

  it('does not let a feedback edge impose an intra-frame ordering', () => {
    const graph = graphOf(
      [
        node('src', 'source'),
        node('w', 'warp', ['d']),
        node('d', 'decay', ['w']),
        node('out', 'output', ['d']),
      ],
      'out',
    );
    const schedule = scheduleGraph(graph, validateGraph(graph));
    const order = passOrder(schedule);
    // The back edge is dropped, so `w` still runs before `d` this frame.
    expect(order.indexOf('w')).toBeLessThan(order.indexOf('d'));
  });

  it('keeps a texture live until its last reader', () => {
    const graph = buildDefaultGraph();
    const schedule = scheduleGraph(graph, validateGraph(graph));
    const order = passOrder(schedule);
    const lifetime = schedule.lifetimes.find(
      (l) => l.nodeId === DEFAULT_GRAPH_IDS.layer(0),
    )!;
    // Layer 0 feeds both the coincidence pass and the compositor.
    expect(lifetime.lastUse).toBe(order.indexOf(DEFAULT_GRAPH_IDS.composite));
  });

  it('marks decay nodes persistent so they survive the frame boundary', () => {
    const graph = buildDefaultGraph();
    const schedule = scheduleGraph(graph, validateGraph(graph));
    const persistent = schedule.lifetimes.filter((l) => l.persistent).map((l) => l.nodeId);
    expect(persistent.sort()).toEqual(
      [DEFAULT_GRAPH_IDS.tracerAbove, DEFAULT_GRAPH_IDS.tracerBelow].sort(),
    );
  });
});

describe('transient texture pool', () => {
  it('gives the default graph one slot per layer plus three tracer slots', () => {
    const allocation = plan(buildDefaultGraph());
    // 3 layer targets, 1 transient coincidence stamp, 2 ping-pong tracers.
    expect(allocation.slotsByResolution.layer).toBe(3);
    expect(allocation.slotsByResolution.tracer).toBe(3);
    // The compositor renders straight to the swapchain, so it owns no slot —
    // the same as the hand-written pipeline.
    expect(allocation.slotsByResolution.output).toBe(0);
    expect(allocation.assignment[DEFAULT_GRAPH_IDS.composite]).toBe('swapchain');
    expect(allocation.assignment[DEFAULT_GRAPH_IDS.source]).toBe('external');
  });

  it('gives a ping-pong node its history slot even when it writes the output', () => {
    // `consumers` is built from non-feedback inputs, so the swapchain shortcut
    // cannot see that a decay node reads its own previous frame. Without the
    // persistent check running first, `d` would lose its history pair.
    const graph = graphOf(
      [node('src', 'source'), node('d', 'decay', ['src']), node('out', 'output', ['d'])],
      'out',
    );
    const allocation = plan(graph);
    expect(allocation.assignment.d).toBe('persist:d');
    expect(allocation.slotsByResolution.tracer).toBe(1);
  });

  it('reuses one slot across non-overlapping lifetimes', () => {
    // A chain of blurs: each result dies as soon as the next pass reads it, so
    // the whole chain needs two targets, not four.
    const graph = graphOf(
      [
        node('src', 'source'),
        node('b0', 'blur', ['src'], { radius: 1 }),
        node('b1', 'blur', ['b0'], { radius: 1 }),
        node('b2', 'blur', ['b1'], { radius: 1 }),
        node('b3', 'blur', ['b2'], { radius: 1 }),
        node('out', 'output', ['b3']),
      ],
      'out',
    );
    const allocation = plan(graph);
    expect(allocation.slotsByResolution.layer).toBe(2);
    expect(sharedSlots(allocation).length).toBeGreaterThan(0);
  });

  it('keeps default-graph VRAM at or below the hand-written pipeline', () => {
    const sizes: Record<ResolutionClass, { width: number; height: number; bytesPerPixel: number }> = {
      source: { width: 1920, height: 1080, bytesPerPixel: 8 },
      layer: { width: 1920, height: 1080, bytesPerPixel: 8 },
      tracer: { width: 1920, height: 1080, bytesPerPixel: 8 },
      output: { width: 1920, height: 1080, bytesPerPixel: 8 },
    };
    const px = 1920 * 1080 * 8;
    // Today: 3 layer textures + 2 above + 2 below ping-pong tracers, and the
    // compositor writes the swapchain. The pool adds one transient stamp target
    // in place of the fragment path's implicit per-duration recomputation.
    const handWritten = 7 * px;
    expect(estimateVram(plan(buildDefaultGraph()), sizes)).toBeLessThanOrEqual(handWritten + px);
  });
});

describe('compilation cache', () => {
  it('compiles once per topology and reuses the result', () => {
    const before = graphCompileCount();
    const first = compileGraph(buildDefaultGraph(), 'webgpu');
    expect(graphCompileCount()).toBe(before + 1);

    const second = compileGraph(buildDefaultGraph(), 'webgpu');
    expect(second).toBe(first);
    expect(graphCompileCount()).toBe(before + 1);
  });

  it('does not recompile when only a parameter value changes', () => {
    compileGraph(buildDefaultGraph(), 'webgpu');
    const count = graphCompileCount();

    const tweaked = buildDefaultGraph();
    const decay = tweaked.nodes.find((n) => n.id === DEFAULT_GRAPH_IDS.tracerAbove)!;
    decay.params.durationMs = 4200;
    const coincidence = tweaked.nodes.find((n) => n.id === DEFAULT_GRAPH_IDS.coincidence)!;
    coincidence.params.colorThresh = 0.42;
    coincidence.params.stampBoost = 3.5;

    compileGraph(tweaked, 'webgpu');
    expect(graphCompileCount()).toBe(count);
  });

  it('recompiles when the topology changes', () => {
    compileGraph(buildDefaultGraph(3), 'webgpu');
    const count = graphCompileCount();
    compileGraph(buildDefaultGraph(5), 'webgpu');
    expect(graphCompileCount()).toBe(count + 1);
  });

  it('keys the cache per backend', () => {
    const graph = buildDefaultGraph();
    expect(structuralHash(graph, 'webgpu')).not.toBe(structuralHash(graph, 'webgl'));
    compileGraph(graph, 'webgpu');
    const count = graphCompileCount();
    compileGraph(graph, 'webgl');
    expect(graphCompileCount()).toBe(count + 1);
  });
});

describe('backend capabilities', () => {
  it('lists warp, blur, history and displace as WebGPU-only', () => {
    const webgpuOnly = ['warp', 'blur', 'history', 'displace'] as const;
    expect(supportedNodeKinds('webgpu')).toEqual(expect.arrayContaining([...webgpuOnly]));
    for (const kind of webgpuOnly) expect(supportedNodeKinds('webgl')).not.toContain(kind);
  });

  it('refuses an unsupported node on WebGL, naming it', () => {
    const graph = graphOf(
      [
        node('src', 'source'),
        node('soften', 'blur', ['src'], { radius: 3 }),
        node('out', 'output', ['soften']),
      ],
      'out',
    );
    expect(() => compileGraph(graph, 'webgl')).toThrow(PassGraphError);
    try {
      compileGraph(graph, 'webgl');
    } catch (error) {
      const failure = error as PassGraphError;
      expect(failure.code).toBe('unsupported-node');
      expect(failure.nodeId).toBe('soften');
      expect(failure.message).toContain("'blur'");
      expect(failure.message).toContain("'soften'");
    }
    // ...and compiles happily for WebGPU.
    expect(compileGraph(graph, 'webgpu').emitted.some((p) => p.kind === 'blur')).toBe(true);
  });

  it('ignores an unsupported node that the output cannot reach', () => {
    const graph = buildDefaultGraph();
    graph.nodes.push(node('orphan', 'blur', [DEFAULT_GRAPH_IDS.source], { radius: 2 }));
    expect(() => compileGraph(graph, 'webgl')).not.toThrow();
  });
});

describe('arbitrary layer counts', () => {
  // 10 is the maximum: it is the only count where every group owns a single
  // band, which is what makes the highlight band the last one in its group.
  it.each([1, 2, 3, 5, 8, 10])('compiles a %i-layer graph on both backends', (layerCount) => {
    for (const backend of ['webgpu', 'webgl'] as const) {
      const compiled = compileGraph(buildDefaultGraph(layerCount), backend);
      expect(compiled.layerCount).toBe(layerCount);

      const layerPasses = compiled.emitted.filter((pass) => pass.kind === 'band-layer');
      expect(layerPasses).toHaveLength(layerCount);
      for (const pass of layerPasses) expect(pass.fragment.length).toBeGreaterThan(0);

      const composite = compiled.emitted.find((pass) => pass.kind === 'blend')!;
      expect(composite.textureBindings).toHaveLength(layerCount + 2);
      expect(composite.fragment).toContain(`layer${layerCount - 1}`);
      expect(composite.fragment).not.toContain(`layer${layerCount}`);
    }
  });

  it('derives layer specs from the canonical band table for any count', () => {
    expect(buildLayerSpecs(3)).toBe(buildLayerSpecs(3));
    for (const count of [1, 2, 4, 5, 10]) {
      const specs = buildLayerSpecs(count);
      expect(specs).toHaveLength(count);
      const bands = specs.flatMap((spec) => spec.fixed.map((band) => band.maskBand));
      // Every canonical band index is claimed by exactly one layer.
      expect(new Set(bands).size).toBe(bands.length);
      expect(bands).toHaveLength(10);
    }
  });

  it('gives every generated layer at least one gradient arm', () => {
    // A band group of size one used to emit no gradient arm at all, leaving
    // that layer fully transparent in Chromashift gradient mode.
    for (let count = 1; count <= 10; count += 1) {
      for (const spec of buildLayerSpecs(count)) {
        expect(
          spec.gradient.length,
          `layerCount=${count} layer=${spec.index} has no gradient arm`,
        ).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('refuses more layers than there are canonical bands', () => {
    expect(() => buildLayerSpecs(11)).toThrow(RangeError);
    expect(() => buildDefaultGraph(0)).toThrow(RangeError);
  });

  it('scales the coincidence pass with the layer count', () => {
    const compiled = compileGraph(buildDefaultGraph(5), 'webgpu');
    const stamp = compiled.emitted.find((pass) => pass.kind === 'coincidence')!;
    expect(stamp.fragment).toContain('let c4 = textureSample(layer4');
    expect(stamp.fragment).not.toContain('layer5');
    expect(stamp.textureBindings).toEqual([
      'layer0', 'layer1', 'layer2', 'layer3', 'layer4', 'previous',
    ]);
  });
});

/**
 * WGSL's uniformity rule: `textureSample` computes implicit derivatives, so it
 * must be reached by every invocation in a quad — never from behind a branch
 * on a per-fragment value. Nothing in Node can run the WGSL validator, and a
 * violation is not a thrown error on a device either: it is an invalid pipeline
 * that drops the whole frame. `?graph=warp` shipped behind such a branch and
 * drew black, so the emitters are held to "no branch in a sampling pass".
 */
describe('emitted sampling passes stay in uniform control flow', () => {
  const cases: [string, string][] = [
    ['warp (affine)', emitWarpWgsl('affine')],
    ['warp (feedback)', emitWarpWgsl('feedback')],
    ['blur', emitBlurWgsl(3)],
    ['history write', emitHistoryWriteWgsl()],
    ['history taps', emitHistoryTapsWgsl(8)],
    ['displace (motion)', emitDisplaceWgsl('motion')],
    ['displace (color)', emitDisplaceWgsl('color')],
  ];

  for (const [name, source] of cases) {
    it(`${name} samples without branching`, () => {
      expect(source).toContain('textureSample(');
      expect(source).not.toMatch(/\bif\s*\(/);
    });
  }

  it('warp still returns transparent black outside the warped image', () => {
    expect(emitWarpWgsl('affine')).toMatch(/select\(sampled, vec4<f32>\(0\.0\), outside\)/);
  });
});

describe('history and displace', () => {
  const smearGraph = (): PassGraph => buildGraphPreset('smear');
  const withParams = (graph: PassGraph, id: string, params: GraphNode['params']): PassGraph => {
    graph.nodes.find((n) => n.id === id)!.params = params;
    return graph;
  };

  it('takes exactly one input for history and two for displace', () => {
    const history = graphOf(
      [node('src', 'source'), node('h', 'history', ['src', 'src'], { frames: 2 }), node('out', 'output', ['h'])],
      'out',
    );
    expect(() => validateGraph(history)).toThrow(expect.objectContaining({ code: 'input-arity', nodeId: 'h' }));
    const displace = graphOf(
      [node('src', 'source'), node('d', 'displace', ['src']), node('out', 'output', ['d'])],
      'out',
    );
    expect(() => validateGraph(displace)).toThrow(expect.objectContaining({ code: 'input-arity', nodeId: 'd' }));
  });

  it.each([
    ['frames below the ring minimum', 'smear-history', { frames: 1 }],
    ['frames above the VRAM cap', 'smear-history', { frames: 9 }],
    ['fractional frames', 'smear-history', { frames: 2.5 }],
    ['a resolution class history cannot use', 'smear-history', { frames: 4, resolution: 'output' }],
    ['an unknown field convention', 'smear-displace', { field: 'depth' }],
    ['an unknown source role', 'motion', { role: 'webcam' }],
  ])('refuses %s as invalid-param, naming the node', (_name, id, params) => {
    expect(() => validateGraph(withParams(smearGraph(), id, params))).toThrow(
      expect.objectContaining({ code: 'invalid-param', nodeId: id }),
    );
  });

  it('schedules the smear before the band layers that read it', () => {
    const order = passOrder(scheduleGraph(smearGraph(), validateGraph(smearGraph())));
    expect(order.indexOf('smear-history')).toBeLessThan(order.indexOf('smear-displace'));
    expect(order.indexOf('smear-displace')).toBeLessThan(order.indexOf('layer0'));
    expect(order.indexOf('motion')).toBeLessThan(order.indexOf('smear-displace'));
  });

  it('gives the ring its own storage and pools the history output', () => {
    const allocation = plan(smearGraph());
    expect(allocation.rings).toEqual([
      { id: 'ring:smear-history', nodeId: 'smear-history', resolution: 'layer', frames: 4 },
    ]);
    expect(allocation.assignment['smear-history']).toMatch(/^layer:/);
    expect(allocation.assignment.motion).toBe('external');
    // The history output dies as displace reads it, so the smear costs one
    // pooled layer slot over the default graph: displace's, live until the last
    // band layer has sampled it.
    expect(allocation.slotsByResolution).toEqual({ source: 0, layer: 4, tracer: 3, output: 0 });
    expect(ringTexturesByResolution(allocation)).toEqual({ source: 0, layer: 4, tracer: 0, output: 0 });
  });

  it('runs a tracer-resolution ring at tracer scale, output and ring alike', () => {
    const graph = withParams(smearGraph(), 'smear-history', { frames: 3, resolution: 'tracer' });
    const allocation = plan(graph);
    expect(allocation.rings[0].resolution).toBe('tracer');
    expect(allocation.assignment['smear-history']).toMatch(/^tracer:/);
  });

  it('counts every ring slot in the VRAM estimate', () => {
    const sizes: Record<ResolutionClass, { width: number; height: number; bytesPerPixel: number }> = {
      source: { width: 0, height: 0, bytesPerPixel: 4 },
      layer: { width: 100, height: 100, bytesPerPixel: 4 },
      tracer: { width: 50, height: 50, bytesPerPixel: 4 },
      output: { width: 0, height: 0, bytesPerPixel: 4 },
    };
    const base = estimateVram(plan(buildDefaultGraph()), sizes);
    // One extra pooled layer slot plus four ring slots.
    expect(estimateVram(plan(smearGraph()), sizes)).toBe(base + 5 * 100 * 100 * 4);
  });

  it('emits one taps sample per ring slot', () => {
    const compiled = compileGraph(smearGraph(), 'webgpu');
    const history = compiled.emitted.find((pass) => pass.nodeId === 'smear-history')!;
    expect(history.textureBindings).toEqual(['ring0', 'ring1', 'ring2', 'ring3']);
    expect(history.fragment.match(/textureSample\(/g)).toHaveLength(4);
    const displace = compiled.emitted.find((pass) => pass.nodeId === 'smear-displace')!;
    expect(displace.textureBindings).toEqual(['source', 'field']);
    expect(displace.fragment).toContain('f.gb / vec2<f32>(textureDimensions(field))');
    expect(emitDisplaceWgsl('color')).toContain('f.rg - vec2<f32>(0.5)');
  });

  it('recompiles for a new ring length or field, not for tap weights or gain', () => {
    compileGraph(smearGraph(), 'webgpu');
    const count = graphCompileCount();
    const tweaked = smearGraph();
    Object.assign(tweaked.nodes.find((n) => n.id === 'smear-history')!.params, { mode: 'tap', delay: 2, falloff: 0.1 });
    Object.assign(tweaked.nodes.find((n) => n.id === 'smear-displace')!.params, { gain: 4, mode: 'forward' });
    compileGraph(tweaked, 'webgpu');
    expect(graphCompileCount()).toBe(count);

    compileGraph(withParams(smearGraph(), 'smear-history', { frames: 6 }), 'webgpu');
    expect(graphCompileCount()).toBe(count + 1);
    compileGraph(withParams(smearGraph(), 'smear-displace', { field: 'color' }), 'webgpu');
    expect(graphCompileCount()).toBe(count + 2);
  });

  it('keys the source role into the hash without moving the default graph', () => {
    // `role` became structural; a source with no params must hash exactly as
    // before, which is what this key spells out (empty structural brackets).
    expect(structuralKey(buildDefaultGraph(), 'webgpu')).toContain(';source:source()[];');
    const motion = buildDefaultGraph();
    motion.nodes[0].params = { role: 'motion-field' };
    expect(structuralHash(motion, 'webgpu')).not.toBe(structuralHash(buildDefaultGraph(), 'webgpu'));
  });
});

describe('starter graphs', () => {
  it.each(['smear', 'feedback'] as const)('%s compiles, schedules and allocates on WebGPU', (name) => {
    const compiled = compileGraph(buildGraphPreset(name), 'webgpu');
    expect(compiled.layerCount).toBe(3);
    expect(compiled.passes.at(-1)!.kind).toBe('output');
  });

  it('feedback is the warp shape in its feedback mode', () => {
    const compiled = compileGraph(buildGraphPreset('feedback'), 'webgpu');
    const warp = compiled.emitted.find((pass) => pass.nodeId === 'layer0-warp')!;
    expect(warp.fragment).toContain('wu.displace');
    expect(compiled.passes.find((p) => p.nodeId === 'coincidence')!.inputs).toContain('layer0-warp');
  });

  it('refuses a starter for a layer count it was not authored for', () => {
    expect(() => buildGraphPreset('smear', 5)).toThrow(
      expect.objectContaining({ code: 'input-arity' }),
    );
  });

  it('refuses JSON naming a node kind that does not exist, by name', () => {
    const json = {
      output: 'out',
      nodes: [
        { id: 'src', kind: 'source', inputs: [], params: {} },
        { id: 'echo', kind: 'reverb', inputs: ['src'], params: {} },
        { id: 'out', kind: 'output', inputs: ['echo'], params: {} },
      ],
    };
    expect(() => parsePassGraphJson(json)).toThrow(
      expect.objectContaining({ code: 'unsupported-node', nodeId: 'echo' }),
    );
  });

  it('refuses malformed JSON rather than guessing', () => {
    expect(() => parsePassGraphJson({ nodes: [] })).toThrow(PassGraphError);
    expect(() => parsePassGraphJson({ output: 'o', nodes: [{ id: 'o', kind: 'output', inputs: [3] }] }))
      .toThrow(expect.objectContaining({ code: 'invalid-param', nodeId: 'o' }));
  });

  it('round-trips the default graph through JSON unchanged', () => {
    const graph = buildDefaultGraph();
    const parsed = parsePassGraphJson(JSON.parse(JSON.stringify(graph)));
    expect(structuralHash(parsed, 'webgpu')).toBe(structuralHash(graph, 'webgpu'));
  });
});
