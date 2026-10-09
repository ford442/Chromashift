import { beforeEach, describe, expect, it } from 'vitest';
import { WebGPUPipelines } from '../../WebGPUPipelines';
import { buildBlurGraph, buildGraphPreset, buildWarpGraph } from '../altGraphs';
import { compileGraph, graphCompileCount, resetGraphCompileCache } from '../compile';
import { buildDefaultGraph } from '../defaultGraph';
import type { CompiledGraph } from '../types';
import { createFakeGpu, fakeRendererState, type FakeGpu } from './__fixtures__/fakeDevice';
import { WebGpuGraphExecutor } from './WebGpuGraphExecutor';

const CANVAS = { width: 640, height: 480 };

describe('WebGpuGraphExecutor', () => {
  let gpu: FakeGpu;
  let executor: WebGpuGraphExecutor;
  /** Stands in for the image texture; the pool does not own it. */
  let source: GPUTexture;

  const build = (sampleCount = 1): WebGpuGraphExecutor => {
    const pipelines = new WebGPUPipelines(gpu.device, 'bgra8unorm', 'rgba16float');
    const created = new WebGpuGraphExecutor(
      gpu.device,
      pipelines,
      'rgba16float',
      'bgra8unorm',
      gpu.device.createSampler({}),
      gpu.device.createSampler({}),
    );
    created.setSampleCount(sampleCount);
    return created;
  };

  const encode = (
    exec: WebGpuGraphExecutor,
    overrides: Record<string, unknown> = {},
    motionField: GPUTexture | null = null,
  ): void => {
    exec.encode(
      gpu.device.createCommandEncoder(),
      {
        source,
        classificationMask: source,
        hasClassificationMask: false,
        profileLut: source,
        motionField,
      },
      {
        state: fakeRendererState(overrides),
        outputView: { __texture: 'swapchain' } as unknown as GPUTextureView,
        width: CANVAS.width,
        height: CANVAS.height,
        fps: 30,
      },
    );
  };

  const compile = (graph = buildDefaultGraph()): CompiledGraph => {
    resetGraphCompileCache();
    return compileGraph(graph, 'webgpu');
  };

  beforeEach(() => {
    gpu = createFakeGpu();
    source = gpu.device.createTexture({
      size: [CANVAS.width, CANVAS.height, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    executor = build();
  });

  it('stands down until a graph is adopted', () => {
    expect(executor.active).toBe(false);
    encode(executor);
    expect(gpu.passes).toHaveLength(0);
  });

  it('encodes the default graph as five passes ending on the swapchain', () => {
    executor.setGraph(compile());
    gpu.reset();
    encode(executor);

    // layers ×3, tracer-below, tracer-above, composite — the hand encoder's
    // topology, with no standalone coincidence pass.
    expect(gpu.passes).toHaveLength(6);
    expect(gpu.passes.map((pass) => pass.draws)).toEqual(Array.from({ length: 6 }, () => [6]));
    expect(gpu.passes.at(-1)!.attachments).toEqual(['swapchain@clear']);
    expect(executor.encodedPasses()).toEqual([
      'layer0', 'layer1', 'layer2', 'tracer-below', 'tracer-above', 'composite',
    ]);
  });

  it('gives each accumulator pass its tracer target and a diagnostic attachment', () => {
    executor.setGraph(compile());
    gpu.reset();
    encode(executor);
    for (const pass of gpu.passes.slice(3, 5)) {
      expect(pass.attachments).toHaveLength(2);
    }
  });

  it('resolves the band-layer passes through one MSAA target', () => {
    const msaaExecutor = build(4);
    msaaExecutor.setGraph(compile());
    gpu.reset();
    encode(msaaExecutor);
    const resolves = gpu.passes.filter((pass) => pass.attachments[0].includes('->'));
    // Exactly the three band-layer passes are multisampled, as in the hand
    // encoder — the blur and compositor passes are not.
    expect(resolves).toHaveLength(3);
    // One shared multisample source, three distinct resolve targets.
    const sources = new Set(resolves.map((pass) => pass.attachments[0].split('->')[0]));
    expect(sources.size).toBe(1);
  });

  it('does not recreate a pipeline when a parameter changes', () => {
    const compiled = compile();
    executor.setGraph(compiled);
    encode(executor);
    const pipelinesAfterFirstFrame = executor.pipelineBuildCount;
    const compilesAfterFirstFrame = graphCompileCount();

    // Re-compiling the same topology hits the structural-hash cache, and the
    // executor keys its pipelines on that hash — so a slider move costs neither.
    executor.setGraph(compileGraph(buildDefaultGraph(), 'webgpu'));
    encode(executor, { layerOpacity: 0.25, tracerAboveDuration: 4000, layerBlendMode: 2 });
    encode(executor, { stampBoost: 3.1, tracerThreshold: 0.4 });

    expect(executor.pipelineBuildCount).toBe(pipelinesAfterFirstFrame);
    expect(graphCompileCount()).toBe(compilesAfterFirstFrame);
  });

  it('reuses bind groups across frames whose textures did not change', () => {
    executor.setGraph(compile());
    encode(executor);
    gpu.reset();
    encode(executor);
    // The tracer pair swaps every frame, so the two accumulator passes and the
    // compositor rebind; the three band-layer passes must not.
    expect(gpu.bindGroupCount).toBeLessThanOrEqual(3);
  });

  it('freezes the accumulators when the session is paused', () => {
    executor.setGraph(compile());
    gpu.reset();
    encode(executor, { paused: true });
    expect(gpu.passes).toHaveLength(4);
    const before = executor.roleTextures()!.tracerAbove;
    encode(executor, { paused: true });
    expect(executor.roleTextures()!.tracerAbove).toBe(before);
  });

  it('flips the tracer pair on an unpaused frame', () => {
    executor.setGraph(compile());
    encode(executor);
    const first = executor.roleTextures()!.tracerAbove;
    encode(executor);
    expect(executor.roleTextures()!.tracerAbove).not.toBe(first);
  });

  it('composites the previous frame\u2019s tracer, as the hand encoder does', () => {
    // `encodeFrameCore` samples the tracer textures *before* the persistence
    // pass flips the ping-pong, so the shipped compositor reads the history
    // side of the pair. The executor keeps that frame of latency to match it.
    executor.setGraph(compile());
    encode(executor);
    gpu.reset();
    encode(executor);

    const written = gpu.passes
      .slice(3, 5)
      .map((pass) => pass.attachments[0].split('@')[0]);
    const compositorBindGroup = gpu.bindGroups
      .find((group) => group.label === gpu.passes.at(-1)!.bindGroup);
    expect(compositorBindGroup).toBeDefined();
    for (const target of written) {
      expect(compositorBindGroup!.textures).not.toContain(target);
    }
  });

  it('publishes the role textures the preview and readback passes read', () => {
    executor.setGraph(compile());
    encode(executor);
    const roles = executor.roleTextures()!;
    expect(roles.layers).toHaveLength(3);
    expect(roles.layers[0]).not.toBe(roles.layers[1]);
    expect(roles.tracerBelow).not.toBe(roles.tracerAbove);
    expect(roles.diagnostic.format).toBe('rgba8unorm');
  });

  it('draws the blur graph without a hand-written blur pass', () => {
    executor.setGraph(compile(buildBlurGraph()));
    gpu.reset();
    encode(executor);
    // 3 layers + 6 blur + 2 accumulators + compositor.
    expect(gpu.passes).toHaveLength(12);
    expect(gpu.fragments.filter((source) => source.includes('BlurUniforms'))).toHaveLength(6);
  });

  it('draws the warp graph from the emitted warp template', () => {
    executor.setGraph(compile(buildWarpGraph()));
    gpu.reset();
    encode(executor);
    expect(gpu.passes).toHaveLength(7);
    expect(gpu.fragments.filter((source) => source.includes('WarpUniforms'))).toHaveLength(1);
  });

  it('never binds a compute pipeline — the fragment fused pass is the contract', () => {
    executor.setGraph(compile());
    gpu.reset();
    encode(executor);
    expect(gpu.fragments.some((source) => source.includes('FragmentOutputs'))).toBe(true);
    expect(gpu.fragments.some((source) => source.includes('@compute'))).toBe(false);
  });

  it('clears the accumulators the pool owns', () => {
    // `clearPersistence()` has to reach these: while the graph draws they *are*
    // the tracer state, so clearing only the hand encoder's pass would leave
    // the trails the user asked to drop.
    executor.setGraph(compile());
    encode(executor);
    gpu.reset();
    executor.clearAccumulators();

    // Two ping-pong pairs plus their two diagnostic pairs: eight clears.
    expect(gpu.passes).toHaveLength(8);
    expect(gpu.passes.every((pass) => pass.attachments[0].endsWith('@clear'))).toBe(true);
    expect(gpu.passes.every((pass) => pass.draws.length === 0)).toBe(true);
  });

  it('clears nothing before a graph has allocated anything', () => {
    executor.setGraph(compile());
    gpu.reset();
    executor.clearAccumulators();
    expect(gpu.passes).toHaveLength(0);
  });

  describe('device verdict on the pipelines', () => {
    it('is not ready to draw until the device has accepted its pipelines', async () => {
      executor.setGraph(compile());
      expect(executor.active).toBe(true);
      expect(executor.ready).toBe(false);
      await expect(executor.prepare()).resolves.toBeNull();
      expect(executor.ready).toBe(true);
    });

    it('never becomes ready when the device rejects an emitted shader', async () => {
      // How a real device reports WGSL it will not compile: not a throw, but an
      // error in the enclosing scope and an invalid pipeline that would drop
      // every frame's command buffer.
      gpu.rejectShadersContaining('WarpUniforms', 'textureSample must only be called from uniform control flow');
      executor.setGraph(compile(buildWarpGraph()));
      await expect(executor.prepare()).resolves.toMatch(/uniform control flow/);
      expect(executor.ready).toBe(false);
    });

    it('answers a superseded build with the verdict on the current one', async () => {
      gpu.rejectShadersContaining('WarpUniforms', 'rejected');
      executor.setGraph(compile(buildWarpGraph()));
      const stale = executor.prepare();
      executor.setGraph(compile());
      const current = executor.prepare();
      // The warp graph's rejection must not refuse the default graph that
      // replaced it before the device answered.
      await expect(stale).resolves.toBeNull();
      await expect(current).resolves.toBeNull();
      expect(executor.ready).toBe(true);
    });

    it('re-verifies after a sample-count change, and the hand encoder draws meanwhile', async () => {
      executor.setGraph(compile());
      await executor.prepare();
      executor.setSampleCount(4);
      expect(executor.ready).toBe(false);
      await executor.prepare();
      expect(executor.ready).toBe(true);
    });

    it('verifying builds nothing that encoding would not have built', async () => {
      executor.setGraph(compile());
      await executor.prepare();
      const built = executor.pipelineBuildCount;
      await executor.prepare();
      encode(executor);
      expect(executor.pipelineBuildCount).toBe(built);
    });
  });

  it('releases every pooled texture on destroy', () => {
    executor.setGraph(compile());
    encode(executor);
    // The source texture is not the pool's to free; every texture it made is.
    const sourceLabel = (source as unknown as { label: string }).label;
    const pooled = gpu.textures.filter((t) => t.label !== sourceLabel);
    expect(pooled.length).toBeGreaterThan(0);
    executor.destroy();
    expect(pooled.every((t) => t.destroyed)).toBe(true);
    expect(gpu.textures.find((t) => t.label === sourceLabel)!.destroyed).toBe(false);
  });
  describe('history and displace (the body-smear starter)', () => {
    const smear = () => compile(buildGraphPreset('smear'));
    const label = (texture: GPUTexture) => (texture as unknown as { label: string }).label;
    /** Texture labels a recorded pass wrote, without the load op. */
    const written = (index: number) => gpu.passes[index].attachments[0].split('@')[0];

    it('writes the ring, mixes its taps and displaces before the band layers', () => {
      executor.setGraph(smear());
      gpu.reset();
      encode(executor);

      expect(executor.encodedPasses()).toEqual([
        'smear-history', 'smear-displace',
        'layer0', 'layer1', 'layer2', 'tracer-below', 'tracer-above', 'composite',
      ]);
      // The history node owns two passes: the ring write, then the taps mix.
      expect(gpu.passes).toHaveLength(9);
      expect(written(0)).not.toBe(written(1));
      expect(gpu.fragments.filter((code) => code.includes('HistoryUniforms'))).toHaveLength(1);
      expect(gpu.fragments.filter((code) => code.includes('DisplaceUniforms'))).toHaveLength(1);
      expect(executor.wantsMotionField).toBe(true);
      expect(executor.ringTextureCount()).toBe(4);
    });

    it('advances the ring head every frame, through all four slots', () => {
      executor.setGraph(smear());
      const heads: string[] = [];
      for (let frame = 0; frame < 5; frame += 1) {
        gpu.reset();
        encode(executor);
        heads.push(written(0));
      }
      expect(new Set(heads.slice(0, 4)).size).toBe(4);
      expect(heads[4]).toBe(heads[0]);
    });

    it('binds the ring once, however far the head moves', () => {
      executor.setGraph(smear());
      encode(executor);
      encode(executor);
      const taps = gpu.passes.at(-8)!;
      gpu.reset();
      encode(executor);
      encode(executor);
      // Nothing about the taps pass rebinds: the head is a uniform, not a binding.
      expect(gpu.passes.at(-8)!.bindGroup).toBe(taps.bindGroup);
    });

    it('skips the ring write while paused, freezing the trail', () => {
      executor.setGraph(smear());
      encode(executor);
      gpu.reset();
      encode(executor, { paused: true });
      // No ring write and no accumulators: taps, displace, 3 layers, composite.
      expect(gpu.passes).toHaveLength(6);
    });

    it('binds the motion field it is given, and a zero field when it has none', () => {
      const field = gpu.device.createTexture({
        size: [160, 120, 1],
        format: 'rgba16float',
        usage: GPUTextureUsage.TEXTURE_BINDING,
      });
      executor.setGraph(smear());
      gpu.reset();
      encode(executor, {}, field);
      const displace = () => gpu.bindGroups.find((group) => group.label === gpu.passes[2].bindGroup)!;
      expect(displace().textures[1]).toBe(label(field));

      gpu.reset();
      encode(executor, {}, null);
      const fallback = displace();
      expect(fallback.textures).toHaveLength(2);
      expect(fallback.textures[1]).not.toBe(label(field));
      const zero = gpu.textures.find((t) => t.label === fallback.textures[1])!;
      expect([zero.width, zero.height, zero.format]).toEqual([1, 1, 'rgba16float']);
    });

    it('does not recreate a pipeline when a tap or gain value changes', () => {
      executor.setGraph(smear());
      encode(executor);
      const built = executor.pipelineBuildCount;
      const tweaked = buildGraphPreset('smear');
      for (const node of tweaked.nodes) {
        if (node.kind === 'history') Object.assign(node.params, { mode: 'tap', delay: 2, falloff: 0.9 });
        if (node.kind === 'displace') Object.assign(node.params, { gain: 3, mode: 'forward' });
      }
      executor.setGraph(compileGraph(tweaked, 'webgpu'));
      encode(executor);
      expect(executor.pipelineBuildCount).toBe(built);
    });

    it('releases the ring when the graph switches back to the default', () => {
      executor.setGraph(smear());
      encode(executor);
      const before = new Set(gpu.textures.map((t) => t.label));
      expect(executor.ringTextureCount()).toBe(4);

      executor.setGraph(compile());
      encode(executor);
      expect(executor.ringTextureCount()).toBe(0);
      expect(executor.wantsMotionField).toBe(false);
      const stillLive = gpu.textures.filter(
        (t) => before.has(t.label) && !t.destroyed && t.width > 1,
      );
      // Only the caller's source texture survives the switch (and the 1×1 zero
      // field, which lives as long as the executor).
      expect(stillLive.map((t) => t.label)).toEqual([label(source)]);
    });

    it('clears the ring with the tracers on reset', () => {
      executor.setGraph(smear());
      encode(executor);
      gpu.reset();
      executor.clearAccumulators();
      // Eight tracer clears (see above) plus the four ring slots.
      expect(gpu.passes).toHaveLength(12);
    });
  });
});
