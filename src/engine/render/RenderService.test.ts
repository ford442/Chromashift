import { describe, expect, it, vi } from 'vitest';
import { FrameClock } from '../frame/FrameClock';
import type { FrameScheduler } from '../frame/FrameClock';
import type { GpuRuntimeError } from '../gpu/gpuErrors';
import type { BootstrapRendererOrchestratorOptions, RendererOrchestrator, RendererSlot } from '../RendererOrchestrator';
import type { ChromashiftRenderer } from '../types/RendererContracts';
import type { RendererState } from '../types/RendererState';
import type { WebGpuProbeResult } from '../webgpu/webgpuProbe';
import type { RpcHandlerContext } from '../workers/rpc';
import type { RenderBootRequest, RenderEvents } from './protocol';
import { RenderService } from './RenderService';

/** A scheduler that never fires: the tests step the clock offline. */
const IDLE_SCHEDULER: FrameScheduler = { request: () => 0, cancel: () => {} } as unknown as FrameScheduler;

const CTX = { transfer: () => {}, progress: () => {} } as unknown as RpcHandlerContext<never>;

function fakeRenderer() {
  return {
    backend: 'webgpu' as const,
    render: vi.fn(),
    getRenderTiming: vi.fn(() => ({ lastCpuMs: 1, averageCpuMs: 1, gpu: { last: null } })),
    clearPersistence: vi.fn(),
    restoreRenderSize: vi.fn(),
    exportFrame: vi.fn(async (_state: RendererState, options: { width: number; height: number }) => ({
      data: new Uint8ClampedArray(options.width * options.height * 4),
      width: options.width,
      height: options.height,
    })),
    setTexture: vi.fn(),
    setClassificationMaskTexture: vi.fn(),
    setAntialiasing: vi.fn(),
  };
}

function fakeOrchestrator(renderer = fakeRenderer()) {
  const slot = { id: 'main', canvas: null, renderer: renderer as unknown as ChromashiftRenderer } as RendererSlot;
  const orchestrator = {
    getBackend: () => 'webgpu',
    getFallbackReason: () => null,
    setPassGraph: vi.fn(),
    setCanvasColorSpace: vi.fn(),
    setCanvasPresentation: vi.fn(),
    getSlot: (id: string) => (id === 'main' ? slot : undefined),
    listSlots: () => [slot],
    reconfigureIfNeeded: vi.fn(),
    resizeAll: vi.fn(),
    destroySlot: vi.fn(),
    destroy: vi.fn(),
    sharedDevice: () => null,
    textureManagerRef: () => null,
    gpuImageAnalysisRef: () => null,
  };
  return { orchestrator, renderer, asOrchestrator: orchestrator as unknown as RendererOrchestrator };
}

const PROBE_OK = { ok: true, stage: 'ok' } as unknown as WebGpuProbeResult;

function bootRequest(canvasId = 1, overrides: Partial<RenderBootRequest> = {}): RenderBootRequest {
  return {
    backend: 'webgpu',
    antialias: false,
    colorSpace: 'srgb',
    canvasHdr: false,
    passGraph: 'default',
    retry: false,
    pageSearch: '',
    debug: false,
    surface: { canvasId, canvas: { width: 300, height: 150 } as unknown as HTMLCanvasElement, width: 300, height: 150 },
    ...overrides,
  };
}

function service(options: {
  ownsClock?: boolean;
  bootstrap?: (o: BootstrapRendererOrchestratorOptions) => Promise<{ orchestrator: RendererOrchestrator }>;
  probe?: () => Promise<WebGpuProbeResult>;
} = {}) {
  const clock = new FrameClock({ scheduler: IDLE_SCHEDULER });
  const events: Array<{ event: keyof RenderEvents; payload: unknown }> = [];
  const fake = fakeOrchestrator();
  const bootstrap = vi.fn(options.bootstrap ?? (async () => ({ orchestrator: fake.asOrchestrator })));
  const svc = new RenderService({
    clock,
    ownsClock: options.ownsClock ?? false,
    transport: options.ownsClock ? 'worker' : 'main',
    emit: (event, payload) => events.push({ event, payload }),
    deps: { probeWebGPU: options.probe ?? (async () => PROBE_OK), bootstrap },
  });
  return { svc, handlers: svc.handlers(), clock, events, bootstrap, ...fake };
}

describe('RenderService', () => {
  it('boots a WebGPU renderer on the canvas the surface carried', async () => {
    const { handlers, bootstrap } = service();
    await expect(handlers.boot(bootRequest(), CTX)).resolves.toEqual({ ok: true, backend: 'webgpu', fallbackReason: null });
    expect(bootstrap).toHaveBeenCalledWith(expect.objectContaining({
      backend: 'webgpu',
      primaryCanvas: expect.objectContaining({ width: 300 }),
      canvasOptions: { readback: false },
    }));
  });

  it('asks for a readable canvas only while the debug hooks are armed', async () => {
    const { handlers, bootstrap } = service();
    await handlers.boot(bootRequest(1, { debug: true }), CTX);
    expect(bootstrap).toHaveBeenCalledWith(expect.objectContaining({ canvasOptions: { readback: true } }));
  });

  it('a boot overtaken by another reports cancelled and destroys what it built', async () => {
    const first = fakeOrchestrator();
    const second = fakeOrchestrator();
    let releaseFirst!: () => void;
    const queue = [
      new Promise<{ orchestrator: RendererOrchestrator }>((resolve) => {
        releaseFirst = () => resolve({ orchestrator: first.asOrchestrator });
      }),
      Promise.resolve({ orchestrator: second.asOrchestrator }),
    ];
    const { handlers } = service({ bootstrap: () => queue.shift()! });

    const overtaken = handlers.boot(bootRequest(), CTX);
    await Promise.resolve();
    await Promise.resolve();
    const current = handlers.boot(bootRequest(1, { surface: { canvasId: 1, width: 300, height: 150 } }), CTX);
    releaseFirst();

    await expect(overtaken).resolves.toEqual({ ok: false, cancelled: true });
    await expect(current).resolves.toMatchObject({ ok: true });
    expect(first.orchestrator.destroy).toHaveBeenCalled();
    expect(second.orchestrator.destroy).not.toHaveBeenCalled();
  });

  it('a canvas id it was never handed is an error, not a silent black canvas', async () => {
    const { handlers } = service();
    await expect(handlers.boot(bootRequest(9, { surface: { canvasId: 9, width: 1, height: 1 } }), CTX))
      .rejects.toThrow(/Canvas 9 was never handed to the renderer/);
  });

  it('a failed WebGPU probe is a hard, non-recoverable bootstrap error', async () => {
    const probe = { ok: false, stage: 'adapter', reason: 'no adapter', browser: 'test' } as unknown as WebGpuProbeResult;
    const { handlers, bootstrap } = service({ probe: async () => probe });
    const result = await handlers.boot(bootRequest(), CTX);
    expect(result).toMatchObject({ ok: false, error: { kind: 'bootstrap', recoverable: false } });
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it('a lost device tears the renderer down and reports it; a replaced renderer’s errors are dropped', async () => {
    const reports: Array<(error: GpuRuntimeError) => void> = [];
    const { handlers, events, orchestrator } = service({
      bootstrap: async (options) => {
        reports.push(options.onRuntimeError!);
        return { orchestrator: fakeOrchestrator().asOrchestrator };
      },
    });
    await handlers.boot(bootRequest(), CTX);
    await handlers.boot(bootRequest(1, { surface: { canvasId: 1, width: 300, height: 150 } }), CTX);
    const lost: GpuRuntimeError = { kind: 'device-lost', message: 'lost', recoverable: true };

    reports[0]!(lost);
    expect(events.filter((e) => e.event === 'runtime-error')).toEqual([]);

    reports[1]!(lost);
    expect(events.filter((e) => e.event === 'runtime-error')).toEqual([{ event: 'runtime-error', payload: lost }]);
    // Torn down: a readback has no renderer to ask.
    await expect(handlers['export-frame']({ state: {} as RendererState, options: { width: 2, height: 2 } }, CTX))
      .rejects.toThrow(/not running/);
    expect(orchestrator.destroy).not.toHaveBeenCalled();
  });

  it('decodes a source once for analyses that overlap, and closes it after the last', async () => {
    const bitmaps: Array<{ close: ReturnType<typeof vi.fn> }> = [];
    const decodeBitmap = vi.fn(async () => {
      const bitmap = { width: 8, height: 8, close: vi.fn() };
      bitmaps.push(bitmap);
      return bitmap as unknown as ImageBitmap;
    });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const computeAverageLuminance = vi.fn(async () => {
      await gate;
      return { avgLuminance: 90, mode: 'worker' as const };
    });
    const clock = new FrameClock({ scheduler: IDLE_SCHEDULER });
    const svc = new RenderService({
      clock,
      ownsClock: false,
      transport: 'main',
      emit: () => {},
      deps: {
        decodeBitmap,
        // A WebGL session: no device, so the luminance comes from the CPU host.
        bootstrap: async () => ({ orchestrator: { ...fakeOrchestrator().orchestrator, getBackend: () => 'webgl' } as unknown as RendererOrchestrator }),
        createCpuHost: () => ({ isWasmReady: () => false, computeAverageLuminance, analyzeImage: vi.fn() }) as never,
      },
    });
    const handlers = svc.handlers();
    await handlers.boot(bootRequest(1, { backend: 'webgl' }), CTX);

    const first = handlers['analyze-source']({ url: '/a.png', useWasm: false }, CTX);
    const second = handlers['analyze-source']({ url: '/a.png', useWasm: false }, CTX);
    await vi.waitFor(() => expect(computeAverageLuminance).toHaveBeenCalledTimes(2));
    expect(decodeBitmap).toHaveBeenCalledTimes(1);
    expect(bitmaps[0]!.close).not.toHaveBeenCalled();
    finish();
    await expect(Promise.all([first, second])).resolves.toEqual([{ avgLuminance: 90 }, { avgLuminance: 90 }]);
    expect(bitmaps[0]!.close).toHaveBeenCalledTimes(1);

    // Nothing held between loads: the next analysis decodes afresh.
    await handlers['analyze-source']({ url: '/a.png', useWasm: false }, CTX);
    expect(decodeBitmap).toHaveBeenCalledTimes(2);
  });

  describe('a video export on the clock it owns (the worker)', () => {
    it('takes the clock offline, renders each frame in one step, and gives the clock back', async () => {
      const { handlers, clock, renderer } = service({ ownsClock: true });
      await handlers.boot(bootRequest(), CTX);

      await handlers['export-begin']({}, CTX);
      expect(renderer.clearPersistence).toHaveBeenCalled();
      expect(clock.mode).toBe('offline');
      expect(clock.describe().render).toEqual(['video-export']);

      const ticks: number[] = [];
      const unregister = clock.register('input', ({ now }) => { ticks.push(now); }, 'test-input');
      const request = { state: {} as RendererState, options: { width: 4, height: 2, fps: 25 } };
      const frame = await handlers['export-frame'](request, CTX);
      await handlers['export-frame'](request, CTX);
      unregister();
      expect(frame).toMatchObject({ width: 4, height: 2 });
      expect(renderer.exportFrame).toHaveBeenCalledTimes(2);
      // One step of 1000 / fps per frame, through every phase.
      expect(ticks).toHaveLength(2);
      expect(ticks[1]! - ticks[0]!).toBe(40);

      await handlers['export-end']({ width: 300, height: 150 }, CTX);
      expect(renderer.restoreRenderSize).toHaveBeenCalledWith(300, 150);
      expect(clock.mode).toBe('realtime');
      expect(clock.size).toBe(0);
    });

    it('on the page’s clock (main transport) leaves the stepping to the exporter', async () => {
      const { handlers, clock, renderer } = service({ ownsClock: false });
      await handlers.boot(bootRequest(), CTX);
      await handlers['export-begin']({}, CTX);
      expect(clock.mode).toBe('realtime');
      await handlers['export-frame']({ state: {} as RendererState, options: { width: 2, height: 2 } }, CTX);
      expect(renderer.exportFrame).toHaveBeenCalledTimes(1);
    });
  });
});
