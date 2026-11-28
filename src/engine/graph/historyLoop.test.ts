import { beforeEach, describe, expect, it } from 'vitest';
import {
  allocateTextures,
  buildDefaultGraph,
  buildGraphPreset,
  compileGraph,
  estimateVram,
  passOrder,
  resetGraphCompileCache,
  ringTexturesByResolution,
  scheduleGraph,
  structuralHash,
  validateGraph,
} from './index';
import { HISTORY_MAX_FRAMES } from './nodeKinds';
import type { GraphNode, PassGraph, ResolutionClass } from './types';

const node = (
  id: string,
  kind: GraphNode['kind'],
  inputs: string[] = [],
  params: GraphNode['params'] = {},
): GraphNode => ({ id, kind, inputs, params });

/** `warp → history(loop) → warp`, the warp read by the output. */
const loopGraph = (historyParams: GraphNode['params'] = {}): PassGraph => ({
  nodes: [
    node('src', 'source'),
    node('w', 'warp', ['h'], { angleDeg: 2, scale: 1.03 }),
    node('h', 'history', ['src', 'w'], { frames: 2, loop: true, ...historyParams }),
    node('out', 'output', ['w']),
  ],
  output: 'out',
});

beforeEach(() => resetGraphCompileCache());

describe('history loop — the IR', () => {
  it('compiles warp → history(loop) → warp on webgpu with exactly one feedback edge', () => {
    const graph = loopGraph();
    expect(validateGraph(graph).feedbackEdges).toEqual([{ consumer: 'w', producer: 'h' }]);
    const compiled = compileGraph(graph, 'webgpu');
    const feedback = compiled.passes.flatMap((pass) => pass.feedbackInputs.map((input) => `${pass.nodeId}<-${input}`));
    expect(feedback).toEqual(['w<-h']);
  });

  it('records the previous-slot edge whichever side the walk enters from', () => {
    // The output reaches the loop through its live input's consumer first: the
    // edge feeding the loop must not read as a second back edge.
    const graph: PassGraph = {
      nodes: [
        node('src', 'source'),
        node('w', 'warp', ['h']),
        node('b', 'blur', ['w']),
        node('h', 'history', ['src', 'b'], { frames: 3, loop: true }),
        node('out', 'output', ['b']),
      ],
      output: 'out',
    };
    expect(validateGraph(graph).feedbackEdges).toEqual([{ consumer: 'w', producer: 'h' }]);
    expect(() => compileGraph(graph, 'webgpu')).not.toThrow();
  });

  it('still refuses warp → warp as an illegal cycle', () => {
    const graph: PassGraph = {
      nodes: [node('a', 'warp', ['b']), node('b', 'warp', ['a']), node('out', 'output', ['a'])],
      output: 'out',
    };
    expect(() => validateGraph(graph)).toThrow(expect.objectContaining({ code: 'illegal-cycle' }));
  });

  it('refuses a cycle through a history that is not a loop', () => {
    const graph: PassGraph = {
      nodes: [
        node('w', 'warp', ['h']),
        node('h', 'history', ['w'], { frames: 2 }),
        node('out', 'output', ['w']),
      ],
      output: 'out',
    };
    expect(() => validateGraph(graph)).toThrow(expect.objectContaining({ code: 'illegal-cycle' }));
  });

  it.each(['band-layer', 'blur', 'displace', 'blend'] as const)(
    'refuses a back edge into %s',
    (kind) => {
      const inputs = kind === 'displace' || kind === 'blend' ? ['w', 'src'] : ['w'];
      const graph: PassGraph = {
        nodes: [
          node('src', 'source'),
          node('x', kind, inputs, kind === 'blend' ? { layerInputs: 1, tracerInputs: 1 } : {}),
          node('w', 'warp', ['x']),
          // The walk enters at `x`, so the back edge is `w` reading `x`.
          node('out', 'output', ['x']),
        ],
        output: 'out',
      };
      expect(() => validateGraph(graph)).toThrow(
        expect.objectContaining({ code: 'illegal-cycle', message: expect.stringContaining(`(${kind})`) }),
      );
    },
  );

  it('lets a loop history read itself, and nothing else of its kind', () => {
    const selfLoop: PassGraph = {
      nodes: [
        node('src', 'source'),
        node('h', 'history', ['src', 'h'], { frames: 2, loop: true }),
        node('w', 'warp', ['h']),
        node('out', 'output', ['w']),
      ],
      output: 'out',
    };
    expect(validateGraph(selfLoop).feedbackEdges).toEqual([
      { consumer: 'w', producer: 'h' },
      { consumer: 'h', producer: 'h' },
    ]);

    const trail: PassGraph = {
      nodes: [node('h', 'history', ['h'], { frames: 2 }), node('out', 'output', ['h'])],
      output: 'out',
    };
    expect(() => validateGraph(trail)).toThrow(expect.objectContaining({ code: 'self-reference', nodeId: 'h' }));
  });

  it('takes exactly [live, fed] in loop mode', () => {
    const one: PassGraph = {
      nodes: [
        node('src', 'source'),
        node('h', 'history', ['src'], { frames: 2, loop: true }),
        node('w', 'warp', ['h']),
        node('out', 'output', ['w']),
      ],
      output: 'out',
    };
    expect(() => validateGraph(one)).toThrow(expect.objectContaining({ code: 'input-arity', nodeId: 'h' }));
  });

  it('refuses a loop that is not a boolean', () => {
    expect(() => validateGraph(loopGraph({ loop: 'yes' }))).toThrow(
      expect.objectContaining({ code: 'invalid-param', nodeId: 'h' }),
    );
  });

  it('makes a loop and a trail different graphs, by hash', () => {
    const loop = loopGraph();
    const trail = loopGraph();
    delete trail.nodes.find((n) => n.id === 'h')!.params.loop;
    expect(structuralHash(loop, 'webgpu')).not.toBe(structuralHash(trail, 'webgpu'));
    // `delay` and `gain` pick a slot binding and a uniform: no recompile.
    expect(structuralHash(loopGraph({ delay: 1, gain: 0.5 }), 'webgpu')).toBe(structuralHash(loop, 'webgpu'));
  });

  it('refuses a loop by name on webgl', () => {
    expect(() => compileGraph(loopGraph(), 'webgl')).toThrow(
      expect.objectContaining({ code: 'unsupported-node', nodeId: 'h', message: expect.stringMatching(/feedback loop/) }),
    );
  });
});

describe('history loop — schedule and allocation', () => {
  const sizes = (width: number, height: number) => Object.fromEntries(
    (['source', 'layer', 'tracer', 'output'] as ResolutionClass[]).map((resolution) => [
      resolution,
      { width, height, bytesPerPixel: 8 },
    ]),
  ) as Parameters<typeof estimateVram>[1];

  it('schedules the write after every reader of the slot it does not touch', () => {
    const graph = loopGraph();
    const order = passOrder(scheduleGraph(graph, validateGraph(graph)));
    expect(order.indexOf('w')).toBeLessThan(order.indexOf('h'));
    expect(order).toContain('h');
  });

  it.each([2, 5, HISTORY_MAX_FRAMES])('costs exactly the ring at frames=%i, with no pooled output', (frames) => {
    const graph = loopGraph({ frames });
    const schedule = scheduleGraph(graph, validateGraph(graph));
    const plan = allocateTextures(schedule);

    expect(plan.rings).toEqual([{ id: 'ring:h', nodeId: 'h', resolution: 'layer', frames }]);
    expect(plan.assignment.h).toBe('ring:h');
    expect(plan.slots.some((slot) => slot.nodes.includes('h'))).toBe(false);
    expect(ringTexturesByResolution(plan)).toEqual({ source: 0, layer: frames, tracer: 0, output: 0 });

    // The warp's pooled target plus the ring; nothing else.
    const size = sizes(64, 32);
    const layerBytes = 64 * 32 * 8;
    const pooled = plan.slots.length * layerBytes;
    expect(plan.slots.map((slot) => slot.resolution)).toEqual(['layer']);
    expect(estimateVram(plan, size)).toBe(pooled + frames * layerBytes);
  });

  it('refuses a ring past the cap in loop mode too', () => {
    expect(() => validateGraph(loopGraph({ frames: HISTORY_MAX_FRAMES + 1 }))).toThrow(
      expect.objectContaining({ code: 'invalid-param', nodeId: 'h' }),
    );
  });

  it('sizes ?graph=recurse at a two-slot ring and no pooled loop output', () => {
    const plan = compileGraph(buildGraphPreset('recurse'), 'webgpu').allocation;
    expect(plan.rings).toEqual([{ id: 'ring:recurse-loop', nodeId: 'recurse-loop', resolution: 'layer', frames: 2 }]);
    expect(plan.slots.some((slot) => slot.nodes.includes('recurse-loop'))).toBe(false);
  });

  it('leaves the default graph with no ring and no feedback edge', () => {
    const graph = buildDefaultGraph();
    expect(validateGraph(graph).feedbackEdges).toEqual([]);
    expect(compileGraph(graph, 'webgpu').allocation.rings).toEqual([]);
  });
});
