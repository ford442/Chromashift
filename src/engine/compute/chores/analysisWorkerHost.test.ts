import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkerChromashiftCpuHost } from './analysisWorkerHost';
import type { AnalysisRequest, AnalysisResponse } from '../analysis.worker';

type Listener<T> = (event: T) => void;

/** Minimal fake `Worker` — captures posted messages and lets the test drive replies. */
class FakeWorker {
  posted: Array<{ message: AnalysisRequest; transfer?: Transferable[] }> = [];
  private messageListeners: Listener<MessageEvent<AnalysisResponse>>[] = [];
  private errorListeners: Listener<ErrorEvent>[] = [];
  throwOnPostMessage: Error | null = null;

  postMessage(message: AnalysisRequest, transfer?: Transferable[]): void {
    if (this.throwOnPostMessage) throw this.throwOnPostMessage;
    this.posted.push({ message, transfer });
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    if (type === 'message') this.messageListeners.push(listener as Listener<MessageEvent<AnalysisResponse>>);
    if (type === 'error') this.errorListeners.push(listener as Listener<ErrorEvent>);
  }

  removeEventListener(): void {}

  reply(response: AnalysisResponse): void {
    const event = { data: response } as MessageEvent<AnalysisResponse>;
    for (const listener of this.messageListeners) listener(event);
  }

  fail(message: string): void {
    const event = { error: new Error(message), message } as ErrorEvent;
    for (const listener of this.errorListeners) listener(event);
  }
}

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
    expect(worker!.posted).toHaveLength(1);
    expect(worker!.posted[0].message.op).toBe('image-analysis');
    expect(worker!.posted[0].transfer).toHaveLength(1);

    worker!.reply({
      id: worker!.posted[0].message.id,
      kind: 'image-analysis',
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

    expect(worker!.posted[0].message.op).toBe('average-luminance');
    worker!.reply({ id: worker!.posted[0].message.id, kind: 'average-luminance', avgLuminance: 77 });

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

    expect(worker!.posted).toHaveLength(2);
    const [firstId, secondId] = worker!.posted.map((p) => p.message.id);

    // Reply to the second request first.
    worker!.reply({ id: secondId, kind: 'average-luminance', avgLuminance: 222 });
    worker!.reply({ id: firstId, kind: 'average-luminance', avgLuminance: 111 });

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
    worker!.reply({ id: worker!.posted[0].message.id, kind: 'error', message: 'boom' });

    const result = await resultPromise;
    expect(result.avgLuminance).toBeCloseTo(50, 4);
    expect(result.mode).toBe('inline');

    // Once the worker has failed, subsequent calls skip it entirely.
    const secondResult = await host.computeAverageLuminance(fakeImage(), false);
    expect(secondResult.avgLuminance).toBeCloseTo(50, 4);
    expect(secondResult.mode).toBe('inline');
    expect(worker!.posted).toHaveLength(1);
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
