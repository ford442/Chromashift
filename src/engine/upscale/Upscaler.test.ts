import { describe, expect, it } from 'vitest';
import { Upscaler, type UpscaleModel } from './Upscaler';
import { ScriptedWorker } from '../workers/testing';

const SWIN: UpscaleModel = { kind: 'swin_unet', style: 'art', scale: 2, noise: 0, tileSize: 64 };

function upscalerWithScriptedWorkers() {
  const spawned: ScriptedWorker[] = [];
  const spawn = () => {
    const worker = new ScriptedWorker();
    spawned.push(worker);
    return worker.asWorker();
  };
  return { upscaler: new Upscaler({ tf: spawn, onnx: spawn }), spawned };
}

const pixels = () => new Uint8ClampedArray(4 * 4 * 4).fill(128);

/** Lets the call reach `postMessage`. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Upscaler', () => {
  it('spawns no worker until a job runs', () => {
    const { spawned } = upscalerWithScriptedWorkers();
    expect(spawned).toHaveLength(0);
  });

  it('transfers a copy of the pixels, relays progress, and resolves with the result', async () => {
    const { upscaler, spawned } = upscalerWithScriptedWorkers();
    const source = pixels();
    const progress: number[] = [];
    const job = upscaler.upscale(source, 4, 4, SWIN, (p) => progress.push(p.progress));
    await flush();

    const worker = spawned[0]!;
    expect(worker.calls[0]!.message.method).toBe('upscale');
    expect(worker.calls[0]!.transfer).toHaveLength(1);
    expect(source.byteLength).toBe(64); // the caller's buffer was not the one moved
    expect(upscaler.isBusy()).toBe(true);

    worker.progressCall(0, { progress: 50, info: 'Upscaling 50%' });
    worker.resolveCall(0, { pixels: new ArrayBuffer(8 * 8 * 4), width: 8, height: 8 });
    const result = await job;
    expect(progress).toEqual([50]);
    expect(result.width).toBe(8);
    expect(result.pixels).toBeInstanceOf(Uint8ClampedArray);
    expect(upscaler.isBusy()).toBe(false);
  });

  it('rejects and clears busy when the worker crashes mid-job, then recovers on a fresh worker', async () => {
    const { upscaler, spawned } = upscalerWithScriptedWorkers();
    const job = upscaler.upscale(pixels(), 4, 4, SWIN);
    await flush();
    expect(upscaler.isBusy()).toBe(true);

    spawned[0]!.crash('Out of memory');
    await expect(job).rejects.toThrow('Out of memory');
    expect(upscaler.isBusy()).toBe(false);
    expect(spawned[0]!.terminated).toBe(true);

    // The Upscale button is not dead: the next job runs on a new worker.
    const retry = upscaler.upscale(pixels(), 4, 4, SWIN);
    await flush();
    expect(spawned).toHaveLength(2);
    spawned[1]!.resolveCall(0, { pixels: new ArrayBuffer(4), width: 1, height: 1 });
    await expect(retry).resolves.toMatchObject({ width: 1, height: 1 });
    expect(upscaler.isBusy()).toBe(false);
  });

  it('rejects and clears busy when the worker reports an error (e.g. a model 404)', async () => {
    const { upscaler, spawned } = upscalerWithScriptedWorkers();
    const job = upscaler.upscale(pixels(), 4, 4, SWIN);
    await flush();
    spawned[0]!.rejectCall(0, 'HTTP 404 fetching swin_unet/art/scale2x.onnx');
    await expect(job).rejects.toThrow('HTTP 404');
    expect(upscaler.isBusy()).toBe(false);
    expect(spawned[0]!.terminated).toBe(false); // a handled error keeps the worker
  });

  it('refuses a second job while one is running, without disturbing the first', async () => {
    const { upscaler, spawned } = upscalerWithScriptedWorkers();
    const first = upscaler.upscale(pixels(), 4, 4, SWIN);
    await expect(upscaler.upscale(pixels(), 4, 4, SWIN)).rejects.toThrow('already running');
    expect(upscaler.isBusy()).toBe(true);
    await flush();
    spawned[0]!.resolveCall(0, { pixels: new ArrayBuffer(4), width: 1, height: 1 });
    await expect(first).resolves.toMatchObject({ width: 1 });
  });

  it('destroy() rejects the job in flight', async () => {
    const { upscaler, spawned } = upscalerWithScriptedWorkers();
    const job = upscaler.upscale(pixels(), 4, 4, SWIN);
    await flush();
    upscaler.destroy();
    await expect(job).rejects.toThrow('upscaler destroyed');
    expect(spawned[0]!.terminated).toBe(true);
    expect(upscaler.isBusy()).toBe(false);
  });
});
