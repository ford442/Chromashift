import { beforeEach, describe, expect, it } from 'vitest';
import { compileGraph, resetGraphCompileCache } from '../compile';
import { buildBlurGraph } from '../altGraphs';
import { buildDefaultGraph, DEFAULT_GRAPH_IDS } from '../defaultGraph';
import { createFakeGpu, type FakeGpu } from './__fixtures__/fakeDevice';
import { GraphTexturePool, type PoolSizes } from './pool';

const SIZES: PoolSizes = {
  source: { width: 800, height: 600 },
  layer: { width: 400, height: 300 },
  tracer: { width: 200, height: 150 },
  output: { width: 800, height: 600 },
};

describe('GraphTexturePool', () => {
  let gpu: FakeGpu;
  let pool: GraphTexturePool;

  beforeEach(() => {
    resetGraphCompileCache();
    gpu = createFakeGpu();
    pool = new GraphTexturePool(gpu.device, 'rgba16float');
  });

  const configure = (plan = compileGraph(buildDefaultGraph(), 'webgpu').allocation, sampleCount = 1) => {
    pool.configure(plan, SIZES, sampleCount);
    return plan;
  };

  it('creates nothing until a node asks for its target', () => {
    configure();
    expect(gpu.textures).toHaveLength(0);
  });

  it('sizes a target by its resolution class', () => {
    configure();
    const layer = pool.transient('layer0');
    const tracer = pool.pingPong(DEFAULT_GRAPH_IDS.tracerAbove).write;
    expect([layer.width, layer.height]).toEqual([400, 300]);
    expect([tracer.width, tracer.height]).toEqual([200, 150]);
  });

  it('never allocates the fused coincidence slot the plan sized', () => {
    // The plan gives `coincidence` a tracer slot because it is a node with an
    // output; the executor absorbs its pass into the decays, so nothing ever
    // asks for that texture and lazy creation means it costs nothing.
    configure();
    for (const id of ['layer0', 'layer1', 'layer2']) pool.transient(id);
    pool.pingPong(DEFAULT_GRAPH_IDS.tracerBelow);
    pool.pingPong(DEFAULT_GRAPH_IDS.tracerAbove);
    // 3 layer targets + 2 ping-pong pairs, and no fifth tracer target.
    expect(gpu.textures.filter((t) => t.width === 200)).toHaveLength(4);
  });

  it('hands a decay node a read and a write texture that swap on flip', () => {
    configure();
    const first = pool.pingPong(DEFAULT_GRAPH_IDS.tracerAbove);
    expect(first.read).not.toBe(first.write);
    pool.flip();
    const second = pool.pingPong(DEFAULT_GRAPH_IDS.tracerAbove);
    expect(second.read).toBe(first.write);
    expect(second.write).toBe(first.read);
  });

  it('gives the fused pass an rgba8unorm diagnostic attachment', () => {
    configure();
    const diagnostic = pool.diagnostic(DEFAULT_GRAPH_IDS.tracerAbove);
    expect(gpu.textures.find((t) => t.label === (diagnostic.write as unknown as { label: string }).label)?.format)
      .toBe('rgba8unorm');
  });

  it('is a no-op when re-configured with the same plan and sizes', () => {
    const plan = configure();
    pool.transient('layer0');
    const before = gpu.textures.length;
    pool.configure(plan, { ...SIZES }, 1);
    expect(pool.transient('layer0')).toBeDefined();
    expect(gpu.textures).toHaveLength(before);
  });

  it('drops every texture when a size changes', () => {
    const plan = configure();
    const stale = pool.transient('layer0');
    pool.configure(plan, { ...SIZES, layer: { width: 200, height: 150 } }, 1);
    expect(gpu.textures.find((t) => t.label === (stale as unknown as { label: string }).label)?.destroyed)
      .toBe(true);
    expect([pool.transient('layer0').width, pool.transient('layer0').height]).toEqual([200, 150]);
  });

  it('shares one multisample target across the band-layer passes', () => {
    configure(undefined, 4);
    expect(pool.msaaTarget()).toBe(pool.msaaTarget());
    expect(gpu.textures.filter((t) => t.sampleCount === 4)).toHaveLength(1);
  });

  it('has no multisample target when antialiasing is off', () => {
    configure(undefined, 1);
    expect(pool.msaaTarget()).toBeNull();
  });

  it('reuses a pooled slot for the blur graph’s transient results', () => {
    const plan = compileGraph(buildBlurGraph(), 'webgpu').allocation;
    pool.configure(plan, SIZES, 1);
    // Both blur passes of a layer route through the pool; the horizontal
    // result's slot comes back for reuse once the vertical pass has read it.
    const shared = plan.slots.filter((slot) => slot.nodes.length > 1);
    expect(shared.length).toBeGreaterThan(0);
  });

  it('refuses a node with no pooled target', () => {
    configure();
    expect(() => pool.transient(DEFAULT_GRAPH_IDS.output)).toThrow(/no pooled render target/);
    expect(pool.writesSwapchain(DEFAULT_GRAPH_IDS.composite)).toBe(true);
  });
});
