import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMotionWorkerHost } from './motionWorkerHost';
import type { MotionFieldRequest } from '../motion.worker';
import { ScriptedWorker } from '../../workers/testing';

function frame(fill: number) {
  return { data: new Uint8ClampedArray(8 * 8 * 4).fill(fill), width: 8, height: 8 };
}

function hostWithScriptedWorker(wasmEnabled = true) {
  const spawned: ScriptedWorker[] = [];
  const host = createMotionWorkerHost(() => wasmEnabled, () => {
    spawned.push(new ScriptedWorker());
    return spawned[spawned.length - 1].asWorker();
  });
  return { host, spawned };
}

describe('createMotionWorkerHost', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs a sample in the worker, transferring a copy of the frame', async () => {
    const { host, spawned } = hostWithScriptedWorker();
    const source = frame(10);
    const sample = host.motionField(source, 4, 0.02, false, true, true);
    await Promise.resolve();

    const [worker] = spawned;
    const { message, transfer } = worker.calls[0];
    expect(message.method).toBe('motion-field');
    const req = message.req as MotionFieldRequest;
    expect(req).toMatchObject({ width: 8, height: 8, divisor: 4, flow: true, useWasm: true });
    expect(transfer).toEqual([req.pixels]);
    expect(source.data.byteLength).toBe(256); // the caller's buffer was not moved

    const field = new Float32Array(4);
    worker.resolveCall(0, { field, flow: null, width: 2, height: 2 });
    await expect(sample).resolves.toEqual({ field, flow: null, width: 2, height: 2, mode: 'worker' });
  });

  it('asks the worker for wasm only while the engine toggle allows it', async () => {
    const { host, spawned } = hostWithScriptedWorker(false);
    void host.motionField(frame(0), 4, 0.02, false, false, true);
    await Promise.resolve();
    expect((spawned[0].calls[0].message.req as MotionFieldRequest).useWasm).toBe(false);
  });

  it('falls back to the inline kernel for good when the worker crashes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { host, spawned } = hostWithScriptedWorker();
    const sample = host.motionField(frame(10), 4, 0.02, false, false, true);
    await Promise.resolve();
    spawned[0].crash('out of memory');

    const result = await sample;
    expect(result?.mode).toBe('inline');
    expect(result?.width).toBe(2);

    // A worker that has already proved broken is not retried every frame.
    const next = await host.motionField(frame(200), 4, 0.02, false, false, true);
    expect(next?.mode).toBe('inline');
    expect(spawned).toHaveLength(1);
    expect(spawned[0].calls).toHaveLength(1);
  });

  it('destroy() rejects the sample in flight and terminates the worker', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { host, spawned } = hostWithScriptedWorker();
    const sample = host.motionField(frame(10), 4, 0.02, false, false, true);
    await Promise.resolve();
    host.destroy();
    // The host's contract is that a sample always produces a field: it falls back inline.
    await expect(sample).resolves.toMatchObject({ mode: 'inline' });
    expect(spawned[0].terminated).toBe(true);
  });
});
