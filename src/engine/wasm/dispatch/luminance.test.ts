import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tsComputeAverageLuminanceStrided } from '../fallbacks/luminance';

/**
 * A stand-in for the C++ module: `_computeAverageLuminanceStrided` is the TS
 * twin run over the heap, so the test sees exactly which bytes were copied in.
 */
const heap = new Uint8Array(1 << 20);
const requested: number[] = [];
const mod = {
  HEAPU8: heap,
  _computeAverageLuminanceStrided: (ptr: number, width: number, height: number, stride: number) =>
    tsComputeAverageLuminanceStrided(heap.subarray(ptr), width, height, stride),
};

vi.mock('../loadEngine', () => ({
  canUseWasmFn: () => true,
  getWasmModule: () => mod,
  getPersistentBuf: (size: number) => {
    requested.push(size);
    return 64;
  },
}));

const { computeAverageLuminanceStridedWith } = await import('./luminance');

function noise(width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i * 2654435761) >>> 24;
  return data;
}

describe('computeAverageLuminanceStridedWith (WASM lane)', () => {
  beforeEach(() => {
    requested.length = 0;
  });

  it.each([3, 7, 30])('copies only the stride-%i samples and averages the same pixels', (stride) => {
    const width = 301;
    const height = 157;
    const pixels = noise(width, height);
    const expected = tsComputeAverageLuminanceStrided(pixels, width, height, stride);

    expect(computeAverageLuminanceStridedWith(pixels, width, height, stride, true)).toBeCloseTo(expected, 9);
    expect(requested).toEqual([Math.ceil(width / stride) * Math.ceil(height / stride) * 4]);
  });

  it('copies exactly width × height RGBA at stride 1, even from a longer buffer', () => {
    const pixels = noise(17, 9);
    const padded = new Uint8Array(pixels.length + 400);
    padded.set(pixels);

    expect(computeAverageLuminanceStridedWith(padded, 17, 9, 1, true))
      .toBeCloseTo(tsComputeAverageLuminanceStrided(pixels, 17, 9, 1), 9);
    expect(requested).toEqual([17 * 9 * 4]);
  });
});
