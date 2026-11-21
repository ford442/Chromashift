/**
 * The particle chain on the WebGPU executor, against the recording fake device:
 * compute passes in the frame's own encoder, indirect dispatch and draw over
 * the ring's control block, the buffer pool's byte accounting, the stage
 * markers, and what pausing and clearing do to the ring.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { buildDefaultGraph } from '../defaultGraph';
import { buildParticlesGraph, PARTICLE_GRAPH_IDS } from '../altGraphs';
import { compileGraph, resetGraphCompileCache } from '../compile';
import {
  APPEND_CONTROL_BYTES,
  APPEND_DISPATCH_ARGS_OFFSET,
  APPEND_DRAW_ARGS_OFFSET,
  PARTICLE_STRIDE,
} from '../nodeKinds';
import { EMIT_UNIFORMS } from '../templates/particles';
import { uniformOffset } from '../templates/uniformLayout';
import type { CompiledGraph, PassGraph } from '../types';
import { createFakeGpu, fakeRendererState, type FakeGpu } from './__fixtures__/fakeDevice';
import { WebGpuGraphExecutor, type GraphEncodeMarks } from './WebGpuGraphExecutor';

const ids = PARTICLE_GRAPH_IDS;
const CANVAS = { width: 640, height: 480 };
const CAPACITY = 2048;

describe('WebGpuGraphExecutor — the particle chain', () => {
  let gpu: FakeGpu;
  let executor: WebGpuGraphExecutor;
  let source: GPUTexture;

  const compile = (graph: PassGraph = buildParticlesGraph(3, { capacity: CAPACITY })): CompiledGraph => {
    resetGraphCompileCache();
    return compileGraph(graph, 'webgpu');
  };

  const encode = (overrides: Record<string, unknown> = {}, marks?: GraphEncodeMarks): void => {
    executor.encode(
      gpu.device.createCommandEncoder(),
      { source, classificationMask: source, hasClassificationMask: false, profileLut: source, motionField: null },
      {
        state: fakeRendererState(overrides),
        outputView: { __texture: 'swapchain' } as unknown as GPUTextureView,
        width: CANVAS.width,
        height: CANVAS.height,
        fps: 30,
        marks,
      },
    );
  };

  /** The emit pass's uniform block, as last written. */
  const emitFrameIndex = (): number => {
    const label = gpu.buffers.find((buffer) => buffer.name === `${ids.emit}:uniforms`)!.label;
    const bytes = gpu.bufferContents.get(label)!;
    return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)[uniformOffset(EMIT_UNIFORMS, 'frameIndex') / 4]!;
  };

  const ringBuffers = () => gpu.buffers.filter((buffer) => buffer.name.startsWith(`persist-buffer:${ids.emit}`));

  beforeEach(() => {
    gpu = createFakeGpu();
    source = gpu.device.createTexture({
      size: [CANVAS.width, CANVAS.height, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    executor = new WebGpuGraphExecutor(
      gpu.device,
      'rgba16float',
      'bgra8unorm',
      gpu.device.createSampler({}),
      gpu.device.createSampler({}),
    );
  });

  it('allocates no buffer and encodes no compute pass for the default graph', () => {
    executor.setGraph(compile(buildDefaultGraph()));
    encode();
    encode();
    expect(executor.bufferBytes()).toBe(0);
    // Uniform blocks only: no graph buffer resource.
    expect(gpu.buffers.filter((buffer) => /buffer:/.test(buffer.name))).toEqual([]);
    expect(gpu.buffers.every((buffer) => buffer.usage === (GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST))).toBe(true);
    expect(gpu.passes.every((pass) => pass.kind === 'render')).toBe(true);
    expect(gpu.computeEntryPoints).toEqual([]);
  });

  it('encodes emit and advect as compute passes in the frame’s encoder, splat as an indirect draw', () => {
    executor.setGraph(compile());
    gpu.reset();
    encode();

    const kinds = gpu.passes.map((pass) => pass.kind);
    // layers ×3, emit, advect, splat, tracer-below, tracer-above, trail, composite.
    expect(kinds).toEqual([
      'render', 'render', 'render', 'compute', 'compute', 'render', 'render', 'render', 'render', 'render',
    ]);
    const [control, items] = [ringBuffers().find((b) => b.name.endsWith(':control'))!, ringBuffers().find((b) => b.name.endsWith(':items'))!];

    const [emit, advect, splat] = gpu.passes.slice(3, 6);
    // The append over the mask's emitter grid, then the one-invocation args kernel.
    expect(emit!.pipelines.map((label) => label.split('#')[0])).toEqual(['cpipe:emit_main', 'cpipe:emit_args']);
    expect(emit!.dispatches).toHaveLength(2);
    expect(emit!.dispatches[1]).toBe('1×1×1');
    // advect runs over the live count, read by the GPU from the control block.
    expect(advect!.indirect).toEqual([`${control.label}@${APPEND_DISPATCH_ARGS_OFFSET}`]);
    expect(advect!.dispatches).toEqual([]);
    // splat: the ring as instance attributes, drawn over the same count.
    expect(splat!.vertexBuffers).toEqual([`0:${items.label}`]);
    expect(splat!.indirect).toEqual([`${control.label}@${APPEND_DRAW_ARGS_OFFSET}`]);
    expect(splat!.draws).toEqual([]);
    expect(splat!.attachments).toHaveLength(1);
    expect(splat!.attachments[0]).toMatch(/@clear$/);
  });

  it('sizes the emitter grid from the mask, not the canvas, at a fixed number of cells across', () => {
    executor.setGraph(compile());
    gpu.reset();
    encode();
    // 640 px layer / 128 cells → spacing 5 → 128 × 96 cells → 16 × 12 workgroups of 8×8.
    expect(gpu.passes[3]!.dispatches[0]).toBe('16×12×1');
  });

  it('creates the ring once, with the usages each stage needs, and counts its bytes', () => {
    executor.setGraph(compile());
    for (let i = 0; i < 4; i += 1) encode();
    const ring = ringBuffers();
    expect(ring).toHaveLength(2);
    const items = ring.find((buffer) => buffer.name.endsWith(':items'))!;
    const control = ring.find((buffer) => buffer.name.endsWith(':control'))!;
    expect(items.size).toBe(CAPACITY * PARTICLE_STRIDE);
    expect(control.size).toBe(APPEND_CONTROL_BYTES);
    expect(items.usage & GPUBufferUsage.STORAGE).toBeTruthy();
    expect(items.usage & GPUBufferUsage.VERTEX).toBeTruthy();
    expect(control.usage & GPUBufferUsage.STORAGE).toBeTruthy();
    expect(control.usage & GPUBufferUsage.INDIRECT).toBeTruthy();
    // The VRAM bound: exactly the capacity and the control block, however many frames.
    expect(executor.bufferBytes()).toBe(CAPACITY * PARTICLE_STRIDE + APPEND_CONTROL_BYTES);
    expect(executor.particleBuffers(ids.splat)).toMatchObject({ capacity: CAPACITY });
  });

  it('keeps the ring across a variant switch that leaves emit in place', () => {
    executor.setGraph(compile());
    encode();
    const first = ringBuffers().map((buffer) => buffer.label);
    // The temporal term on: a different compiled graph, the same emit node.
    executor.setGraph(compile(buildParticlesGraph(3, { capacity: CAPACITY, trailMs: 900 })));
    encode();
    expect(ringBuffers().map((buffer) => buffer.label)).toEqual(first);
    expect(ringBuffers().every((buffer) => !buffer.destroyed)).toBe(true);
    // A new capacity is a new ring.
    executor.setGraph(compile(buildParticlesGraph(3, { capacity: CAPACITY * 2 })));
    encode();
    expect(ringBuffers().filter((buffer) => !buffer.destroyed).map((buffer) => buffer.size))
      .toEqual(expect.arrayContaining([CAPACITY * 2 * PARTICLE_STRIDE]));
    expect(executor.bufferBytes()).toBe(CAPACITY * 2 * PARTICLE_STRIDE + APPEND_CONTROL_BYTES);
  });

  it('counts frames since the last clear into the spawn hash, and clears the ring with the trails', () => {
    executor.setGraph(compile());
    encode();
    encode();
    encode();
    expect(emitFrameIndex()).toBe(2);
    executor.clearAccumulators();
    const ring = ringBuffers().map((buffer) => buffer.label);
    expect(gpu.bufferClears).toEqual(expect.arrayContaining(ring));
    encode();
    expect(emitFrameIndex()).toBe(0);
  });

  it('freezes the particles on a paused frame but still draws them', () => {
    executor.setGraph(compile());
    encode();
    gpu.reset();
    encode({ paused: true });
    expect(gpu.passes.some((pass) => pass.kind === 'compute')).toBe(false);
    expect(gpu.passes.filter((pass) => pass.indirect.length > 0)).toHaveLength(1); // splat
    // And the clock does not move.
    encode();
    expect(emitFrameIndex()).toBe(1);
  });

  it('fires the stage markers in order, around each pass of the chain', () => {
    executor.setGraph(compile());
    gpu.reset();
    const log: string[] = [];
    const mark = (name: string) => () => log.push(`${name}@${gpu.passes.length}`);
    encode({}, {
      layersEnd: mark('layers'),
      emitEnd: mark('emit'),
      advectEnd: mark('advect'),
      splatEnd: mark('splat'),
      stampEnd: mark('stamp'),
      compositorEnd: mark('compositor'),
    });
    // Pass counts when each fires: 3 layers, then one pass per chain stage,
    // then the three accumulators, then the compositor.
    expect(log).toEqual(['layers@3', 'emit@4', 'advect@5', 'splat@6', 'stamp@9', 'compositor@10']);
  });

  it('fires the particle markers together when the graph has no chain', () => {
    executor.setGraph(compile(buildDefaultGraph()));
    gpu.reset();
    const log: string[] = [];
    const mark = (name: string) => () => log.push(`${name}@${gpu.passes.length}`);
    encode({}, {
      layersEnd: mark('layers'),
      emitEnd: mark('emit'),
      advectEnd: mark('advect'),
      splatEnd: mark('splat'),
      stampEnd: mark('stamp'),
      compositorEnd: mark('compositor'),
    });
    expect(log).toEqual(['layers@3', 'emit@3', 'advect@3', 'splat@3', 'stamp@5', 'compositor@6']);
  });

  it('builds the chain’s kernels from layouts reflected off their WGSL', () => {
    executor.setGraph(compile());
    encode();
    expect(gpu.computeEntryPoints).toEqual(['emit_main', 'emit_args', 'advect_main']);
  });
});
