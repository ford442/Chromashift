import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lucasKanadeFlow, type LuminancePlane } from '../../compute/chores/motionKernel';

const heap = new Float32Array(1 << 14);
const requested: number[] = [];
const kernelCalls: number[][] = [];
const mod = {
  HEAPF32: heap,
  _computeMotionFlow: (...args: number[]) => {
    kernelCalls.push(args);
  },
};

vi.mock('../loadEngine', () => ({
  canUseWasmFn: (_fn: string, useWasm: boolean) => useWasm,
  getWasmModule: () => mod,
  getPersistentBuf: (size: number) => {
    requested.push(size);
    return 64;
  },
}));

const { computeMotionFlowWith } = await import('./motion');

function plane(width: number, height: number, length = width * height): LuminancePlane {
  const lum = new Float32Array(length);
  for (let i = 0; i < length; i++) lum[i] = ((i * 37) % 17) / 17;
  return { lum, width, height };
}

describe('computeMotionFlowWith', () => {
  beforeEach(() => {
    requested.length = 0;
    kernelCalls.length = 0;
  });

  // The kernel reads width × height floats from each plane; a plane that holds
  // fewer is a read past its copy, one that holds more silently misaligns the
  // second plane's offset.
  it.each([true, false])('throws a RangeError when a plane does not hold width × height cells (useWasm=%s)', (useWasm) => {
    expect(() => computeMotionFlowWith(plane(4, 4, 15), plane(4, 4), useWasm)).toThrow(RangeError);
    expect(() => computeMotionFlowWith(plane(4, 4), plane(4, 4, 17), useWasm)).toThrow(/previous plane holds 17/);
    expect(() => computeMotionFlowWith(plane(4, 4, 16 * 4), null, useWasm)).toThrow(/current plane holds 64/);
    expect(requested).toEqual([]);
    expect(kernelCalls).toEqual([]);
  });

  it('answers a missing or resized history with a zero field, without calling the kernel', () => {
    expect(computeMotionFlowWith(plane(4, 4), null, true)).toEqual(new Float32Array(32));
    expect(computeMotionFlowWith(plane(4, 4), plane(2, 2), true)).toEqual(new Float32Array(32));
    expect(kernelCalls).toEqual([]);
  });

  it('lays the two planes and the output out back to back in one allocation', () => {
    computeMotionFlowWith(plane(4, 4), plane(4, 4), true);

    expect(requested).toEqual([16 * 4 * 4]);
    expect(kernelCalls).toEqual([[64, 64 + 64, 4, 4, 64 + 128]]);
  });

  it('runs the portable kernel on the TypeScript lane', () => {
    const current = plane(8, 8);
    const previous = plane(8, 8, 64);
    previous.lum.reverse();
    expect(computeMotionFlowWith(current, previous, false)).toEqual(lucasKanadeFlow(current, previous).flow);
  });
});
