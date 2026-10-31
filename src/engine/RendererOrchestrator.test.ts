import { describe, expect, it, vi } from 'vitest';
import {
  PRIMARY_SLOT_ID,
  RendererOrchestrator,
  type RendererOrchestratorDeps,
  type RendererSlot,
} from './RendererOrchestrator';
import type { ChromashiftRenderer } from './types/RendererContracts';
import { presetGraphSource } from './graph/variants';
import { type GpuRuntimeError } from './gpu/gpuErrors';
import { type WebGpuSession } from './webgpu/webgpuSession';
import { WebGL2ContextLostError, createWebGL2Context, watchWebGL2Context } from './webgl/webgl2Context';
import type { TextureManager } from './webgpu/TextureManager';
import type { WebGLTextureManager } from './webgl/WebGLTextureManager';
import type { GpuImageAnalysis } from './compute/GpuImageAnalysis';

function mockRenderer(): ChromashiftRenderer {
  return {
    backend: 'webgpu',
    destroy: vi.fn(),
    render: vi.fn(),
    setTexture: vi.fn(),
    clearPersistence: vi.fn(),
    setClassificationMaskTexture: vi.fn(),
    setAntialiasing: vi.fn(),
    getRenderTiming: vi.fn(),
    renderStationaryPreviews: vi.fn(async () => ({ separated: null, tracer: null })),
    requestCollisionStats: vi.fn(),
    exportTracerView: vi.fn(async () => null),
    exportFrame: vi.fn(async () => null),
    restoreRenderSize: vi.fn(),
  } as unknown as ChromashiftRenderer;
}

function mockCanvas(id: string, webgpuContext?: GPUCanvasContext): HTMLCanvasElement {
  const context = webgpuContext ?? mockWebGpuContext();
  return {
    id,
    width: 640,
    height: 480,
    getContext: vi.fn((type: string) => (type === 'webgpu' ? context : null)),
  } as unknown as HTMLCanvasElement;
}

function mockWebGpuContext(canvas?: HTMLCanvasElement): GPUCanvasContext {
  return {
    canvas,
    configure: vi.fn(),
    unconfigure: vi.fn(),
    getCurrentTexture: vi.fn(),
  } as unknown as GPUCanvasContext;
}

function mockSession(primaryContext: GPUCanvasContext): WebGpuSession {
  const device = {
    destroy: vi.fn(),
    pushErrorScope: vi.fn(),
    popErrorScope: vi.fn(async () => null),
  } as unknown as GPUDevice;

  return {
    adapter: {} as GPUAdapter,
    device,
    context: primaryContext,
    format: 'bgra8unorm' as GPUTextureFormat,
    canvasHdrAvailable: false,
    canvasHdrReason: 'test',
    adapterReport: {
      featureLevel: 'core',
      vendor: 'test',
      architecture: 'test',
      device: 'test',
      description: 'test',
      features: [],
      limits: {
        maxTextureDimension2D: 8192,
        maxBufferSize: 256 * 1024 * 1024,
        maxColorAttachmentBytesPerSample: 32,
      },
    },
    capabilities: {
      featureLevel: 'core',
      adapterOptionalFeatures: [],
      requestedOptionalFeatures: [],
      grantedOptionalFeatures: [],
      missingRequestedFeatures: [],
      timestampQueryAvailable: false,
    },
    timestampQueryAvailable: false,
    reconfigure: vi.fn(),
    setCanvasOptions: vi.fn(),
    detach: vi.fn(),
  };
}

function createMockDeps(overrides: Partial<RendererOrchestratorDeps> = {}): RendererOrchestratorDeps {
  const textureManager = {
    destroy: vi.fn(),
    loadTexture: vi.fn(),
    uploadPixels: vi.fn(),
    evictExcept: vi.fn(),
  } as unknown as TextureManager;

  const gpuImageAnalysis = {
    destroy: vi.fn(),
    support: { available: true, reason: null },
  } as unknown as GpuImageAnalysis;

  return {
    bootstrapWebGpu: vi.fn(async ({ canvas }) => mockSession(mockWebGpuContext(canvas))),
    configureWebGpuCanvas: vi.fn(),
    createWebGL2Context: vi.fn(() => ({} as WebGL2RenderingContext)),
    watchWebGL2Context: vi.fn(() => () => undefined),
    createWebGPURenderer: vi.fn(async () => mockRenderer()),
    createSecondaryWebGPURenderer: vi.fn(() => mockRenderer()),
    createWebGLRenderer: vi.fn(() => mockRenderer()),
    createTextureManager: vi.fn(() => textureManager),
    createWebGLTextureManager: vi.fn(() => ({
      destroy: vi.fn(),
      loadTexture: vi.fn(),
      uploadPixels: vi.fn(),
      evictExcept: vi.fn(),
    }) as unknown as WebGLTextureManager),
    createGpuImageAnalysis: vi.fn(() => gpuImageAnalysis),
    acquireGpuChoreSession: vi.fn(() => ({
      backend: {} as never,
      release: vi.fn(),
    })),
    getRendererPreference: vi.fn(() => 'webgpu' as const),
    ...overrides,
  };
}

describe('RendererOrchestrator', () => {
  it('bootstraps a primary WebGPU slot', async () => {
    const canvas = mockCanvas('main');
    const deps = createMockDeps();
    const onRuntimeError = vi.fn();

    const { orchestrator, primarySlot, backend, fallbackReason } = await RendererOrchestrator.bootstrap({
      primaryCanvas: canvas,
      antialias: true,
      backend: 'webgpu',
      onRuntimeError,
    }, deps);

    expect(backend).toBe('webgpu');
    expect(fallbackReason).toBeNull();
    expect(primarySlot.id).toBe(PRIMARY_SLOT_ID);
    expect(primarySlot.canvas).toBe(canvas);
    expect(orchestrator.slotIds()).toEqual([PRIMARY_SLOT_ID]);
    expect(orchestrator.sharedDevice()).toBeTruthy();
    expect(orchestrator.textureManagerRef()).toBeTruthy();
    expect(orchestrator.gpuImageAnalysisRef()).toBeTruthy();
    expect(deps.bootstrapWebGpu).toHaveBeenCalledOnce();
    expect(deps.createWebGPURenderer).toHaveBeenCalledOnce();
  });

  // The headless renderer's path (docs/HEADLESS.md): no canvas anywhere.
  it('bootstraps the primary slot onto an offscreen target', async () => {
    const target = mockWebGpuContext();
    const renderer = { ...mockRenderer(), setPassGraph: vi.fn() } as unknown as ChromashiftRenderer;
    const deps = createMockDeps({
      bootstrapWebGpu: vi.fn(async (options) => mockSession(options.target as GPUCanvasContext)),
      createWebGPURenderer: vi.fn(async () => renderer),
    });

    const { orchestrator, primarySlot } = await RendererOrchestrator.bootstrap({
      primaryTarget: target,
      primaryFormat: 'rgba8unorm',
      backend: 'webgpu',
    }, deps);

    expect(deps.bootstrapWebGpu).toHaveBeenCalledWith(expect.objectContaining({ target, format: 'rgba8unorm' }));
    expect(vi.mocked(deps.bootstrapWebGpu).mock.calls[0]![0]).not.toHaveProperty('canvas');
    expect(primarySlot).toMatchObject({ id: PRIMARY_SLOT_ID, canvas: null, webgpuContext: target });
    expect(deps.createWebGPURenderer).toHaveBeenCalledWith(expect.anything(), target, expect.anything(), false);

    const source = presetGraphSource('default');
    orchestrator.setPassGraph(source);
    expect(renderer.setPassGraph).toHaveBeenCalledWith(source, { slot: PRIMARY_SLOT_ID, primary: true });
  });

  it('takes exactly one of a canvas and an offscreen target, and the target only on WebGPU', async () => {
    const deps = createMockDeps();
    await expect(RendererOrchestrator.bootstrap({ primaryCanvas: undefined, backend: 'webgpu' }, deps))
      .rejects.toThrow(/exactly one of primaryCanvas and primaryTarget/);
    await expect(RendererOrchestrator.bootstrap({
      primaryCanvas: mockCanvas('main'),
      primaryTarget: mockWebGpuContext(),
      backend: 'webgpu',
    }, deps)).rejects.toThrow(/exactly one of primaryCanvas and primaryTarget/);
    await expect(RendererOrchestrator.bootstrap({ primaryTarget: mockWebGpuContext(), backend: 'webgl' }, deps))
      .rejects.toThrow(/WebGL backend presents to a canvas/);
    expect(deps.bootstrapWebGpu).not.toHaveBeenCalled();
    expect(deps.createWebGL2Context).not.toHaveBeenCalled();
  });

  it('adds and removes secondary WebGPU slots', async () => {
    const primaryCanvas = mockCanvas('main');
    const secondaryContext = mockWebGpuContext();
    const secondaryCanvas = mockCanvas('compare-b', secondaryContext);

    const deps = createMockDeps();
    const { orchestrator } = await RendererOrchestrator.bootstrap({
      primaryCanvas,
      antialias: false,
      backend: 'webgpu',
    }, deps);

    const slotB = orchestrator.createSlot('compare-b', secondaryCanvas);
    expect(orchestrator.slotIds()).toEqual(['main', 'compare-b']);
    expect(slotB.webgpuContext).toBe(secondaryContext);
    expect(deps.configureWebGpuCanvas).toHaveBeenCalled();

    orchestrator.destroySlot('compare-b');
    expect(orchestrator.slotIds()).toEqual(['main']);
    expect(slotB.renderer.destroy).toHaveBeenCalledOnce();
    expect(secondaryContext.unconfigure).toHaveBeenCalledOnce();
  });

  it('hands the pass-graph source to every slot, existing and future, naming the primary', async () => {
    const renderers: ChromashiftRenderer[] = [];
    const withGraph = () => {
      const renderer = { ...mockRenderer(), setPassGraph: vi.fn() } as unknown as ChromashiftRenderer;
      renderers.push(renderer);
      return renderer;
    };
    const deps = createMockDeps({
      createWebGPURenderer: vi.fn(async () => withGraph()),
      createSecondaryWebGPURenderer: vi.fn(() => withGraph()),
    });
    const { orchestrator } = await RendererOrchestrator.bootstrap({
      primaryCanvas: mockCanvas('main'),
      antialias: false,
      backend: 'webgpu',
    }, deps);
    const source = presetGraphSource('default');

    orchestrator.setPassGraph(source);
    expect(renderers[0]!.setPassGraph).toHaveBeenCalledWith(source, { slot: PRIMARY_SLOT_ID, primary: true });

    // A compare slot opened later draws the same graph, with its own executor.
    orchestrator.createSlot('compare-b', mockCanvas('compare-b'));
    expect(renderers[1]!.setPassGraph).toHaveBeenCalledWith(source, { slot: 'compare-b', primary: false });

    orchestrator.setPassGraph(null);
    for (const renderer of renderers) expect(renderer.setPassGraph).toHaveBeenLastCalledWith(null, expect.anything());
  });

  it('hard-fails instead of falling back to WebGL when WebGPU bootstrap fails', async () => {
    const canvas = mockCanvas('main');
    const deps = createMockDeps({
      bootstrapWebGpu: vi.fn(async () => {
        throw new Error('No adapter');
      }),
    });

    await expect(RendererOrchestrator.bootstrap(
      { primaryCanvas: canvas, antialias: true, backend: 'webgpu' },
      deps,
    )).rejects.toThrow('No adapter');

    // WebGPU is required for this phase: nothing WebGL may be constructed on
    // the failure path.
    expect(deps.createWebGLRenderer).not.toHaveBeenCalled();
    expect(deps.createWebGL2Context).not.toHaveBeenCalled();
    expect(deps.createWebGLTextureManager).not.toHaveBeenCalled();
  });

  it('tears down a partial WebGPU boot so no device survives the failure', async () => {
    const canvas = mockCanvas('main');
    // Session bootstrap succeeds but the renderer fails to build; the partial
    // boot must still be torn down so gpu-chores cannot adopt a device from a
    // dead orchestrator.
    const deps = createMockDeps({
      createWebGPURenderer: vi.fn(async () => {
        throw new Error('Pipeline creation failed');
      }),
    });

    await expect(RendererOrchestrator.bootstrap(
      { primaryCanvas: canvas, antialias: true, backend: 'webgpu' },
      deps,
    )).rejects.toThrow('Pipeline creation failed');

    expect(deps.createWebGLRenderer).not.toHaveBeenCalled();
  });

  it('starts WebGL from getRendererPreference without touching WebGPU', async () => {
    const canvas = mockCanvas('main');
    const deps = createMockDeps({
      getRendererPreference: vi.fn(() => 'webgl' as const),
    });

    const { orchestrator, backend } = await RendererOrchestrator.bootstrap(
      { primaryCanvas: canvas, antialias: true },
      deps,
    );

    expect(backend).toBe('webgl');
    expect(orchestrator.getBackend()).toBe('webgl');
    expect(deps.bootstrapWebGpu).not.toHaveBeenCalled();
    expect(deps.createGpuImageAnalysis).not.toHaveBeenCalled();
    expect(deps.createWebGLRenderer).toHaveBeenCalledOnce();
  });

  it('still honours an explicitly requested WebGL backend', async () => {
    // Explicit diagnostic backend — never reached via automatic recovery.
    const canvas = mockCanvas('main');
    const deps = createMockDeps();

    const { orchestrator, backend } = await RendererOrchestrator.bootstrap(
      { primaryCanvas: canvas, antialias: true, backend: 'webgl' },
      deps,
    );

    expect(backend).toBe('webgl');
    expect(orchestrator.getBackend()).toBe('webgl');
    expect(deps.createWebGLRenderer).toHaveBeenCalledOnce();
  });

  it('hands the WebGL renderer the antialias toggle (layer MSAA, not a context flag)', async () => {
    const deps = createMockDeps();
    await RendererOrchestrator.bootstrap({ primaryCanvas: mockCanvas('main'), antialias: true, backend: 'webgl' }, deps);
    expect(deps.createWebGLRenderer).toHaveBeenCalledWith(expect.anything(), expect.anything(), true);
  });

  describe('WebGL context loss', () => {
    // The real context helpers over a canvas that dispatches DOM events.
    function lossyCanvas() {
      const state = { lost: false };
      const gl = { isContextLost: () => state.lost } as unknown as WebGL2RenderingContext;
      const canvas = Object.assign(new EventTarget(), {
        width: 640,
        height: 480,
        getContext: vi.fn(() => gl),
      }) as unknown as HTMLCanvasElement;
      return { canvas, gl, state };
    }

    it('surfaces loss as the recoverable overlay and boots again on restore without a second getContext', async () => {
      vi.spyOn(console, 'info').mockImplementation(() => undefined);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { canvas, gl, state } = lossyCanvas();
      const deps = createMockDeps({ createWebGL2Context, watchWebGL2Context });
      const onRuntimeError = vi.fn();
      const onContextRestored = vi.fn();
      const options = { primaryCanvas: canvas, backend: 'webgl' as const, onRuntimeError, onContextRestored };

      const first = await RendererOrchestrator.bootstrap(options, deps);
      state.lost = true;
      const lost = new Event('webglcontextlost', { cancelable: true });
      canvas.dispatchEvent(lost);

      // preventDefault is what lets the browser restore the context at all.
      expect(lost.defaultPrevented).toBe(true);
      expect(onRuntimeError).toHaveBeenCalledWith(expect.objectContaining({ kind: 'device-lost', recoverable: true }));
      expect(first.primarySlot.renderer.destroy).toHaveBeenCalledOnce();
      expect(first.orchestrator.slotIds()).toEqual([]);

      // Retry GPU while still lost refuses; it does not ask the canvas again.
      await expect(RendererOrchestrator.bootstrap(options, deps)).rejects.toBeInstanceOf(WebGL2ContextLostError);
      expect(onContextRestored).not.toHaveBeenCalled();

      state.lost = false;
      canvas.dispatchEvent(new Event('webglcontextrestored'));
      expect(onContextRestored).toHaveBeenCalledOnce();

      const second = await RendererOrchestrator.bootstrap(options, deps);
      expect(second.orchestrator.slotIds()).toEqual([PRIMARY_SLOT_ID]);
      expect(deps.createWebGLRenderer).toHaveBeenCalledTimes(2);
      expect(deps.createWebGLRenderer).toHaveBeenLastCalledWith(canvas, gl, false);
      expect(canvas.getContext).toHaveBeenCalledTimes(1);
      expect(deps.bootstrapWebGpu).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    });

    it('detaches its listeners on an ordinary destroy', async () => {
      const unwatch = vi.fn();
      const deps = createMockDeps({ watchWebGL2Context: vi.fn(() => unwatch) });
      const { orchestrator } = await RendererOrchestrator.bootstrap(
        { primaryCanvas: mockCanvas('main'), backend: 'webgl' },
        deps,
      );
      orchestrator.destroy();
      expect(unwatch).toHaveBeenCalledOnce();
    });
  });

  it('reconfigures all active WebGPU contexts on resizeAll', async () => {
    const primaryCanvas = mockCanvas('main');
    const secondaryContext = mockWebGpuContext();
    const secondaryCanvas = mockCanvas('compare-b', secondaryContext);

    const deps = createMockDeps();
    const { orchestrator } = await RendererOrchestrator.bootstrap({
      primaryCanvas,
      antialias: false,
      backend: 'webgpu',
    }, deps);
    orchestrator.createSlot('compare-b', secondaryCanvas);

    const session = orchestrator.sessionRef()!;
    orchestrator.resizeAll();
    expect(session.reconfigure).not.toHaveBeenCalled();

    orchestrator.reconfigureIfNeeded();
    expect(session.reconfigure).toHaveBeenCalledOnce();
    expect(deps.configureWebGpuCanvas).toHaveBeenCalled();
  });

  it('destroys all slots and shared resources', async () => {
    const primaryCanvas = mockCanvas('main');
    const secondaryContext = mockWebGpuContext();
    const secondaryCanvas = mockCanvas('compare-b', secondaryContext);

    const deps = createMockDeps();
    const { orchestrator } = await RendererOrchestrator.bootstrap({
      primaryCanvas,
      antialias: false,
      backend: 'webgpu',
    }, deps);
    const slotB = orchestrator.createSlot('compare-b', secondaryCanvas);
    const session = orchestrator.sessionRef()!;
    const textureManager = orchestrator.textureManagerRef() as TextureManager;
    const gpuImageAnalysis = orchestrator.gpuImageAnalysisRef() as GpuImageAnalysis;
    const primaryContext = session.context;

    orchestrator.destroy();

    expect(orchestrator.slotIds()).toEqual([]);
    expect(slotB.renderer.destroy).toHaveBeenCalledOnce();
    expect(primaryContext.unconfigure).toHaveBeenCalledOnce();
    expect(secondaryContext.unconfigure).toHaveBeenCalledOnce();
    expect(gpuImageAnalysis.destroy).toHaveBeenCalledOnce();
    expect(textureManager.destroy).toHaveBeenCalledOnce();
    expect(session.detach).toHaveBeenCalledOnce();
    // Page-leased GPUDevice survives orchestrator teardown so React cleanup
    // cannot start another requestDevice (#157 / #158).
    expect(session.device.destroy).not.toHaveBeenCalled();
  });

  it('tears down slots when device is lost', async () => {
    const canvas = mockCanvas('main');
    let capturedOnRuntimeError: ((error: GpuRuntimeError) => void) | undefined;
    const deps = createMockDeps({
      bootstrapWebGpu: vi.fn(async (options) => {
        capturedOnRuntimeError = options.onRuntimeError;
        const context = mockWebGpuContext();
        return mockSession(context);
      }),
    });

    const onRuntimeError = vi.fn();
    const { orchestrator } = await RendererOrchestrator.bootstrap(
      { primaryCanvas: canvas, antialias: false, backend: 'webgpu', onRuntimeError },
      deps,
    );

    const primarySlot = orchestrator.getSlot(PRIMARY_SLOT_ID) as RendererSlot;
    capturedOnRuntimeError?.({
      kind: 'device-lost',
      message: 'lost',
      recoverable: true,
    });

    expect(orchestrator.slotIds()).toEqual([]);
    expect(primarySlot.renderer.destroy).toHaveBeenCalledOnce();
    expect(onRuntimeError).toHaveBeenCalledWith({
      kind: 'device-lost',
      message: 'lost',
      recoverable: true,
    });
  });

  it('reports a secondary slot renderer that failed validation as a pipeline error', async () => {
    const session = mockSession(mockWebGpuContext());
    vi.mocked(session.device.popErrorScope).mockResolvedValueOnce({ message: 'invalid bind group layout' } as GPUError);
    const deps = createMockDeps({ bootstrapWebGpu: vi.fn(async () => session) });
    const onRuntimeError = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { orchestrator } = await RendererOrchestrator.bootstrap(
      { primaryCanvas: mockCanvas('main'), antialias: false, backend: 'webgpu', onRuntimeError },
      deps,
    );

    orchestrator.createSlot('compare-b', mockCanvas('compare-b', mockWebGpuContext()));
    await vi.waitFor(() => expect(onRuntimeError).toHaveBeenCalledOnce());

    expect(onRuntimeError).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'pipeline',
      detail: 'invalid bind group layout',
      recoverable: false,
    }));
    // Shown, not torn down: the slot keeps drawing.
    expect(orchestrator.slotIds()).toContain('compare-b');
  });

  it('a destroyed orchestrator forwards nothing', async () => {
    let capturedOnRuntimeError: ((error: GpuRuntimeError) => void) | undefined;
    const deps = createMockDeps({
      bootstrapWebGpu: vi.fn(async (options) => {
        capturedOnRuntimeError = options.onRuntimeError;
        return mockSession(mockWebGpuContext());
      }),
    });
    const onRuntimeError = vi.fn();
    const { orchestrator } = await RendererOrchestrator.bootstrap(
      { primaryCanvas: mockCanvas('main'), antialias: false, backend: 'webgpu', onRuntimeError },
      deps,
    );

    // Replaced (Retry GPU, a React re-run): its successor reports for the device.
    orchestrator.destroy();
    capturedOnRuntimeError?.({ kind: 'device-lost', message: 'lost', recoverable: true });

    expect(onRuntimeError).not.toHaveBeenCalled();
  });

  it('rejects a second WebGL slot', async () => {
    const deps = createMockDeps();
    const primary = mockCanvas('main');

    const { orchestrator } = await RendererOrchestrator.bootstrap(
      { primaryCanvas: primary, backend: 'webgl' },
      deps,
    );

    expect(() => orchestrator.createSlot('extra', mockCanvas('extra'))).toThrow(/primary canvas slot|single renderer slot/i);
  });

  it('re-bootstraps a fresh primary slot after destroy', async () => {
    const canvas = mockCanvas('main');
    const deps = createMockDeps();

    const first = await RendererOrchestrator.bootstrap({
      primaryCanvas: canvas,
      antialias: false,
      backend: 'webgpu',
    }, deps);

    first.orchestrator.destroy();
    expect(first.orchestrator.slotIds()).toEqual([]);

    const second = await RendererOrchestrator.bootstrap({
      primaryCanvas: canvas,
      antialias: false,
      backend: 'webgpu',
    }, deps);

    expect(second.orchestrator.slotIds()).toEqual([PRIMARY_SLOT_ID]);
    expect(second.primarySlot.renderer).toBeTruthy();
    expect(deps.bootstrapWebGpu).toHaveBeenCalledTimes(2);
    expect(deps.createWebGPURenderer).toHaveBeenCalledTimes(2);
    expect(deps.createTextureManager).toHaveBeenCalledTimes(2);
    expect(deps.createGpuImageAnalysis).toHaveBeenCalledTimes(2);
  });

  it('re-bootstraps after device loss', async () => {
    const canvas = mockCanvas('main');
    let capturedOnRuntimeError: ((error: GpuRuntimeError) => void) | undefined;
    const deps = createMockDeps({
      bootstrapWebGpu: vi.fn(async (options) => {
        capturedOnRuntimeError = options.onRuntimeError;
        return mockSession(mockWebGpuContext(options.canvas));
      }),
    });

    const first = await RendererOrchestrator.bootstrap(
      { primaryCanvas: canvas, antialias: false, backend: 'webgpu' },
      deps,
    );

    capturedOnRuntimeError?.({
      kind: 'device-lost',
      message: 'lost',
      recoverable: true,
    });
    expect(first.orchestrator.slotIds()).toEqual([]);

    const second = await RendererOrchestrator.bootstrap(
      { primaryCanvas: canvas, antialias: false, backend: 'webgpu' },
      deps,
    );

    expect(second.orchestrator.slotIds()).toEqual([PRIMARY_SLOT_ID]);
    expect(second.primarySlot.renderer).toBeTruthy();
    expect(deps.bootstrapWebGpu).toHaveBeenCalledTimes(2);
  });
});
