import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkerRpc } from './rpc';
import { LoopbackWorker, ScriptedWorker } from './testing';

type EchoProtocol = {
  echo: (req: { text: string }) => { text: string };
  sum: (req: { buffer: ArrayBuffer }) => { total: number; buffer: ArrayBuffer };
  fail: (req: { message: string }) => never;
  slow: (req: { steps: number }) => { done: true };
};

function loopback() {
  return new LoopbackWorker<EchoProtocol, number>({
    echo: (req) => ({ text: req.text.toUpperCase() }),
    sum: (req, ctx) => {
      const bytes = new Uint8Array(req.buffer);
      ctx.transfer(req.buffer);
      return { total: bytes.reduce((a, b) => a + b, 0), buffer: req.buffer };
    },
    fail: (req) => { throw new Error(req.message); },
    slow: async (req, ctx) => {
      for (let i = 1; i <= req.steps; i++) ctx.progress(i);
      return { done: true };
    },
  });
}

describe('createWorkerRpc', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not construct the worker until the first call', async () => {
    const factory = vi.fn(() => loopback().asWorker());
    const rpc = createWorkerRpc<EchoProtocol, number>(factory, { label: 'echo' });
    expect(factory).not.toHaveBeenCalled();
    await expect(rpc.call('echo', { text: 'hi' })).resolves.toEqual({ text: 'HI' });
    await rpc.call('echo', { text: 'again' });
    expect(factory).toHaveBeenCalledTimes(1);
    rpc.terminate();
  });

  it('round-trips through exposeWorkerRpc, transferring in both directions', async () => {
    const rpc = createWorkerRpc<EchoProtocol, number>(() => loopback().asWorker(), { label: 'echo' });
    const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
    const res = await rpc.call('sum', { buffer }, { transfer: [buffer] });
    expect(buffer.byteLength).toBe(0); // moved, not copied
    expect(res.total).toBe(10);
    expect(res.buffer.byteLength).toBe(4);
    rpc.terminate();
  });

  it('turns a throwing handler into a rejection of that call alone', async () => {
    const rpc = createWorkerRpc<EchoProtocol, number>(() => loopback().asWorker(), { label: 'echo' });
    const failing = rpc.call('fail', { message: 'model 404' });
    const sibling = rpc.call('echo', { text: 'ok' });
    await expect(failing).rejects.toThrow('model 404');
    await expect(sibling).resolves.toEqual({ text: 'OK' });
    rpc.terminate();
  });

  it('delivers progress to the call that asked for it, before it resolves', async () => {
    const rpc = createWorkerRpc<EchoProtocol, number>(() => loopback().asWorker(), { label: 'echo' });
    const seen: number[] = [];
    await rpc.call('slow', { steps: 3 }, { onProgress: (p) => seen.push(p) });
    expect(seen).toEqual([1, 2, 3]);
    rpc.terminate();
  });

  it('rejects an unknown method rather than hanging', async () => {
    const rpc = createWorkerRpc<EchoProtocol & { missing: (req: null) => null }, number>(
      () => loopback().asWorker(),
      { label: 'echo' },
    );
    await expect(rpc.call('missing', null)).rejects.toThrow('unknown method "missing"');
    rpc.terminate();
  });

  it('correlates out-of-order replies by id', async () => {
    const worker = new ScriptedWorker();
    const rpc = createWorkerRpc<EchoProtocol>(() => worker.asWorker(), { label: 'echo' });
    const first = rpc.call('echo', { text: 'a' });
    const second = rpc.call('echo', { text: 'b' });
    worker.resolveCall(1, { text: 'second' });
    worker.resolveCall(0, { text: 'first' });
    await expect(first).resolves.toEqual({ text: 'first' });
    await expect(second).resolves.toEqual({ text: 'second' });
    expect(rpc.pending).toBe(0);
  });

  it('rejects every call in flight when the worker crashes, and respawns on the next call', async () => {
    const workers: ScriptedWorker[] = [];
    const rpc = createWorkerRpc<EchoProtocol>(() => {
      workers.push(new ScriptedWorker());
      return workers[workers.length - 1].asWorker();
    }, { label: 'echo' });

    const a = rpc.call('echo', { text: 'a' });
    const b = rpc.call('echo', { text: 'b' });
    workers[0].crash('out of memory');
    await expect(a).rejects.toThrow('echo worker: out of memory');
    await expect(b).rejects.toThrow('echo worker: out of memory');
    expect(rpc.pending).toBe(0);
    expect(workers[0].terminated).toBe(true);

    const c = rpc.call('echo', { text: 'c' });
    expect(workers).toHaveLength(2);
    workers[1].resolveCall(0, { text: 'C' });
    await expect(c).resolves.toEqual({ text: 'C' });
  });

  it('rejects every call in flight on messageerror but keeps the worker', async () => {
    const workers: ScriptedWorker[] = [];
    const rpc = createWorkerRpc<EchoProtocol>(() => {
      workers.push(new ScriptedWorker());
      return workers[workers.length - 1].asWorker();
    }, { label: 'echo' });

    const a = rpc.call('echo', { text: 'a' });
    workers[0].messageError();
    await expect(a).rejects.toThrow('could not be deserialized');

    const b = rpc.call('echo', { text: 'b' });
    expect(workers).toHaveLength(1);
    workers[0].resolveCall(1, { text: 'B' });
    await expect(b).resolves.toEqual({ text: 'B' });
  });

  it('rejects when the factory or postMessage throws, leaving nothing pending', async () => {
    const throwing = createWorkerRpc<EchoProtocol>(() => { throw new Error('no Worker'); }, { label: 'echo' });
    await expect(throwing.call('echo', { text: 'x' })).rejects.toThrow('no Worker');
    expect(throwing.pending).toBe(0);

    const worker = new ScriptedWorker();
    worker.throwOnPostMessage = new Error('DataCloneError');
    const rpc = createWorkerRpc<EchoProtocol>(() => worker.asWorker(), { label: 'echo' });
    await expect(rpc.call('echo', { text: 'x' })).rejects.toThrow('DataCloneError');
    expect(rpc.pending).toBe(0);
  });

  it('times a call out on its own, and ignores the late reply', async () => {
    vi.useFakeTimers();
    const worker = new ScriptedWorker();
    const rpc = createWorkerRpc<EchoProtocol>(() => worker.asWorker(), { label: 'echo', timeoutMs: 1000 });
    const slow = rpc.call('echo', { text: 'slow' });
    const patient = rpc.call('echo', { text: 'patient' }, { timeoutMs: 0 });
    vi.advanceTimersByTime(1000);
    await expect(slow).rejects.toThrow('"echo" timed out after 1000 ms');
    worker.resolveCall(0, { text: 'late' }); // no pending entry: dropped
    worker.resolveCall(1, { text: 'PATIENT' });
    await expect(patient).resolves.toEqual({ text: 'PATIENT' });
  });

  it('terminate() rejects what is in flight and terminates the worker', async () => {
    const worker = new ScriptedWorker();
    const rpc = createWorkerRpc<EchoProtocol>(() => worker.asWorker(), { label: 'echo' });
    const call = rpc.call('echo', { text: 'x' });
    rpc.terminate('host destroyed');
    await expect(call).rejects.toThrow('echo worker: host destroyed');
    expect(worker.terminated).toBe(true);
  });
});
