import { beforeAll, describe, expect, it } from 'vitest';
import { GpuReadback, packRgbaRows } from './GpuReadback';
import type { WebGPUPipelines } from './WebGPUPipelines';
import { installWebGpuConstants } from '../graph/exec/__fixtures__/fakeDevice';

/** A device whose every staging buffer maps to `mapped`, as the GPU would have filled it. */
function deviceMapping(mapped: Uint8Array): GPUDevice {
  return {
    createSampler: () => ({}),
    createRenderPipeline: () => ({}),
    createBuffer: (descriptor: GPUBufferDescriptor) => ({
      size: descriptor.size,
      mapAsync: () => Promise.resolve(),
      getMappedRange: () => mapped.slice().buffer,
      unmap: () => {},
      destroy: () => {},
    }),
    createCommandEncoder: () => ({
      copyTextureToBuffer: () => {},
      finish: () => ({}),
    }),
    queue: { submit: () => {} },
  } as unknown as GPUDevice;
}

const pipelines = {
  persistDiagnosticBlitBGL: {},
  createPersistDiagnosticBlitPipeline: () => Promise.resolve({}),
} as unknown as WebGPUPipelines;

/** One row of pixels, padded to the 256-byte copy pitch. */
function paddedRow(pixels: number[][]): Uint8Array {
  const row = new Uint8Array(256);
  pixels.forEach((px, i) => row.set(px, i * 4));
  return row;
}

beforeAll(() => {
  installWebGpuConstants();
  const g = globalThis as Record<string, unknown>;
  g.GPUBufferUsage ??= { MAP_READ: 1, COPY_DST: 8 };
  g.GPUMapMode ??= { READ: 1, WRITE: 2 };
});

describe('packRgbaRows', () => {
  it('strips the row padding and leaves rgba bytes alone', () => {
    const mapped = new Uint8Array(512);
    mapped.set([1, 2, 3, 4], 0);
    mapped.set([5, 6, 7, 8], 256);
    expect([...packRgbaRows(mapped, 256, 1, 2, 'rgba8unorm')]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('swaps R and B for a bgra texture', () => {
    const mapped = paddedRow([[0, 0, 255, 255], [0, 255, 0, 255]]);
    expect([...packRgbaRows(mapped, 256, 2, 1, 'bgra8unorm')]).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
  });
});

describe('GpuReadback.readTexturePixels', () => {
  // A pure-red frame rendered into a bgra8unorm target lands in memory as
  // B, G, R, A = 0, 0, 255, 255. PNG/video export and the stationary previews
  // all read the result as RGBA, so the readback must hand back red.
  it('returns RGBA from a bgra8unorm target', async () => {
    const red = paddedRow([[0, 0, 255, 255]]);
    const readback = new GpuReadback(deviceMapping(red), 'bgra8unorm', pipelines);
    const texture = { format: 'bgra8unorm', width: 1, height: 1 } as GPUTexture;

    const result = await readback.readTexturePixels(texture, 1, 1);
    expect([...result!.data]).toEqual([255, 0, 0, 255]);
  });

  it('returns rgba8unorm bytes unchanged', async () => {
    const red = paddedRow([[255, 0, 0, 255]]);
    const readback = new GpuReadback(deviceMapping(red), 'rgba8unorm', pipelines);
    const texture = { format: 'rgba8unorm', width: 1, height: 1 } as GPUTexture;

    const result = await readback.readTexturePixels(texture, 1, 1);
    expect([...result!.data]).toEqual([255, 0, 0, 255]);
  });
});
