import { describe, expect, it, vi } from 'vitest';
import {
  PRIMARY_SLOT_ID,
  RendererOrchestrator,
  type RendererOrchestratorDeps,
} from './RendererOrchestrator';
import type { GpuRuntimeError } from './gpuBootstrap';
import type { ChromashiftRenderer, ChromashiftTextureManager } from './RendererTypes';

function mockRenderer(id = 'mock'): ChromashiftRenderer & { id: string } {
  return {
    id,
    backend: 'webgpu' as const,
    setTexture: vi.fn(),
    setClassificationMaskTexture: vi.fn(),
    setAntialiasing: vi.fn(),
    clearPersistence: vi.fn(),
    render: vi.fn(),
    requestPreviewReadback: vi.fn(() => false),
    requestCollisionStats: vi.fn(() => false),
    getRenderTiming: vi.fn(() => ({
      lastCpuMs: 0,
      averageCpuMs: 0,
      gpu: { available: false, last: null, history: [], approxBandwidthMBps: 0 },
    })),
    exportTracerView: vi.fn(async () => null),
    exportFrame: vi.fn(async () => null),
    restoreRenderSize: vi.fn(),
    destroy: vi.fn(),
  };
}

function mockTextureManager(): ChromashiftTextureManager {
  return {
    fetchImageList: vi.fn(async () => []),
    loadTexture: vi.fn(),
    uploadPixels: vi.fn(),
    destroy: vi.fn(),
    evictExcept: vi.fn(),
  };
}

function mockCanvas(id = 'canvas'): HTMLCanvasElement {
  return {
    id,
    width: 640,
    height: 480,
    getContext: vi.fn(() => null),
  } as unknown as HTMLCanvasElement;
}

function mockWebGpuContext(canvas: HTMLCanvasElement): GPUCanvasContext {
  return {
    canvas,
    configure: vi.fn(),
    unconfigure: vi.fn(),
    getCurrentTexture: vi.fn(),
  } as unknown as GPUCanvasContext;
}

function mockSession(primaryCanvas: HTMLCanvasElement) {
  const context = mockWebGpuContext(primaryCanvas);
  const device = {
    destroy: vi.fn(),
  } as unknown as GPUDevice;

  return {
    adapter: {} as GPUAdapter,
    device,
    context,
    format: 'bgra8unorm' as GPUTextureFormat,
    adapterReport: {
      vendor: 'test',
      architecture: 'test',
      device: 'test',
      description: 'test',
      features: [],
      limits: {
        maxTextureDimension2D: 8192,
        maxBufferSize: 1,
        maxColorAttachmentBytesPerSample: 32,
      },
    },
    timestampQueryAvailable: false,
    reconfigure: vi.fn(),
    detach: vi.fn(),
  };
}

function createMockDeps(overrides: Partial<RendererOrchestratorDeps> = {}): RendererOrchestratorDeps {
  const createdRenderers: ChromashiftRenderer[] = [];
  const textureManager = mockTextureManager();

  return {
    bootstrapWebGpu: vi.fn(async ({ canvas }) => mockSession(canvas)),
    configureWebGpuCanvas: vi.fn(),
    createWebGL2Context: vi.fn(() => ({}) as WebGL2RenderingContext),
    withErrorScope: vi.fn(async (_device, _filter, _label, work) => work()),
    createWebGpuRenderer: vi.fn(() => {
      const renderer = mockRenderer(`webgpu-${createdRenderers.length}`);
      createdRenderers.push(renderer);
      return renderer;
    }),
    createWebGLRenderer: vi.fn(() => {
      const renderer = mockRenderer(`webgl-${createdRenderers.length}`);
      (renderer as { backend: 'webgl' }).backend = 'webgl';
      createdRenderers.push(renderer);
      return renderer;
    }),
    createWebGpuTextureManager: vi.fn(() => textureManager),
    createWebGLTextureManager: vi.fn(() => textureManager),
    createGpuImageAnalysis: vi.fn(() => ({
      destroy: vi.fn(),
      support: { available: false, reason: 'mock' },
      isSupported: () => false,
      canAnalyze: () => false,
      analyze: vi.fn(),
    }) as unknown as import('./compute/GpuImageAnalysis').GpuImageAnalysis),
    getRendererPreference: vi.fn(() => 'webgpu' as const),
    ...overrides,
  };
}

describe('RendererOrchestrator', () => {
  it('bootstraps a primary WebGPU slot', async () => {
    const deps = createMockDeps();
    const canvas = mockCanvas('primary');

    const { orchestrator, backend, fallbackReason } = await RendererOrchestrator.bootstrap(
      canvas,
      { backendPreference: 'webgpu' },
      deps,
    );

    expect(backend).toBe('webgpu');
    expect(fallbackReason).toBeNull();
    expect(orchestrator.getPrimarySlot()?.canvas).toBe(canvas);
    expect(deps.bootstrapWebGpu).toHaveBeenCalledOnce();
    expect(deps.createWebGpuRenderer).toHaveBeenCalledOnce();
    expect(orchestrator.sharedTextureManager()).not.toBeNull();

    const primaryRenderer = orchestrator.getPrimarySlot()!.renderer;
    orchestrator.destroy();
    expect(primaryRenderer.destroy).toHaveBeenCalled();
  });

  it('creates and destroys additional WebGPU slots', async () => {
    const deps = createMockDeps();
    const primary = mockCanvas('primary');
    const secondary = mockCanvas('secondary');
    const secondaryContext = mockWebGpuContext(secondary);

    secondary.getContext = vi.fn((type: string) => {
      if (type === 'webgpu') return secondaryContext;
      return null;
    }) as HTMLCanvasElement['getContext'];

    const { orchestrator } = await RendererOrchestrator.bootstrap(primary, {}, deps);
    const slotB = orchestrator.createSlot('compare-b', secondary);

    expect(slotB.id).toBe('compare-b');
    expect(orchestrator.listSlots()).toHaveLength(2);
    expect(deps.configureWebGpuCanvas).toHaveBeenCalled();

    orchestrator.destroySlot('compare-b');
    expect(slotB.renderer.destroy).toHaveBeenCalled();
    expect(secondaryContext.unconfigure).toHaveBeenCalled();
    expect(orchestrator.listSlots()).toHaveLength(1);

    orchestrator.destroy();
  });

  it('falls back to WebGL when WebGPU bootstrap fails', async () => {
    const deps = createMockDeps({
      bootstrapWebGpu: vi.fn(async () => {
        throw new Error('no adapter');
      }),
    });
    const canvas = mockCanvas('primary');

    const { orchestrator, backend, fallbackReason } = await RendererOrchestrator.bootstrap(
      canvas,
      { backendPreference: 'webgpu' },
      deps,
    );

    expect(backend).toBe('webgl');
    expect(fallbackReason).toBe('no adapter');
    expect(deps.createWebGLRenderer).toHaveBeenCalledOnce();
    expect(orchestrator.sharedDevice()).toBeNull();

    orchestrator.destroy();
  });

  it('rejects a second WebGL slot', async () => {
    const deps = createMockDeps({
      getRendererPreference: vi.fn(() => 'webgl' as const),
    });
    const primary = mockCanvas('primary');

    const { orchestrator } = await RendererOrchestrator.bootstrap(
      primary,
      { backendPreference: 'webgl' },
      deps,
    );

    expect(() => orchestrator.createSlot('extra', mockCanvas('extra'))).toThrow(
      /only one renderer slot/i,
    );

    orchestrator.destroy();
  });

  it('resizeAll reconfigures the session and secondary contexts', async () => {
    const deps = createMockDeps();
    const primary = mockCanvas('primary');
    const secondary = mockCanvas('secondary');
    const secondaryContext = mockWebGpuContext(secondary);
    secondary.getContext = vi.fn((type: string) => {
      if (type === 'webgpu') return secondaryContext;
      return null;
    }) as HTMLCanvasElement['getContext'];

    const { orchestrator } = await RendererOrchestrator.bootstrap(primary, {}, deps);
    const session = orchestrator.sharedSession()!;
    orchestrator.createSlot('compare-b', secondary);

    orchestrator.resizeAll();

    expect(session.reconfigure).toHaveBeenCalled();
    expect(deps.configureWebGpuCanvas).toHaveBeenCalled();

    orchestrator.destroy();
  });

  it('tears down all slots on device runtime error', async () => {
    let runtimeHandler: ((error: GpuRuntimeError) => void) | undefined;
    const deps = createMockDeps({
      bootstrapWebGpu: vi.fn(async (options) => {
        runtimeHandler = options.onRuntimeError;
        return mockSession(options.canvas);
      }),
    });

    const primary = mockCanvas('primary');
    const secondary = mockCanvas('secondary');
    secondary.getContext = vi.fn((type: string) => {
      if (type === 'webgpu') return mockWebGpuContext(secondary);
      return null;
    }) as HTMLCanvasElement['getContext'];

    const { orchestrator } = await RendererOrchestrator.bootstrap(primary, {}, deps);
    const slotB = orchestrator.createSlot('compare-b', secondary);

    runtimeHandler?.({
      kind: 'device-lost',
      message: 'lost',
      recoverable: true,
    });

    expect(orchestrator.listSlots()).toHaveLength(0);
    expect(slotB.renderer.destroy).toHaveBeenCalled();

    orchestrator.destroy();
  });

  it('uses PRIMARY_SLOT_ID for the main viewport', async () => {
    const deps = createMockDeps();
    const canvas = mockCanvas('primary');
    const { orchestrator } = await RendererOrchestrator.bootstrap(canvas, {}, deps);

    expect(orchestrator.getSlot(PRIMARY_SLOT_ID)).toBeDefined();
    orchestrator.destroy();
  });
});
