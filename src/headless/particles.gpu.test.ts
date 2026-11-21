import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { presetGraphSource, type PassGraphSource } from '../engine/graph';
import { buildParticlesGraph, PARTICLE_GRAPH_IDS } from '../engine/graph/altGraphs';
import { applyGraphVariant } from '../engine/graph/variants';
import type { WebGpuGraphExecutor } from '../engine/graph/exec/WebGpuGraphExecutor';
import { APPEND_CONTROL_BYTES, PARTICLE_STRIDE } from '../engine/graph/nodeKinds';
import { findSwiftShaderIcd } from './dawn';
import { compareGolden, GOLDEN_MAX_CHANNEL_DELTA, loadGoldenFixture } from './goldens';
import { renderClip, renderStill } from './render';
import { openHeadlessSession, type HeadlessSession } from './session';

/**
 * The particle chain on a device (#228 C's Dawn, on the goldens' SwiftShader):
 * what a fake device cannot show — that the GPU's own count stays within the
 * ring, that the ring and the VRAM it costs are bounded, and that an offline
 * export is reproducible. The look itself is `__golden__/particles.png`.
 */
const swiftshader = await findSwiftShaderIcd();

const SIZE = 192;
const FPS = 30;

/** The particles preset with its ring at `capacity`. */
function particlesAt(capacity: number): PassGraphSource {
  return {
    name: 'particles',
    build: (variant) => applyGraphVariant(buildParticlesGraph(variant.layerCount, { capacity }), variant),
  };
}

describe.skipIf(!swiftshader)('the particle chain on SwiftShader', () => {
  let session: HeadlessSession;
  let fixture: Awaited<ReturnType<typeof loadGoldenFixture>>;

  /** The renderer's executor: the ring's buffers are its pool's, not the page's. */
  const executor = () => (session.renderer as unknown as { graphExecutor: WebGpuGraphExecutor }).graphExecutor;

  async function readBuffer(buffer: GPUBuffer, size: number): Promise<ArrayBuffer> {
    const { device } = session;
    const staging = device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(buffer, 0, staging, 0, size);
    device.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const bytes = staging.getMappedRange().slice(0);
    staging.unmap();
    staging.destroy();
    return bytes;
  }

  /** The control block the GPU wrote: [head, dispatch x, y, z, vertices, instances, first vertex, first instance]. */
  async function control(): Promise<Uint32Array> {
    const ring = executor().particleBuffers(PARTICLE_GRAPH_IDS.emit);
    if (!ring?.control) throw new Error('No particle ring.');
    return new Uint32Array(await readBuffer(ring.control, APPEND_CONTROL_BYTES));
  }

  beforeAll(async () => {
    session = await openHeadlessSession({ width: SIZE, height: SIZE, rasterizer: 'swiftshader' });
    fixture = await loadGoldenFixture(session);
  });

  afterAll(() => session?.close());

  it('spawns, draws and counts within the capacity, with the bytes the pool accounts for', async () => {
    session.setPassGraph(presetGraphSource('particles'));
    await renderStill(session, fixture.state(3), { width: SIZE, height: SIZE, fps: FPS, frames: 8 });
    const [head, dispatchX, , , vertices, instances] = await control();
    const { capacity } = executor().particleBuffers(PARTICLE_GRAPH_IDS.emit)!;
    expect(head).toBeGreaterThan(0);
    expect(instances).toBe(Math.min(head!, capacity));
    expect(dispatchX).toBe(Math.ceil(instances! / 64));
    expect(vertices).toBe(6);
    expect(executor().bufferBytes()).toBe(capacity * PARTICLE_STRIDE + APPEND_CONTROL_BYTES);
    expect(session.runtimeErrors).toEqual([]);
  });

  it('wraps a full ring in place: the count never passes the capacity, nor the VRAM its size', async () => {
    const capacity = 64;
    session.setPassGraph(particlesAt(capacity));
    let frames = 0;
    for await (const { index } of renderClip(session, fixture.state(3), { width: SIZE, height: SIZE, fps: FPS, frames: 24 })) {
      frames = index + 1;
      const [head, , , , , instances] = await control();
      // A head past twice the capacity is folded back by the args kernel.
      expect(head).toBeLessThan(2 * capacity + 1024);
      expect(instances).toBeLessThanOrEqual(capacity);
      expect(executor().bufferBytes()).toBe(capacity * PARTICLE_STRIDE + APPEND_CONTROL_BYTES);
    }
    expect(frames).toBe(24);
    const [, , , , , instances] = await control();
    expect(instances).toBe(capacity);
    expect(session.runtimeErrors).toEqual([]);
  });

  it('exports the same first frame twice: the spawn is hashed, not random', async () => {
    session.setPassGraph(presetGraphSource('particles'));
    const first = async () => {
      for await (const { frame } of renderClip(session, fixture.state(3), { width: SIZE, height: SIZE, fps: FPS, frames: 1 })) {
        return frame;
      }
      throw new Error('No frame rendered.');
    };
    const a = await first();
    const b = await first();
    const difference = compareGolden(a, b);
    expect(difference.within).toBe(true);
    expect(difference.maxChannelDelta).toBeLessThanOrEqual(GOLDEN_MAX_CHANNEL_DELTA);
  });

  it('clears the ring with the trails', async () => {
    session.setPassGraph(presetGraphSource('particles'));
    await renderStill(session, fixture.state(3), { width: SIZE, height: SIZE, fps: FPS, frames: 4 });
    expect((await control())[0]).toBeGreaterThan(0);
    session.renderer.clearPersistence();
    expect(Array.from(await control())).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
});
