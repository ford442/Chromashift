import { describe, expect, it, vi } from 'vitest';
import type { RenderWorkerPageScope, RenderWorkerScopeReport } from '../graph/capabilities';
import { isMainTransportForced, selectRenderTransport } from './transport';

class FakeCanvas {
  transferControlToOffscreen(): void {}
}

const FULL_PAGE: RenderWorkerPageScope = {
  Worker: class {},
  OffscreenCanvas: class {},
  HTMLCanvasElement: FakeCanvas,
  navigator: { gpu: {} },
};

const FULL_WORKER: RenderWorkerScopeReport = { gpu: true, offscreenContext: true, adapter: true, scheduler: 'raf' };

function select(options: {
  backend?: 'webgpu' | 'webgl';
  search?: string;
  pageScope?: RenderWorkerPageScope;
  probe?: () => Promise<RenderWorkerScopeReport>;
} = {}) {
  const probeWorker = vi.fn(options.probe ?? (async () => FULL_WORKER));
  const choice = selectRenderTransport({
    backend: options.backend ?? 'webgpu',
    search: options.search ?? '',
    pageScope: options.pageScope ?? FULL_PAGE,
    probeWorker,
  });
  return { choice, probeWorker };
}

describe('isMainTransportForced', () => {
  it('reads ?renderer=main, in any case, and nothing else', () => {
    expect(isMainTransportForced('?renderer=main')).toBe(true);
    expect(isMainTransportForced('?a=1&renderer=MAIN')).toBe(true);
    expect(isMainTransportForced('?renderer=webgpu')).toBe(false);
    expect(isMainTransportForced('')).toBe(false);
  });
});

describe('selectRenderTransport', () => {
  it('runs WebGPU in the worker when both halves of render-worker hold', async () => {
    const { choice, probeWorker } = select();
    await expect(choice).resolves.toEqual({
      kind: 'worker',
      reason: "render-worker: OffscreenCanvas + WebGPU in a worker, paced by the worker's requestAnimationFrame",
    });
    expect(probeWorker).toHaveBeenCalledTimes(1);
  });

  it('names the timeout pacer when the worker has no requestAnimationFrame', async () => {
    const { choice } = select({ probe: async () => ({ ...FULL_WORKER, scheduler: 'timeout' }) });
    await expect(choice).resolves.toMatchObject({ kind: 'worker', reason: expect.stringContaining('a timeout pacer') });
  });

  it('keeps WebGL (and WebXR with it) on the page without asking a worker', async () => {
    const { choice, probeWorker } = select({ backend: 'webgl' });
    await expect(choice).resolves.toMatchObject({ kind: 'main' });
    expect(probeWorker).not.toHaveBeenCalled();
  });

  it('honours ?renderer=main without asking a worker', async () => {
    const { choice, probeWorker } = select({ search: '?renderer=main' });
    await expect(choice).resolves.toEqual({ kind: 'main', reason: 'forced by ?renderer=main' });
    expect(probeWorker).not.toHaveBeenCalled();
  });

  it.each([
    ['Worker', { Worker: undefined }, 'this page has no Worker'],
    ['OffscreenCanvas', { OffscreenCanvas: undefined }, 'this browser has no OffscreenCanvas'],
    ['transferControlToOffscreen', { HTMLCanvasElement: class {} }, 'canvas.transferControlToOffscreen is unavailable'],
    ['navigator.gpu', { navigator: {} }, 'navigator.gpu is unavailable on the page'],
  ])('withholds the bit when the page has no %s', async (_name, patch, why) => {
    const { choice, probeWorker } = select({ pageScope: { ...FULL_PAGE, ...patch } });
    await expect(choice).resolves.toEqual({ kind: 'main', reason: `render-worker withheld: ${why}` });
    expect(probeWorker).not.toHaveBeenCalled();
  });

  it.each([
    [{ gpu: false }, 'navigator.gpu is unavailable in a worker'],
    [{ offscreenContext: false }, "an OffscreenCanvas in a worker has no 'webgpu' context"],
    [{ adapter: false }, 'no WebGPU adapter answered in a worker'],
  ])('withholds the bit on what the worker found (%o)', async (patch, why) => {
    const { choice } = select({ probe: async () => ({ ...FULL_WORKER, ...patch }) });
    await expect(choice).resolves.toEqual({ kind: 'main', reason: `render-worker withheld: ${why}` });
  });

  it('treats a worker that never answers as a no', async () => {
    const { choice } = select({ probe: () => Promise.reject(new Error('timed out')) });
    await expect(choice).resolves.toEqual({
      kind: 'main',
      reason: 'render-worker withheld: the worker probe failed (timed out)',
    });
  });
});
