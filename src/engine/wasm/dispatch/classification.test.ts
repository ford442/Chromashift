import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A stand-in for the C++ module that records what the dispatcher handed it, so
 * the test sees both which bytes were copied into the heap and whether the
 * kernel ran at all.
 */
const heap = new Uint8Array(1 << 16);
const requested: number[] = [];
const kernelCalls: Array<{ inPtr: number; width: number; height: number; outPtr: number }> = [];
const mod = {
  HEAPU8: heap,
  _computeClassificationMaskLut: (inPtr: number, width: number, height: number, _avg: number, outPtr: number) => {
    kernelCalls.push({ inPtr, width, height, outPtr });
    heap.fill(3, outPtr, outPtr + width * height);
  },
};

vi.mock('../loadEngine', () => ({
  canUseWasmFn: (fn: string, useWasm: boolean) => useWasm && fn === '_computeClassificationMaskLut',
  getWasmModule: () => mod,
  getPersistentBuf: (size: number) => {
    requested.push(size);
    return 128;
  },
  withWasmScratch: (_mod: unknown, _size: number, work: (ptr: number) => unknown) => work(0),
}));

const { classifyPixelsMaskWith } = await import('./classification');

describe('classifyPixelsMaskWith', () => {
  beforeEach(() => {
    requested.length = 0;
    kernelCalls.length = 0;
    heap.fill(0);
  });

  // The kernel reads exactly width × height × 4 bytes from the heap copy, so a
  // short buffer would be a read past the copy into the rest of the heap.
  it.each([true, false])('throws a RangeError on a short buffer, never calling the kernel (useWasm=%s)', (useWasm) => {
    const data = new Uint8Array(4 * 4 * 4 - 1);
    expect(() => classifyPixelsMaskWith(data, 4, 4, 128, useWasm)).toThrow(RangeError);
    expect(() => classifyPixelsMaskWith(data, 4, 4, 128, useWasm)).toThrow(/short of 4×4 RGBA \(64\)/);
    expect(requested).toEqual([]);
    expect(kernelCalls).toEqual([]);
  });

  it.each([
    [-1, 4],
    [4, -1],
    [1.5, 4],
    [Number.NaN, 4],
    [Number.POSITIVE_INFINITY, 1],
  ])('rejects the image size %s×%s', (width, height) => {
    expect(() => classifyPixelsMaskWith(new Uint8Array(1 << 10), width, height, 128, true)).toThrow(RangeError);
  });

  it('rejects an image whose RGBA byte offsets would not fit in 32 bits', () => {
    // 2^30 pixels is just over UINT32_MAX / 4; the length check never gets
    // that far because the size check comes first.
    expect(() => classifyPixelsMaskWith(new Uint8Array(4), 1 << 15, (1 << 15) + 1, 128, true))
      .toThrow(/pixel limit/);
  });

  it('copies and reserves only width × height RGBA from a longer buffer', () => {
    const data = new Uint8Array(4 * 4 * 4 + 40).fill(9);
    const { mask, width, height } = classifyPixelsMaskWith(data, 4, 4, 128, true);

    expect({ width, height, length: mask.length }).toEqual({ width: 4, height: 4, length: 16 });
    // RGBA input plus one mask byte per pixel — not the padding after it.
    expect(requested).toEqual([4 * 4 * 4 + 16]);
    expect(kernelCalls).toEqual([{ inPtr: 128, width: 4, height: 4, outPtr: 128 + 64 }]);
    // The padding was not copied into the heap.
    expect(heap[128 + 64 + 16]).toBe(0);
  });

  it('classifies the same pixels on the TypeScript lane when the buffer is longer than the image', () => {
    const exact = new Uint8Array(3 * 2 * 4);
    for (let i = 0; i < exact.length; i++) exact[i] = (i * 53) & 0xff;
    const padded = new Uint8Array(exact.length + 24).fill(255);
    padded.set(exact);

    expect(classifyPixelsMaskWith(padded, 3, 2, 128, false).mask)
      .toEqual(classifyPixelsMaskWith(exact, 3, 2, 128, false).mask);
  });

  it('accepts an empty image', () => {
    const { mask } = classifyPixelsMaskWith(new Uint8Array(0), 0, 0, 128, false);
    expect(mask.length).toBe(0);
  });
});
