/**
 * Buffers as graph resources, compute stages, and the particle starter, at the
 * IR level: validation, scheduling, allocation and the structural hash. The
 * executor's half is `exec/WebGpuGraphExecutor.particles.test.ts`; the pixels
 * are the headless goldens' (`src/headless/goldens.gpu.test.ts`).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  allocateBuffers,
  bufferElementCount,
  bufferResourceBytes,
  estimateVram,
  planBufferBytes,
} from './allocate';
import { buildGraphPreset, buildParticlesGraph, PARTICLE_GRAPH_IDS } from './altGraphs';
import {
  graphCapabilityNeeds,
  missingCapabilityError,
  webGpuDeviceCapabilities,
} from './capabilities';
import { compileGraph, resetGraphCompileCache } from './compile';
import { buildDefaultGraph, DEFAULT_GRAPH_IDS } from './defaultGraph';
import { PassGraphError } from './errors';
import { structuralHash } from './hash';
import {
  APPEND_CONTROL_BYTES,
  PARTICLE_CAPACITY_MAX,
  PARTICLE_CAPACITY_MIN,
  PARTICLE_STRIDE,
  nodeKindSpec,
} from './nodeKinds';
import { scheduleGraph, type Schedule } from './schedule';
import type { GraphNode, PassGraph } from './types';
import { bufferEdgeNeeds, validateGraph } from './validate';

const ids = PARTICLE_GRAPH_IDS;

const withNode = (graph: PassGraph, id: string, patch: Partial<GraphNode>): PassGraph => ({
  ...graph,
  nodes: graph.nodes.map((node) => (node.id === id ? { ...node, ...patch } : node)),
});

beforeEach(() => resetGraphCompileCache());

describe('the default graph is untouched by buffer resources', () => {
  // The structural hashes before buffers existed. A buffer-free graph must
  // hash exactly as it did: the hash is the pipeline cache key, and the
  // goldens are pinned against what it selects.
  const PINNED = {
    1: { webgpu: '04b901fbc7f480', webgl: '0d62d0d735ac1e' },
    3: { webgpu: '1130809b010389', webgl: '05cfbfbd59ed8c' },
    7: { webgpu: '17d11a1fb8f399', webgl: '0237a75716b728' },
    10: { webgpu: '1bd37d67938dc4', webgl: '0568be51dadaaf' },
  } as const;

  it.each(Object.entries(PINNED))('hashes as it did at %s layer(s)', (layers, hashes) => {
    const graph = buildDefaultGraph(Number(layers));
    expect(structuralHash(graph, 'webgpu')).toBe(hashes.webgpu);
    expect(structuralHash(graph, 'webgl')).toBe(hashes.webgl);
  });

  it('allocates no buffer and schedules no compute pass', () => {
    for (const backend of ['webgpu', 'webgl'] as const) {
      const compiled = compileGraph(buildDefaultGraph(), backend);
      expect(compiled.allocation.buffers).toEqual([]);
      expect(planBufferBytes(compiled.allocation)).toBe(0);
      expect(compiled.passes.every((pass) => pass.stage === 'render')).toBe(true);
      expect(compiled.emitted.every((pass) => pass.compute === undefined && pass.vertex === undefined)).toBe(true);
    }
  });

  it('keeps every buffer-free preset in its depth-first schedule', () => {
    // The chain hoist only reorders a graph that has a chain.
    expect(compileGraph(buildDefaultGraph(), 'webgpu').passes.map((pass) => pass.nodeId)).toEqual([
      'source', 'layer0', 'layer1', 'layer2', 'coincidence', 'tracer-below', 'tracer-above', 'composite', 'swapchain',
    ]);
  });
});

describe('node specs gain a stage', () => {
  it('marks emit and advect compute, with a workgroup size, and everything else render', () => {
    expect(nodeKindSpec('emit')).toMatchObject({ stage: 'compute', workgroup: [8, 8, 1], outputType: 'buffer' });
    expect(nodeKindSpec('advect')).toMatchObject({ stage: 'compute', workgroup: [64, 1, 1], outputType: 'buffer' });
    expect(nodeKindSpec('splat')).toMatchObject({ stage: 'render', inputType: 'buffer', bufferAccess: 'vertex' });
    for (const kind of ['source', 'band-layer', 'decay', 'blend', 'output'] as const) {
      expect(nodeKindSpec(kind).stage, kind).toBe('render');
      expect(nodeKindSpec(kind).workgroup, kind).toBeUndefined();
    }
  });
});

describe('validation of buffer edges', () => {
  it('accepts the particle starter', () => {
    expect(() => validateGraph(buildParticlesGraph())).not.toThrow();
  });

  it('refuses a texture where advect expects the particle buffer', () => {
    const graph = withNode(buildParticlesGraph(), ids.advect, { inputs: [DEFAULT_GRAPH_IDS.layer(0), ids.field] });
    expect(() => validateGraph(graph)).toThrow(/expects a buffer at input 0 but 'layer0' produces texture/);
  });

  it('refuses a buffer into a texture input', () => {
    const graph = withNode(buildParticlesGraph(), ids.trail, { inputs: [ids.advect] });
    expect(() => validateGraph(graph)).toThrow(/expects texture inputs but 'particles-advect' produces buffer/);
  });

  it('refuses an advect whose field is not the motion-field source', () => {
    const graph = withNode(buildParticlesGraph(), ids.advect, { inputs: [ids.emit, DEFAULT_GRAPH_IDS.source] });
    expect(() => validateGraph(graph)).toThrow(/\(advect\) reads 'source' \(source\) as its field/);
  });

  it.each([PARTICLE_CAPACITY_MIN - 1, PARTICLE_CAPACITY_MAX + 1, 1000.5, 'big'])(
    'refuses an emit capacity of %s — the ring is the chain’s VRAM',
    (capacity) => {
      const graph = withNode(buildParticlesGraph(), ids.emit, {
        params: { ...buildParticlesGraph().nodes.find((n) => n.id === ids.emit)!.params, capacity },
      });
      try {
        validateGraph(graph);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(PassGraphError);
        expect((error as PassGraphError).code).toBe('invalid-param');
        expect((error as PassGraphError).nodeId).toBe(ids.emit);
      }
    },
  );

  it('asks nothing of the device for the chain: storage in compute, instance attributes in splat', () => {
    const graph = buildParticlesGraph();
    expect(bufferEdgeNeeds(graph)).toEqual([]);
    expect(graphCapabilityNeeds(graph)).toEqual([]);
    // A compatibility-mode GL ES device, withholding fragment storage, draws it.
    const glEs = webGpuDeviceCapabilities({
      featureLevel: 'compatibility',
      features: new Set(),
      limits: { maxTextureDimension2D: 4096, maxStorageBuffersInFragmentStage: 0, maxStorageTexturesInFragmentStage: 0 },
      hdrCanvas: false,
    });
    expect(glEs.granted.has('fragment-storage')).toBe(false);
    expect(missingCapabilityError(graph, glEs)).toBeNull();
    expect(() => validateGraph(graph, { granted: glEs.granted })).not.toThrow();
  });
});

describe('scheduling compute and render nodes in one pass', () => {
  const compiled = () => compileGraph(buildParticlesGraph(), 'webgpu');

  it('tags each pass with its stage', () => {
    const stages = Object.fromEntries(compiled().passes.map((pass) => [pass.nodeId, pass.stage]));
    expect(stages[ids.emit]).toBe('compute');
    expect(stages[ids.advect]).toBe('compute');
    expect(stages[ids.splat]).toBe('render');
    expect(stages[DEFAULT_GRAPH_IDS.tracerAbove]).toBe('render');
  });

  it('keeps the chain contiguous, after the stamp it reads and before the accumulators', () => {
    const order = compiled().passes.map((pass) => pass.nodeId);
    const at = (id: string) => order.indexOf(id);
    expect(at(ids.advect)).toBe(at(ids.emit) + 1);
    expect(at(ids.splat)).toBe(at(ids.advect) + 1);
    expect(at(ids.emit)).toBeGreaterThan(at(DEFAULT_GRAPH_IDS.coincidence));
    expect(at(ids.splat)).toBeLessThan(at(DEFAULT_GRAPH_IDS.tracerBelow));
    expect(at(ids.trail)).toBeLessThan(at(DEFAULT_GRAPH_IDS.composite));
  });

  it('gives buffer producers buffer lifetimes, not texture ones', () => {
    const graph = buildParticlesGraph();
    const schedule = scheduleGraph(graph, validateGraph(graph));
    expect(schedule.bufferLifetimes.map((lifetime) => lifetime.nodeId)).toEqual([ids.emit, ids.advect]);
    expect(schedule.lifetimes.some((lifetime) => lifetime.nodeId === ids.emit)).toBe(false);
    expect(schedule.buffers[ids.emit]).toEqual({
      owns: true,
      layout: 'append',
      stride: PARTICLE_STRIDE,
      elements: 16_384,
      persistent: true,
    });
    expect(schedule.buffers[ids.advect]).toEqual({ owns: false, input: ids.emit });
  });
});

describe('allocating buffers', () => {
  it('gives the ring one persistent resource, written in place by advect', () => {
    const { allocation } = compileGraph(buildParticlesGraph(), 'webgpu');
    expect(allocation.buffers).toEqual([{
      id: `persist-buffer:${ids.emit}`,
      owner: ids.emit,
      nodes: [ids.emit, ids.advect],
      layout: 'append',
      stride: PARTICLE_STRIDE,
      elements: 16_384,
      persistent: true,
      controlBytes: APPEND_CONTROL_BYTES,
    }]);
    expect(allocation.assignment[ids.advect]).toBe(allocation.assignment[ids.emit]);
    // splat draws into an ordinary tracer-resolution transient.
    expect(allocation.assignment[ids.splat]).toMatch(/^tracer:/);
  });

  it('sizes the ring from the structural capacity, and bounds the chain’s VRAM by it', () => {
    const small = compileGraph(buildParticlesGraph(3, { capacity: 1024 }), 'webgpu');
    const large = compileGraph(buildParticlesGraph(3, { capacity: PARTICLE_CAPACITY_MAX }), 'webgpu');
    expect(small.hash).not.toBe(large.hash);
    expect(planBufferBytes(small.allocation)).toBe(1024 * PARTICLE_STRIDE + APPEND_CONTROL_BYTES);
    expect(planBufferBytes(large.allocation)).toBe(PARTICLE_CAPACITY_MAX * PARTICLE_STRIDE + APPEND_CONTROL_BYTES);
    expect(PARTICLE_CAPACITY_MAX * PARTICLE_STRIDE).toBe(8 * 1024 * 1024);
  });

  it('counts the buffers in the VRAM estimate', () => {
    const size = { width: 64, height: 64, bytesPerPixel: 4 };
    const sizes = { source: size, layer: size, tracer: size, output: size };
    const withChain = compileGraph(buildParticlesGraph(3, { capacity: 1024 }), 'webgpu').allocation;
    expect(estimateVram(withChain, sizes)).toBe(
      estimateVram({ ...withChain, buffers: [] }, sizes) + 1024 * PARTICLE_STRIDE + APPEND_CONTROL_BYTES,
    );
  });

  it('resolves a per-pixel element count from the frame size', () => {
    const resource = { elements: { perPixel: 'tracer' as const }, stride: 16, controlBytes: 0 };
    expect(bufferElementCount(resource, { tracer: { width: 10, height: 4 } })).toBe(40);
    expect(bufferResourceBytes(resource, { tracer: { width: 10, height: 4 } })).toBe(640);
    expect(() => bufferElementCount(resource)).toThrow(/No size for the 'tracer'/);
  });

  it('pools transient buffers of one shape across non-overlapping lifetimes', () => {
    // A synthetic schedule: no shipped kind has a transient buffer yet, but
    // the pool's rule is the textures' — free once the last reader has run.
    const pass = (nodeId: string, order: number) => ({
      nodeId, kind: 'emit' as const, stage: 'compute' as const, order, inputs: [], feedbackInputs: [],
    });
    const shape = { owns: true as const, layout: 'plain' as const, stride: 4, elements: 256, persistent: false };
    const schedule: Schedule = {
      passes: [pass('a', 0), pass('b', 1), pass('c', 2), pass('d', 3)],
      lifetimes: [],
      bufferLifetimes: [
        { nodeId: 'a', def: 0, lastUse: 1 },
        { nodeId: 'b', def: 1, lastUse: 2 },
        { nodeId: 'c', def: 2, lastUse: 3 },
        { nodeId: 'd', def: 3, lastUse: 3 },
      ],
      historyFrames: {},
      buffers: { a: shape, b: shape, c: shape, d: { ...shape, stride: 8 } },
    };
    const assignment: Record<string, string> = {};
    const buffers = allocateBuffers(schedule, assignment);
    // a dies after b reads it, so c reuses a's; d is another shape.
    expect(assignment.c).toBe(assignment.a);
    expect(assignment.b).not.toBe(assignment.a);
    expect(buffers).toHaveLength(3);
    expect(buffers.find((buffer) => buffer.id === assignment.a)!.nodes).toEqual(['a', 'c']);
  });
});

describe('the particle starter', () => {
  it('scales with the layer count', () => {
    for (const layers of [1, 3, 7]) {
      const compiled = compileGraph(buildGraphPreset('particles', layers), 'webgpu');
      expect(compiled.layerCount).toBe(layers);
      const emit = compiled.emitted.find((pass) => pass.nodeId === ids.emit)!;
      expect(emit.compute?.entryPoints).toEqual(['emit_main', 'emit_args']);
      expect(emit.textureBindings).toHaveLength(layers);
    }
  });

  it('blends the trail on top, as an overlay', () => {
    const composite = buildParticlesGraph().nodes.find((node) => node.id === DEFAULT_GRAPH_IDS.composite)!;
    expect(composite.inputs.at(-1)).toBe(ids.trail);
    expect(composite.params).toMatchObject({ tracerInputs: 3, overlayInputs: 1 });
    const blend = compileGraph(buildParticlesGraph(), 'webgpu').emitted.find((pass) => pass.kind === 'blend')!;
    expect(blend.fragment).toContain('1.0 - (1.0 - finalCol.rgb) * (1.0 - min(pTracer2.rgb * cu.tracerOpacity2');
  });

  it('emits a trail accumulator, not a stamp, for the decay of the splat', () => {
    const trail = compileGraph(buildParticlesGraph(), 'webgpu').emitted.find((pass) => pass.nodeId === ids.trail)!;
    expect(trail.textureBindings).toEqual(['trail', 'previous']);
    expect(trail.fragment).toContain('max(decayed, fresh)');
    expect(trail.fragment).not.toContain('layerCount');
  });

  it('is refused by the WebGL backend, naming the compute node', () => {
    try {
      compileGraph(buildParticlesGraph(), 'webgl');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PassGraphError);
      expect(error).toMatchObject({ code: 'unsupported-node', nodeId: ids.emit });
      expect((error as Error).message).toBe(
        "The webgl backend has no compute stage: node kind 'emit' (node 'particles-emit') is a compute node.",
      );
    }
  });

  it('refuses an overlay on the WebGL backend, which has no such compositor', () => {
    const trails = buildGraphPreset('trails3');
    const composite = trails.nodes.find((node) => node.id === DEFAULT_GRAPH_IDS.composite)!;
    const overlaid = withNode(trails, composite.id, { params: { ...composite.params, overlayInputs: 1 } });
    expect(() => compileGraph(overlaid, 'webgl')).toThrow(/no overlay tracers/);
    expect(() => compileGraph(overlaid, 'webgpu')).not.toThrow();
    const tooMany = withNode(trails, composite.id, { params: { ...composite.params, overlayInputs: 2 } });
    expect(() => compileGraph(tooMany, 'webgpu')).toThrow(/overlays 2 tracer\(s\), but has 1/);
  });
});
