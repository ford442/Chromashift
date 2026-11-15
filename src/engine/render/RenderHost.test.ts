import { describe, expect, it, vi } from 'vitest';
import { FrameClock, type FrameScheduler } from '../frame/FrameClock';
import type { RenderWorkerPageScope } from '../graph/capabilities';
import type { RendererOrchestrator, RendererSlot } from '../RendererOrchestrator';
import type { ChromashiftRenderer } from '../types/RendererContracts';
import { ScriptedWorker } from '../workers/testing';
import type { RenderLoopInput } from './protocol';
import { RenderHost, type RenderHostBootRequest } from './RenderHost';

const IDLE_SCHEDULER: FrameScheduler = { request: () => 0, cancel: () => {} };

const PAGE: RenderWorkerPageScope = {
  Worker: class {},
  OffscreenCanvas: class {},
  HTMLCanvasElement: class { transferControlToOffscreen(): void {} },
  navigator: { gpu: {} },
};

const BOOT: RenderHostBootRequest = {
  backend: 'webgpu',
  antialias: false,
  colorSpace: 'srgb',
  canvasHdr: false,
  passGraph: 'default',
  retry: false,
};

function fakeCanvas(width = 300, height = 150) {
  const offscreen = { offscreen: true, width, height };
  const canvas = { width, height, transferControlToOffscreen: vi.fn(() => offscreen) };
  return { canvas, offscreen, element: canvas as unknown as HTMLCanvasElement };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function loopInput(running = true): RenderLoopInput {
  return { running, fps: 30, extensions: [1, 2, 3], reactive: false, main: {} as RenderLoopInput['main'], layout: 'single', compareB: null, hud: { enabled: false, autoDegrade: false } } as RenderLoopInput;
}

/** A host on the worker transport, booted on `canvas`; the worker is scripted. */
async function bootedWorkerHost() {
  const worker = new ScriptedWorker();
  const host = new RenderHost({
    clock: new FrameClock({ scheduler: IDLE_SCHEDULER }),
    createWorker: () => worker.asWorker(),
    search: () => '?graph=blur',
    pageScope: PAGE,
  });
  const main = fakeCanvas();
  const booted = host.boot(main.element, BOOT);
  await flush();
  expect(worker.calls.map((c) => c.message.method)).toEqual(['probe']);
  worker.resolveCall(0, { gpu: true, offscreenContext: true, adapter: true, scheduler: 'raf' });
  await flush();
  const notifiesBeforeBoot = worker.notifies.length;
  worker.resolveCall(1, { ok: true, backend: 'webgpu', fallbackReason: null });
  await expect(booted).resolves.toMatchObject({ ok: true });
  return { worker, host, main, notifiesBeforeBoot };
}

const methods = (worker: ScriptedWorker) => worker.notifies.map((n) => n.message.method);

describe('RenderHost on the worker transport', () => {
  it('probes the worker, then boots it with the main canvas transferred', async () => {
    const { worker, host, main } = await bootedWorkerHost();
    expect(host.transport).toBe('worker');
    const boot = worker.calls[1]!;
    expect(boot.message.method).toBe('boot');
    expect(boot.message.req).toMatchObject({
      ...BOOT,
      pageSearch: '?graph=blur',
      debug: false,
      surface: { canvasId: 1, canvas: main.offscreen, width: 300, height: 150 },
    });
    expect(boot.transfer).toEqual([main.offscreen]);
    expect(main.canvas.transferControlToOffscreen).toHaveBeenCalledTimes(1);
  });

  it('hands a canvas over once: after that it is named by id', async () => {
    const { worker, host, main } = await bootedWorkerHost();
    const b = fakeCanvas(64, 32);
    host.attach('compare-b', b.element);
    host.detach('compare-b');
    host.attach('compare-b', b.element);
    const attaches = worker.notifies.filter((n) => n.message.method === 'attach');
    expect(attaches[0]!.message.req).toEqual({ slot: 'compare-b', surface: { canvasId: 2, canvas: b.offscreen, width: 64, height: 32 } });
    expect(attaches[0]!.transfer).toEqual([b.offscreen]);
    expect(attaches[1]!.message.req).toEqual({ slot: 'compare-b', surface: { canvasId: 2, width: 64, height: 32 } });
    expect(attaches[1]!.transfer).toEqual([]);
    expect(b.canvas.transferControlToOffscreen).toHaveBeenCalledTimes(1);

    // A second boot (Retry GPU) names the main canvas too.
    void host.boot(main.element, { ...BOOT, retry: true });
    await flush();
    expect(worker.calls[2]!.message.req).toMatchObject({ retry: true, surface: { canvasId: 1, width: 300, height: 150 } });
    expect(worker.calls[2]!.message.req).not.toHaveProperty('surface.canvas');
  });

  it('keeps a transferred canvas’s size itself and posts it as a resize', async () => {
    const { worker, host, main } = await bootedWorkerHost();
    expect(host.sizeCanvas(main.element, 640, 480)).toBe(true);
    expect(host.sizeCanvas(main.element, 640, 480)).toBe(false);
    // The element is a placeholder now: only the worker's OffscreenCanvas resizes.
    expect(main.canvas.width).toBe(300);
    expect(host.canvasSize(main.element)).toEqual({ width: 640, height: 480 });
    host.flushResize();
    const resize = worker.notifies.find((n) => n.message.method === 'resize')!;
    expect(resize.message.req).toEqual({ surfaces: [{ canvasId: 1, width: 640, height: 480 }] });
  });

  it('sizes a canvas it has not handed over directly', async () => {
    const { host } = await bootedWorkerHost();
    const b = fakeCanvas(10, 10);
    host.sizeCanvas(b.element, 20, 30);
    expect(b.canvas).toMatchObject({ width: 20, height: 30 });
  });

  it('coalesces the loop inputs of one task into one message, the latest', async () => {
    const { worker, host } = await bootedWorkerHost();
    const before = methods(worker).filter((m) => m === 'set-loop').length;
    host.setLoop({ ...loopInput(), fps: 24 });
    host.setLoop({ ...loopInput(), fps: 25 });
    host.setLoop({ ...loopInput(), fps: 26 });
    expect(methods(worker).filter((m) => m === 'set-loop')).toHaveLength(before);
    await Promise.resolve();
    const loops = worker.notifies.filter((n) => n.message.method === 'set-loop');
    expect(loops).toHaveLength(before + 1);
    expect(loops.at(-1)!.message.req).toMatchObject({ fps: 26 });

    host.stopLoop();
    await Promise.resolve();
    expect(worker.notifies.filter((n) => n.message.method === 'set-loop').at(-1)!.message.req).toMatchObject({ running: false });
  });

  it('replays what the page said before the transport was chosen', async () => {
    const worker = new ScriptedWorker();
    const host = new RenderHost({
      clock: new FrameClock({ scheduler: IDLE_SCHEDULER }),
      createWorker: () => worker.asWorker(),
      search: () => '',
      pageScope: PAGE,
    });
    host.setLoop({ ...loopInput(), fps: 12 });
    host.setAngles([10, 20, 30]);
    void host.boot(fakeCanvas().element, BOOT);
    await flush();
    worker.resolveCall(0, { gpu: true, offscreenContext: true, adapter: true, scheduler: 'raf' });
    await flush();
    expect(worker.notifies.map((n) => [n.message.method, n.message.req])).toEqual([
      ['set-loop', expect.objectContaining({ fps: 12 })],
      ['set-angles', { angles: [10, 20, 30] }],
    ]);
    expect(worker.calls[1]!.message.method).toBe('boot');
  });

  it('caches the angles and motion demand the worker reports', async () => {
    const { worker, host } = await bootedWorkerHost();
    const telemetry = vi.fn();
    host.on('telemetry', telemetry);
    worker.reply({ rpc: 'event', event: 'telemetry', payload: { angles: [1, 2, 3] } });
    worker.reply({ rpc: 'event', event: 'motion-demand', payload: { wantsCpu: true, use: { reads: true, needsFlow: false } } });
    expect(telemetry).toHaveBeenCalledWith({ angles: [1, 2, 3] });
    expect(host.currentAngles()).toEqual([1, 2, 3]);
    expect(host.motionDemand.wantsCpu).toBe(true);
  });

  it('a crashed worker is a non-recoverable error, and later boots report it', async () => {
    const { worker, host, main } = await bootedWorkerHost();
    const errors = vi.fn();
    host.on('runtime-error', errors);
    worker.crash('render worker died');
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({ kind: 'bootstrap', recoverable: false }));
    await expect(host.boot(main.element, { ...BOOT, retry: true })).resolves.toMatchObject({
      ok: false,
      error: { kind: 'bootstrap', recoverable: false },
    });
  });

  it('falls back to the main transport when the worker half is withheld, and stops the worker', async () => {
    const worker = new ScriptedWorker();
    const host = new RenderHost({
      clock: new FrameClock({ scheduler: IDLE_SCHEDULER }),
      createWorker: () => worker.asWorker(),
      search: () => '',
      pageScope: PAGE,
      serviceDeps: { probeWebGPU: async () => ({ ok: false, stage: 'adapter', reason: 'none' }) as never },
    });
    const main = fakeCanvas();
    const booted = host.boot(main.element, BOOT);
    await flush();
    worker.resolveCall(0, { gpu: true, offscreenContext: false, adapter: true, scheduler: 'raf' });
    await booted;
    expect(host.transport).toBe('main');
    expect(worker.terminated).toBe(true);
    expect(main.canvas.transferControlToOffscreen).not.toHaveBeenCalled();
  });
});

describe('RenderHost on the main transport', () => {
  function fakeOrchestrator() {
    const renderer = { backend: 'webgl', setAntialiasing: vi.fn() } as unknown as ChromashiftRenderer;
    const slot = { id: 'main', canvas: null, renderer } as RendererSlot;
    return {
      getBackend: () => 'webgl',
      getFallbackReason: () => null,
      setPassGraph: vi.fn(),
      setCanvasColorSpace: vi.fn(),
      setCanvasPresentation: vi.fn(),
      getSlot: (id: string) => (id === 'main' ? slot : undefined),
      listSlots: () => [slot],
      destroySlot: vi.fn(),
      destroy: vi.fn(),
      sharedDevice: () => null,
    } as unknown as RendererOrchestrator;
  }

  it('runs the service in-process on the page’s canvas, with no worker', async () => {
    const createWorker = vi.fn();
    const bootstrap = vi.fn(async () => ({ orchestrator: fakeOrchestrator() }));
    const host = new RenderHost({
      clock: new FrameClock({ scheduler: IDLE_SCHEDULER }),
      createWorker,
      search: () => '?renderer=webgl',
      pageScope: PAGE,
      serviceDeps: { bootstrap },
    });
    const main = fakeCanvas();
    await expect(host.boot(main.element, { ...BOOT, backend: 'webgl' })).resolves.toMatchObject({ ok: true, backend: 'webgl' });
    expect(host.transport).toBe('main');
    expect(createWorker).not.toHaveBeenCalled();
    expect(bootstrap).toHaveBeenCalledWith(expect.objectContaining({ primaryCanvas: main.element }));
    expect(main.canvas.transferControlToOffscreen).not.toHaveBeenCalled();

    // The element is sized directly; nothing waits for a flush.
    host.sizeCanvas(main.element, 50, 60);
    expect(main.canvas).toMatchObject({ width: 50, height: 60 });
  });

  it('answers the live angles exactly, synchronously', async () => {
    const host = new RenderHost({
      clock: new FrameClock({ scheduler: IDLE_SCHEDULER }),
      transport: 'main',
      search: () => '',
      serviceDeps: { bootstrap: async () => ({ orchestrator: fakeOrchestrator() }) },
    });
    await host.boot(fakeCanvas().element, { ...BOOT, backend: 'webgl' });
    host.setAngles([5, 6, 7]);
    expect(host.currentAngles()).toEqual([5, 6, 7]);
    await expect(host.getAngles()).resolves.toEqual([5, 6, 7]);
  });
});
