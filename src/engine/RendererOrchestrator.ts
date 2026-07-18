import { WebGPURenderer } from './WebGPURenderer';
import { WebGLRenderer } from './WebGLRenderer';
import { TextureManager } from './TextureManager';
import { WebGLTextureManager } from './WebGLTextureManager';
import { GpuImageAnalysis } from './compute/GpuImageAnalysis';
import { publishGpuComputeBreadcrumbs } from './compute/computeSupport';
import { getRendererPreference } from './rendererMode';
import {
  bootstrapWebGpu,
  configureWebGpuCanvas,
  createWebGL2Context,
  withErrorScope,
  type GpuRuntimeError,
  type WebGpuSession,
} from './gpuBootstrap';
import type { ChromashiftRenderer, ChromashiftTextureManager, RendererBackend } from './RendererTypes';

/** Default slot id for the main viewport canvas. */
export const PRIMARY_SLOT_ID = 'primary';

export interface RendererSlot {
  id: string;
  canvas: HTMLCanvasElement;
  renderer: ChromashiftRenderer;
  /** Present for WebGPU-backed slots. */
  webgpuContext?: GPUCanvasContext;
}

export interface RendererOrchestratorOptions {
  antialias?: boolean;
  backendPreference?: RendererBackend;
  onRuntimeError?: (error: GpuRuntimeError) => void;
}

export interface RendererOrchestratorBootstrapResult {
  orchestrator: RendererOrchestrator;
  backend: RendererBackend;
  fallbackReason: string | null;
}

/** Injectable factories for unit tests (no real WebGPU required). */
export interface RendererOrchestratorDeps {
  bootstrapWebGpu: typeof bootstrapWebGpu;
  configureWebGpuCanvas: typeof configureWebGpuCanvas;
  createWebGL2Context: typeof createWebGL2Context;
  withErrorScope: typeof withErrorScope;
  createWebGpuRenderer: (
    device: GPUDevice,
    context: GPUCanvasContext,
    format: GPUTextureFormat,
    antialias: boolean,
  ) => ChromashiftRenderer;
  createWebGLRenderer: (canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) => ChromashiftRenderer;
  createWebGpuTextureManager: (device: GPUDevice) => ChromashiftTextureManager;
  createWebGLTextureManager: (gl: WebGL2RenderingContext) => ChromashiftTextureManager;
  createGpuImageAnalysis: (device: GPUDevice) => GpuImageAnalysis;
  getRendererPreference: () => RendererBackend;
}

export function defaultRendererOrchestratorDeps(): RendererOrchestratorDeps {
  return {
    bootstrapWebGpu,
    configureWebGpuCanvas,
    createWebGL2Context,
    withErrorScope,
    createWebGpuRenderer: (device, context, format, antialias) =>
      new WebGPURenderer(device, context, format, antialias),
    createWebGLRenderer: (canvas, gl) => new WebGLRenderer(canvas, gl),
    createWebGpuTextureManager: (device) => new TextureManager(device),
    createWebGLTextureManager: (gl) => new WebGLTextureManager(gl),
    createGpuImageAnalysis: (device) => new GpuImageAnalysis(device),
    getRendererPreference,
  };
}

/**
 * Owns one GPU session (WebGPU device or WebGL2 context) plus shared texture
 * resources, and manages N renderer instances bound to separate canvases.
 */
export class RendererOrchestrator {
  private readonly slots = new Map<string, RendererSlot>();
  private session: WebGpuSession | null = null;
  private textureManager: ChromashiftTextureManager | null = null;
  private gpuAnalysis: GpuImageAnalysis | null = null;
  private webglContext: WebGL2RenderingContext | null = null;
  private backend: RendererBackend;
  private readonly antialias: boolean;
  private onRuntimeError?: (error: GpuRuntimeError) => void;
  private destroyed = false;
  private readonly deps: RendererOrchestratorDeps;

  private constructor(
    backend: RendererBackend,
    options: RendererOrchestratorOptions,
    deps: RendererOrchestratorDeps,
  ) {
    this.backend = backend;
    this.antialias = options.antialias ?? false;
    this.onRuntimeError = options.onRuntimeError;
    this.deps = deps;
  }

  /**
   * Bootstrap the shared GPU session on `primaryCanvas` and create the primary slot.
   * Falls back from WebGPU to WebGL when `backendPreference` is `webgpu` and bootstrap fails.
   */
  static async bootstrap(
    primaryCanvas: HTMLCanvasElement,
    options: RendererOrchestratorOptions = {},
    deps: RendererOrchestratorDeps = defaultRendererOrchestratorDeps(),
  ): Promise<RendererOrchestratorBootstrapResult> {
    const backendPreference = options.backendPreference ?? deps.getRendererPreference();
    const orchestrator = new RendererOrchestrator(backendPreference, options, deps);
    let fallbackReason: string | null = null;

    try {
      if (backendPreference === 'webgl') {
        orchestrator.initWebGL(primaryCanvas);
        orchestrator.createSlot(PRIMARY_SLOT_ID, primaryCanvas);
      } else {
        await orchestrator.initWebGPU(primaryCanvas);
        await orchestrator.createPrimaryWebGpuSlot(primaryCanvas);
      }
    } catch (primaryError) {
      if (backendPreference !== 'webgpu') throw primaryError;

      orchestrator.resetWebGpuResources();
      fallbackReason = primaryError instanceof Error ? primaryError.message : String(primaryError);
      orchestrator.backend = 'webgl';
      orchestrator.initWebGL(primaryCanvas);
      orchestrator.createSlot(PRIMARY_SLOT_ID, primaryCanvas);
    }

    return {
      orchestrator,
      backend: orchestrator.backend,
      fallbackReason,
    };
  }

  private async initWebGPU(primaryCanvas: HTMLCanvasElement): Promise<void> {
    const session = await this.deps.bootstrapWebGpu({
      canvas: primaryCanvas,
      antialias: this.antialias,
      onRuntimeError: (error) => {
        if (this.destroyed) return;
        this.teardownAllSlots();
        this.onRuntimeError?.(error);
      },
    });

    this.session = session;
    this.textureManager = this.deps.createWebGpuTextureManager(session.device);
    this.gpuAnalysis = this.deps.createGpuImageAnalysis(session.device);
    publishGpuComputeBreadcrumbs(this.gpuAnalysis.support);
  }

  private initWebGL(primaryCanvas: HTMLCanvasElement): void {
    const gl = this.deps.createWebGL2Context(primaryCanvas, { antialias: this.antialias });
    this.webglContext = gl;
    this.textureManager = this.deps.createWebGLTextureManager(gl);
  }

  private async createPrimaryWebGpuSlot(primaryCanvas: HTMLCanvasElement): Promise<void> {
    if (!this.session) {
      throw new Error('WebGPU session is not initialized.');
    }

    const renderer = await this.deps.withErrorScope(
      this.session.device,
      'validation',
      'WebGPURenderer',
      () =>
        this.deps.createWebGpuRenderer(
          this.session!.device,
          this.session!.context,
          this.session!.format,
          this.antialias,
        ),
    );

    this.slots.set(PRIMARY_SLOT_ID, {
      id: PRIMARY_SLOT_ID,
      canvas: primaryCanvas,
      renderer,
      webgpuContext: this.session.context,
    });
  }

  /**
   * Create a renderer bound to `canvas`. WebGPU slots share the bootstrapped device;
   * WebGL supports only the primary slot.
   */
  createSlot(id: string, canvas: HTMLCanvasElement): RendererSlot {
    if (this.destroyed) {
      throw new Error('RendererOrchestrator has been destroyed.');
    }
    if (this.slots.has(id)) {
      throw new Error(`Renderer slot "${id}" already exists.`);
    }

    if (this.backend === 'webgpu') {
      return this.createWebGpuSlot(id, canvas);
    }

    if (this.slots.size > 0) {
      throw new Error('WebGL backend supports only one renderer slot.');
    }
    if (!this.webglContext) {
      throw new Error('WebGL context is not initialized.');
    }

    const renderer = this.deps.createWebGLRenderer(canvas, this.webglContext);
    const slot: RendererSlot = { id, canvas, renderer };
    this.slots.set(id, slot);
    return slot;
  }

  private createWebGpuSlot(id: string, canvas: HTMLCanvasElement): RendererSlot {
    if (!this.session) {
      throw new Error('WebGPU session is not initialized.');
    }

    let context: GPUCanvasContext;
    if (id === PRIMARY_SLOT_ID && canvas === this.session.context.canvas) {
      context = this.session.context;
    } else {
      const ctx = canvas.getContext('webgpu');
      if (!ctx) {
        throw new Error(`Failed to get WebGPU context for slot "${id}".`);
      }
      if (canvas.width === 0) canvas.width = 1;
      if (canvas.height === 0) canvas.height = 1;
      this.deps.configureWebGpuCanvas(ctx, this.session.device, this.session.format);
      context = ctx;
    }

    const renderer = this.deps.createWebGpuRenderer(
      this.session.device,
      context,
      this.session.format,
      this.antialias,
    );

    const slot: RendererSlot = { id, canvas, renderer, webgpuContext: context };
    this.slots.set(id, slot);
    return slot;
  }

  destroySlot(id: string): void {
    const slot = this.slots.get(id);
    if (!slot) return;

    slot.renderer.destroy();
    if (
      slot.webgpuContext &&
      this.session &&
      slot.webgpuContext !== this.session.context
    ) {
      slot.webgpuContext.unconfigure();
    }
    this.slots.delete(id);
  }

  getSlot(id: string): RendererSlot | undefined {
    return this.slots.get(id);
  }

  getPrimarySlot(): RendererSlot | undefined {
    return this.slots.get(PRIMARY_SLOT_ID);
  }

  listSlots(): readonly RendererSlot[] {
    return [...this.slots.values()];
  }

  sharedDevice(): GPUDevice | null {
    return this.session?.device ?? null;
  }

  sharedSession(): WebGpuSession | null {
    return this.session;
  }

  sharedTextureManager(): ChromashiftTextureManager | null {
    return this.textureManager;
  }

  sharedGpuAnalysis(): GpuImageAnalysis | null {
    return this.gpuAnalysis;
  }

  backendKind(): RendererBackend {
    return this.backend;
  }

  /** Reconfigure every active WebGPU canvas context after resize / DPR changes. */
  resizeAll(): void {
    if (this.destroyed || this.backend !== 'webgpu' || !this.session) return;

    this.session.reconfigure();
    for (const slot of this.slots.values()) {
      if (slot.webgpuContext && slot.webgpuContext !== this.session.context) {
        this.deps.configureWebGpuCanvas(slot.webgpuContext, this.session.device, this.session.format);
      }
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    this.teardownAllSlots();
    this.resetWebGpuResources();
    this.webglContext = null;
    this.onRuntimeError = undefined;
  }

  /** Tear down a partial WebGPU bootstrap before falling back to WebGL. */
  private resetWebGpuResources(): void {
    this.gpuAnalysis?.destroy();
    this.gpuAnalysis = null;

    this.textureManager?.destroy();
    this.textureManager = null;

    const session = this.session;
    this.session = null;
    if (!session) return;

    session.detach();
    session.device.destroy();
    session.context.unconfigure();
  }

  private teardownAllSlots(): void {
    const slots = [...this.slots.values()];
    this.slots.clear();

    for (const slot of slots) {
      slot.renderer.destroy();
      if (
        slot.webgpuContext &&
        this.session &&
        slot.webgpuContext !== this.session.context
      ) {
        slot.webgpuContext.unconfigure();
      }
    }

    if (this.session) {
      this.session.context.unconfigure();
    }
  }
}
