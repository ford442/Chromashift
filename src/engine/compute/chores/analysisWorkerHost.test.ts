import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkerChromashiftCpuHost } from './analysisWorkerHost';
import { ScriptedWorker as FakeWorker } from '../../workers/testing';

function fakeImage(): HTMLImageElement {
  return {} as HTMLImageElement;
}

function fakeBitmap(): ImageBitmap {
  return { close: vi.fn() } as unknown as ImageBitmap;
}

describe('createWorkerChromashiftCpuHost', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('runs analyzeImage through the worker and reports mode: worker', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => fakeBitmap()));
    let worker: FakeWorker | null = null;
    const host = createWorkerChromashiftCpuHost(() => true, () => {
      worker = new FakeWorker();
      return worker as unknown as Worker;
    });

    const resultPromise = host.analyzeImage(fakeImage(), undefined, true);
    await Promise.resolve();
    await Promise.resolve();

    expect(worker).not.toBeNull();
    expect(worker!.calls).toHaveLength(1);
    expect(worker!.calls[0].message.method).toBe('image-analysis');
    expect(worker!.calls[0].transfer).toHaveLength(1);

    worker!.resolveCall(0, {
      avgLuminance: 100,
      mask: new Uint8Array([1, 2, 3]),
      width: 3,
      height: 1,
    });

    const result = await resultPromise;
    expect(result).toEqual({
      avgLuminance: 100,
      mask: new Uint8Array([1, 2, 3]),
      width: 3,
      height: 1,
      mode: 'worker',
    });
  });

  it('runs computeAverageLuminance through the worker', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => fakeBitmap()));
    let worker: FakeWorker | null = null;
    const host = createWorkerChromashiftCpuHost(() => true, () => {
      worker = new FakeWorker();
      return worker as unknown as Worker;
    });

    const resultPromise = host.computeAverageLuminance(fakeImage(), true);
    await Promise.resolve();
    await Promise.resolve();

    expect(worker!.calls[0].message.method).toBe('average-luminance');
    worker!.resolveCall(0, { avgLuminance: 77 });

    await expect(resultPromise).resolves.toEqual({ avgLuminance: 77, mode: 'worker' });
  });

  it('correlates concurrent requests by id even when replies arrive out of order', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => fakeBitmap()));
    let worker: FakeWorker | null = null;
    const host = createWorkerChromashiftCpuHost(() => true, () => {
      worker = new FakeWorker();
      return worker as unknown as Worker;
    });

    const first = host.computeAverageLuminance(fakeImage(), true);
    const second = host.computeAverageLuminance(fakeImage(), true);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(worker!.calls).toHaveLength(2);
    // Reply to the second request first.
    worker!.resolveCall(1, { avgLuminance: 222 });
    worker!.resolveCall(0, { avgLuminance: 111 });

    await expect(first).resolves.toEqual({ avgLuminance: 111, mode: 'worker' });
    await expect(second).resolves.toEqual({ avgLuminance: 222, mode: 'worker' });
  });

  it('falls back to the in-process host when the worker reports an error', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => fakeBitmap()));
    let worker: FakeWorker | null = null;
    const host = createWorkerChromashiftCpuHost(() => false, () => {
      worker = new FakeWorker();
      return worker as unknown as Worker;
    });

    // Stub document so the in-process fallback's canvas path can run.
    vi.stubGlobal('document', {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage: () => {},
          getImageData: (_x: number, _y: number, w: number, h: number) => ({
            data: new Uint8ClampedArray(w * h * 4).fill(50),
            width: w,
            height: h,
          }),
        }),
      }),
    });

    const resultPromise = host.computeAverageLuminance(fakeImage(), false);
    await Promise.resolve();
    await Promise.resolve();
    worker!.rejectCall(0, 'boom');

    const result = await resultPromise;
    expect(result.avgLuminance).toBeCloseTo(50, 4);
    expect(result.mode).toBe('inline');

    // Once the worker has failed, subsequent calls skip it entirely.
    const secondResult = await host.computeAverageLuminance(fakeImage(), false);
    expect(secondResult.avgLuminance).toBeCloseTo(50, 4);
    expect(secondResult.mode).toBe('inline');
    expect(worker!.calls).toHaveLength(1);
  });

  it('falls back to the in-process host when the worker crashes mid-job', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => fakeBitmap()));
    vi.stubGlobal('document', {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage: () => {},
          getImageData: (_x: number, _y: number, w: number, h: number) => ({
            data: new Uint8ClampedArray(w * h * 4).fill(30),
            width: w,
            height: h,
          }),
        }),
      }),
    });
    let worker: FakeWorker | null = null;
    const host = createWorkerChromashiftCpuHost(() => false, () => {
      worker = new FakeWorker();
      return worker as unknown as Worker;
    });

    const resultPromise = host.computeAverageLuminance(fakeImage(), false);
    await Promise.resolve();
    await Promise.resolve();
    worker!.crash('failed to fetch dynamically imported module');

    const result = await resultPromise;
    expect(result.avgLuminance).toBeCloseTo(30, 4);
    expect(result.mode).toBe('inline');
  });

  it('falls back to the in-process host when postMessage throws', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => fakeBitmap()));
    vi.stubGlobal('document', {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage: () => {},
          getImageData: (_x: number, _y: number, w: number, h: number) => ({
            data: new Uint8ClampedArray(w * h * 4).fill(9),
            width: w,
            height: h,
          }),
        }),
      }),
    });

    const host = createWorkerChromashiftCpuHost(() => false, () => {
      const w = new FakeWorker();
      w.throwOnPostMessage = new Error('construction failed');
      return w as unknown as Worker;
    });

    const result = await host.computeAverageLuminance(fakeImage(), false);
    expect(result.avgLuminance).toBeCloseTo(9, 4);
    expect(result.mode).toBe('inline');
  });

  it('falls back to the in-process host when createImageBitmap rejects, without touching the worker', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('CORS'); }));
    vi.stubGlobal('document', {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage: () => {},
          getImageData: (_x: number, _y: number, w: number, h: number) => ({
            data: new Uint8ClampedArray(w * h * 4).fill(20),
            width: w,
            height: h,
          }),
        }),
      }),
    });

    const workerFactory = vi.fn(() => new FakeWorker() as unknown as Worker);
    const host = createWorkerChromashiftCpuHost(() => false, workerFactory);

    const result = await host.computeAverageLuminance(fakeImage(), false);
    expect(result.avgLuminance).toBeCloseTo(20, 4);
    expect(result.mode).toBe('inline');
    // The bitmap transfer never got as far as constructing the worker.
    expect(workerFactory).not.toHaveBeenCalled();
  });
});
