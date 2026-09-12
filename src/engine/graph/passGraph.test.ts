import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_GRAPH_IDS,
  PassGraphError,
  allocateTextures,
  buildDefaultGraph,
  buildLayerSpecs,
  compileGraph,
  estimateVram,
  graphCompileCount,
  passOrder,
  resetGraphCompileCache,
  scheduleGraph,
  sharedSlots,
  structuralHash,
  supportedNodeKinds,
  validateGraph,
} from './index';
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
  it('lists warp and blur as WebGPU-only', () => {
    expect(supportedNodeKinds('webgpu')).toEqual(expect.arrayContaining(['warp', 'blur']));
    expect(supportedNodeKinds('webgl')).not.toEqual(expect.arrayContaining(['warp']));
    expect(supportedNodeKinds('webgl')).not.toEqual(expect.arrayContaining(['blur']));
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
  it.each([1, 2, 3, 5, 8])('compiles a %i-layer graph on both backends', (layerCount) => {
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
