import { beforeEach, describe, expect, it } from 'vitest';
import { compileGraph, graphCompileCount, resetGraphCompileCache } from '../compile';
import { buildGraphPreset, GRAPH_PRESETS, TRAILS3_ECHO_ID } from '../altGraphs';
import { buildDefaultGraph, DEFAULT_GRAPH_IDS } from '../defaultGraph';
import { withMotionTerm } from '../variants';
import type { RendererState } from '../../types/RendererState';
import { createFakeWebGl, type FakeTexture, type FakeWebGl } from './__fixtures__/fakeWebGl';
import { buildEncodePlan } from './plan';
import { WebGLGraphExecutor, type WebGLGraphEncodeParams, type WebGLGraphInputs } from './WebGLGraphExecutor';
import { WebGLProgramCache } from './webglProgramCache';
import { graphTracerDuration } from './uniforms';
import { durationToDecay } from '../../math/decay';

const STATE: RendererState = {
  layers: [{ angleDeg: 0 }, { angleDeg: 10, flipY: true }, { angleDeg: 20 }],
  avgLuminance: 128,
  tracerAboveDuration: 1000,
  tracerBelowDuration: 500,
};

describe('WebGLGraphExecutor', () => {
  let fake: FakeWebGl;
  let executor: WebGLGraphExecutor;
  let inputs: WebGLGraphInputs;
  let source: FakeTexture;

  beforeEach(() => {
    resetGraphCompileCache();
    fake = createFakeWebGl();
    executor = new WebGLGraphExecutor(fake.gl);
    source = fake.gl.createTexture() as unknown as FakeTexture;
    inputs = {
      source: { texture: source as unknown as WebGLTexture, width: 640, height: 480 },
      profileLut: fake.gl.createTexture()!,
      motionField: null,
    };
  });

  const params = (state: RendererState = STATE): WebGLGraphEncodeParams => ({
    state,
    fps: 30,
    layer: { width: 400, height: 300 },
    tracer: { width: 200, height: 150 },
    aspect: 4 / 3,
    output: { target: null, viewport: { x: 0, y: 0, width: 800, height: 600 } },
  });

  const adopt = (graph = buildDefaultGraph()) => {
    const compiled = compileGraph(graph, 'webgl');
    executor.setGraph(compiled);
    expect(executor.prepare()).toBeNull();
    return compiled;
  };

  it('draws the default graph as the plan orders it: three bands, two accumulators, one composite', () => {
    adopt();
    executor.encode(inputs, params());

    expect(fake.draws).toHaveLength(6);
    const [l0, l1, l2, below, above, composite] = fake.draws;
    for (const layer of [l0, l1, l2]) {
      expect(layer.fragment).toContain('uniform int u_layerIndex;');
      expect([layer.target?.width, layer.target?.height]).toEqual([400, 300]);
      expect(layer.samplers.u_source).toBe(source);
    }
    expect([l0, l1, l2].map((draw) => draw.uniforms.u_layerIndex)).toEqual([0, 1, 2]);
    for (const tracer of [below, above]) {
      expect(tracer.fragment).toContain('uniform sampler2D u_previous;');
      expect([tracer.target?.width, tracer.target?.height]).toEqual([200, 150]);
      expect([tracer.samplers.u_layer0, tracer.samplers.u_layer1, tracer.samplers.u_layer2])
        .toEqual([l0.target, l1.target, l2.target]);
    }
    expect(composite.target).toBeNull();
    expect(composite.viewport).toEqual([0, 0, 800, 600]);
    expect(composite.samplers.u_layer0).toBe(l0.target);
  });

  it('links one program per distinct source, and nothing on a parameter change', () => {
    adopt();
    executor.encode(inputs, params());
    // The band layers share one program, the two accumulators another.
    expect(executor.programBuildCount).toBe(3);
    const compiles = graphCompileCount();

    adopt();
    executor.encode(inputs, params({ ...STATE, avgLuminance: 40, tracerAboveDuration: 3000 }));
    expect(executor.programBuildCount).toBe(3);
    expect(graphCompileCount()).toBe(compiles);
  });

  it('shares programs with every executor on the context', () => {
    adopt();
    const second = new WebGLGraphExecutor(fake.gl);
    second.setGraph(compileGraph(buildDefaultGraph(), 'webgl'));
    expect(second.prepare()).toBeNull();
    expect(second.programBuildCount).toBe(0);
    expect(WebGLProgramCache.for(fake.gl).programBuildCount).toBe(3);
  });

  it('ping-pongs each accumulator: this frame reads what the last one wrote', () => {
    adopt();
    executor.encode(inputs, params());
    const first = fake.draws[4];
    fake.draws.length = 0;
    executor.encode(inputs, params());
    const second = fake.draws[4];
    expect(second.samplers.u_previous).toBe(first.target);
    expect(second.target).toBe(first.samplers.u_previous);
    // The compositor reads the history side, as the WebGPU executor does.
    expect(fake.draws[5].samplers.u_tracerAbove).toBe(first.target);
  });

  it('freezes the accumulators on a paused frame', () => {
    adopt();
    executor.encode(inputs, params({ ...STATE, paused: true }));
    expect(fake.draws.filter((draw) => draw.fragment.includes('u_previous'))).toHaveLength(0);
    expect(fake.draws).toHaveLength(4);
  });

  it('skips only the compositor for a composite-less frame', () => {
    adopt();
    executor.encode(inputs, { ...params(), composite: false });
    expect(fake.draws).toHaveLength(5);
    expect(fake.draws.every((draw) => draw.target !== null)).toBe(true);
  });

  it('times an extra timescale by its own node and blends it under the pair', () => {
    adopt(buildGraphPreset('trails3'));
    executor.encode(inputs, params());
    const accumulators = fake.draws.filter((draw) => draw.fragment.includes('u_previous'));
    expect(accumulators).toHaveLength(3);
    // The echo's own 6 s at 30 fps, not either of the session's durations.
    const echoDecay = durationToDecay(graphTracerDuration(6000, 30), 30);
    expect(accumulators.some((draw) => Math.abs(draw.uniforms.u_decay - echoDecay) < 1e-9)).toBe(true);
    const composite = fake.draws[fake.draws.length - 1];
    expect(composite.samplers.u_tracer2).toBeDefined();
    expect(composite.uniforms.u_tracerOpacity2).toBe(0.45);
    expect(executor.encodedPasses()).toContain(TRAILS3_ECHO_ID);
  });

  it.each(GRAPH_PRESETS)('draws ?graph=%s with every pass its plan encodes', (name) => {
    const compiled = adopt(buildGraphPreset(name));
    executor.encode(inputs, params());
    const plan = buildEncodePlan(compiled);
    const historyWrites = plan.steps.filter((step) => step.kind === 'history').length;
    expect(fake.draws).toHaveLength(plan.steps.length + historyWrites);
    expect(fake.draws[fake.draws.length - 1].target).toBeNull();
  });

  it('draws the temporal term with the field bound after the previous frame', () => {
    adopt(withMotionTerm(buildDefaultGraph()));
    const field = fake.gl.createTexture()!;
    executor.encode({ ...inputs, motionField: field }, params({ ...STATE, motionMode: 1 }));
    const accumulators = fake.draws.filter((draw) => draw.fragment.includes('u_previous'));
    expect(accumulators).toHaveLength(2);
    for (const draw of accumulators) {
      expect(draw.samplers.u_motion).toBe(field);
      expect(draw.uniforms.u_motionMode).toBe(1);
    }
  });

  it('writes the smear ring at its head and taps every slot', () => {
    adopt(buildGraphPreset('smear'));
    executor.encode(inputs, params());
    const [write, taps, displace] = fake.draws;
    expect(write.samplers.u_source).toBe(source);
    expect(taps.samplers.u_ring0).toBe(write.target);
    expect(taps.uniforms.u_weight0).toBe(1);
    expect(displace.samplers.u_source).toBe(taps.target);
    // No field from the lanes: a 1×1 zero field, so `displace` is the identity.
    expect([displace.samplers.u_field?.width, displace.samplers.u_field?.height]).toEqual([1, 1]);

    fake.draws.length = 0;
    executor.encode(inputs, params());
    const [nextWrite, nextTaps] = fake.draws;
    expect(nextWrite.target).toBe(nextTaps.samplers.u_ring1);
    expect(nextTaps.uniforms.u_weight1).toBeGreaterThan(nextTaps.uniforms.u_weight0);
  });

  it('keeps the previous graph on the canvas when the context rejects a program', () => {
    const good = adopt();
    executor.encode(inputs, params());

    fake.rejectShader((source) => source.includes('u_displace'));
    const bad = compileGraph(buildGraphPreset('feedback'), 'webgl');
    executor.setGraph(bad);
    expect(executor.prepare()).toContain('rejected by the fake context');
    expect(executor.ready).toBe(false);
    expect(executor.readyFrame()?.compiled).toBe(good);

    fake.draws.length = 0;
    executor.encode(inputs, params());
    expect(fake.draws).toHaveLength(6);
    expect(fake.draws.some((draw) => draw.fragment.includes('u_displace'))).toBe(false);
    expect(executor.drawnGraph).toBe(good);
  });

  it('recomposites the last frame for the readbacks without advancing it', () => {
    adopt();
    executor.encode(inputs, params());
    const tracers = executor.outputTargets()!.tracers;
    fake.draws.length = 0;
    const target = { texture: fake.gl.createTexture()!, framebuffer: fake.gl.createFramebuffer()!, width: 64, height: 64 };
    expect(executor.composite(inputs, { ...STATE, mainViewMode: 6 }, {
      target,
      viewport: { x: 0, y: 0, width: 64, height: 64 },
    })).toBe(true);
    expect(fake.draws).toHaveLength(1);
    expect(fake.draws[0].uniforms.u_mainViewMode).toBe(6);
    expect(executor.outputTargets()!.tracers).toEqual(tracers);
  });

  it('names the accumulators in the compositor order', () => {
    adopt();
    executor.encode(inputs, params());
    const outputs = executor.outputTargets()!;
    expect(outputs.layers.map((t) => t.texture)).toEqual(fake.draws.slice(0, 3).map((draw) => draw.target));
    // After the frame the read side is what it just wrote: below, then above.
    expect(outputs.tracers.map((t) => t.texture)).toEqual([fake.draws[3].target, fake.draws[4].target]);
    expect(compileGraph(buildDefaultGraph(), 'webgl').outputs.tracers)
      .toEqual([DEFAULT_GRAPH_IDS.tracerBelow, DEFAULT_GRAPH_IDS.tracerAbove]);
  });

  describe('MSAA', () => {
    it('multisamples the band layers only, resolving each into its layer texture', () => {
      adopt();
      executor.setSampleCount(4);
      executor.encode(inputs, params());

      const [l0, l1, l2, below, above, composite] = fake.draws;
      for (const layer of [l0, l1, l2]) {
        expect(layer.samples).toBe(4);
        expect(layer.target).toBeNull();
        expect([layer.renderbuffer?.width, layer.renderbuffer?.height]).toEqual([400, 300]);
      }
      // One shared renderbuffer, as WebGPU shares one MSAA texture.
      expect(new Set([l0, l1, l2].map((draw) => draw.renderbuffer)).size).toBe(1);
      for (const pass of [below, above, composite]) expect(pass.samples).toBe(1);
      expect(composite.target).toBeNull();
      expect(composite.renderbuffer).toBeNull();

      const layers = executor.outputTargets()!.layers.map((t) => t.texture);
      expect(fake.blits.map((blit) => blit.to)).toEqual(layers);
      expect(fake.blits.every((blit) => blit.from === l0.renderbuffer)).toBe(true);
      // The accumulators read the resolved textures, never the renderbuffer.
      expect(below.samplers.u_layer0).toBe(layers[0]);
      expect(executor.layerSampleCount).toBe(4);
    });

    it('reallocates the renderbuffer on a toggle, on the same context', () => {
      adopt();
      executor.setSampleCount(4);
      executor.encode(inputs, params());
      const first = fake.renderbuffers[0];

      executor.setSampleCount(1);
      executor.encode(inputs, params());
      expect(first.deleted).toBe(true);
      expect(fake.draws.slice(-6).every((draw) => draw.samples === 1)).toBe(true);
      expect(executor.layerSampleCount).toBe(1);

      executor.setSampleCount(4);
      executor.encode(inputs, params());
      expect(fake.renderbuffers).toHaveLength(2);
      expect(fake.renderbuffers[1].deleted).toBe(false);
    });

    it('draws single-sample where the format allows no multisampling', () => {
      fake = createFakeWebGl({ sampleCounts: [] });
      executor = new WebGLGraphExecutor(fake.gl);
      adopt();
      executor.setSampleCount(4);
      executor.encode(inputs, params());
      expect(fake.renderbuffers).toHaveLength(0);
      expect(fake.draws.every((draw) => draw.samples === 1)).toBe(true);
    });
  });

  describe('internal format', () => {
    const gl = (fakeGl: FakeWebGl) => fakeGl.gl as unknown as Record<'RGBA8' | 'RGBA16F', number>;

    it('stays RGBA8 without a renderable half-float extension, and still draws', () => {
      adopt();
      executor.encode(inputs, params());
      expect(executor.internalFormat).toBe('rgba8');
      expect(fake.draws).toHaveLength(6);
      const pooled = fake.draws.slice(0, 5).map((draw) => draw.target!);
      expect(pooled.every((t) => t.internalFormat === gl(fake).RGBA8)).toBe(true);
    });

    it('allocates layer, tracer and MSAA targets as RGBA16F under EXT_color_buffer_half_float', () => {
      fake = createFakeWebGl({ extensions: ['EXT_color_buffer_half_float'] });
      executor = new WebGLGraphExecutor(fake.gl);
      adopt();
      executor.encode(inputs, params());
      expect(executor.internalFormat).toBe('rgba16f');
      const pooled = fake.draws.slice(0, 5).map((draw) => draw.target!);
      expect(pooled.every((t) => t.internalFormat === gl(fake).RGBA16F)).toBe(true);

      // The resolve blits between equal formats (the fake throws otherwise).
      executor.setSampleCount(4);
      executor.encode(inputs, params());
      expect(fake.renderbuffers[0].internalFormat).toBe(gl(fake).RGBA16F);
      expect(fake.blits).toHaveLength(3);
    });
  });
});

describe('the context program cache', () => {
  it('outlives a renderer torn down after its replacement started drawing', () => {
    resetGraphCompileCache();
    const fake = createFakeWebGl();
    const compiled = compileGraph(buildDefaultGraph(), 'webgl');
    const old = new WebGLGraphExecutor(fake.gl);
    old.setGraph(compiled);
    expect(old.prepare()).toBeNull();

    const replacement = new WebGLGraphExecutor(fake.gl);
    replacement.setGraph(compiled);
    expect(replacement.prepare()).toBeNull();
    old.destroy();
    old.destroy();

    // The replacement's programs are still the cache's, and still linked.
    expect(WebGLProgramCache.for(fake.gl).programBuildCount).toBe(3);
    replacement.destroy();
    expect(WebGLProgramCache.for(fake.gl).programBuildCount).toBe(0);
  });
});
