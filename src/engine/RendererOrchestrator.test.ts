import { describe, expect, it, vi } from 'vitest';
import {
  PRIMARY_SLOT_ID,
  RendererOrchestrator,
  type RendererOrchestratorDeps,
  type RendererSlot,
} from './RendererOrchestrator';
import type { ChromashiftRenderer } from './RendererTypes';
import type { GpuRuntimeError, WebGpuSession } from './gpuBootstrap';
import type { TextureManager } from './TextureManager';
import type { WebGLTextureManager } from './WebGLTextureManager';
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
    requestPreviewReadback: vi.fn(),
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
  } as unknown as GPUDevice;

  return {
    adapter: {} as GPUAdapter,
    device,
    context: primaryContext,
    format: 'bgra8unorm' as GPUTextureFormat,
    adapterReport: {
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
    timestampQueryAvailable: false,
    reconfigure: vi.fn(),
    detach: vi.fn(),
  };
}

function createMockDeps(overrides: Partial<RendererOrchestratorDeps> = {}): RendererOrchestratorDeps {
  const textureManager = {
    destroy: vi.fn(),
    fetchImageList: vi.fn(),
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
    createWebGPURenderer: vi.fn(async () => mockRenderer()),
    createSecondaryWebGPURenderer: vi.fn(() => mockRenderer()),
    createWebGLRenderer: vi.fn(() => mockRenderer()),
    createTextureManager: vi.fn(() => textureManager),
    createWebGLTextureManager: vi.fn(() => ({
      destroy: vi.fn(),
      fetchImageList: vi.fn(),
      loadTexture: vi.fn(),
      uploadPixels: vi.fn(),
      evictExcept: vi.fn(),
    }) as unknown as WebGLTextureManager),
    createGpuImageAnalysis: vi.fn(() => gpuImageAnalysis),
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

  it('falls back to WebGL when WebGPU bootstrap fails', async () => {
    const canvas = mockCanvas('main');
    const deps = createMockDeps({
      bootstrapWebGpu: vi.fn(async () => {
        throw new Error('No adapter');
      }),
    });

    const { orchestrator, backend, fallbackReason } = await RendererOrchestrator.bootstrap(
      { primaryCanvas: canvas, antialias: true, backend: 'webgpu' },
      deps,
    );

    expect(backend).toBe('webgl');
    expect(fallbackReason).toBe('No adapter');
    expect(orchestrator.getBackend()).toBe('webgl');
    expect(orchestrator.sharedDevice()).toBeNull();
    expect(deps.createWebGLRenderer).toHaveBeenCalledOnce();
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
    expect(session.device.destroy).toHaveBeenCalledOnce();
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

  it('rejects a second WebGL slot', async () => {
    const deps = createMockDeps();
    const primary = mockCanvas('main');

    const { orchestrator } = await RendererOrchestrator.bootstrap(
      { primaryCanvas: primary, backend: 'webgl' },
      deps,
    );

    expect(() => orchestrator.createSlot('extra', mockCanvas('extra'))).toThrow(/primary canvas slot|single renderer slot/i);
  });
});
