import { WebGPURenderer } from './WebGPURenderer';
import { WebGLRenderer } from './WebGLRenderer';
import { TextureManager } from './TextureManager';
import { WebGLTextureManager } from './WebGLTextureManager';
import type { ChromashiftRenderer, ChromashiftTextureManager, RendererBackend } from './RendererTypes';
import {
  bootstrapWebGpu,
  configureWebGpuCanvas,
  createWebGL2Context,
  withErrorScope,
  type GpuRuntimeError,
  type WebGpuSession,
} from './gpuBootstrap';
import { GpuImageAnalysis } from './compute/GpuImageAnalysis';
import { publishGpuComputeBreadcrumbs } from './compute/computeSupport';
import { getRendererPreference } from './rendererMode';

export interface RendererSlot {
  id: string;
  canvas: HTMLCanvasElement;
  renderer: ChromashiftRenderer;
  /** Per-slot WebGPU canvas context (undefined for WebGL). */
  webgpuContext?: GPUCanvasContext;
}

export interface RendererOrchestratorOptions {
  antialias: boolean;
  backend?: RendererBackend;
  onRuntimeError?: (error: GpuRuntimeError) => void;
}

export interface BootstrapRendererOrchestratorOptions extends RendererOrchestratorOptions {
  primaryCanvas: HTMLCanvasElement;
  primarySlotId?: string;
}

export interface BootstrapRendererOrchestratorResult {
  orchestrator: RendererOrchestrator;
  primarySlot: RendererSlot;
  backend: RendererBackend;
  fallbackReason: string | null;
}

/** Injectable factories for unit tests (no WebGPU required). */
export interface RendererOrchestratorDeps {
  bootstrapWebGpu: typeof bootstrapWebGpu;
  configureWebGpuCanvas: typeof configureWebGpuCanvas;
  createWebGL2Context: typeof createWebGL2Context;
  createWebGPURenderer: (
    device: GPUDevice,
    context: GPUCanvasContext,
    format: GPUTextureFormat,
    antialias: boolean,
  ) => ChromashiftRenderer | Promise<ChromashiftRenderer>;
  createSecondaryWebGPURenderer: (
    device: GPUDevice,
    context: GPUCanvasContext,
    format: GPUTextureFormat,
    antialias: boolean,
  ) => ChromashiftRenderer;
  createWebGLRenderer: (
    canvas: HTMLCanvasElement,
    gl: WebGL2RenderingContext,
  ) => ChromashiftRenderer;
  createTextureManager: (device: GPUDevice) => TextureManager;
  createWebGLTextureManager: (gl: WebGL2RenderingContext) => WebGLTextureManager;
  createGpuImageAnalysis: (device: GPUDevice) => GpuImageAnalysis;
}

export const defaultRendererOrchestratorDeps: RendererOrchestratorDeps = {
  bootstrapWebGpu,
  configureWebGpuCanvas,
  createWebGL2Context,
  createWebGPURenderer: (device, context, format, antialias) =>
    withErrorScope(device, 'validation', 'WebGPURenderer', () =>
      new WebGPURenderer(device, context, format, antialias),
    ),
  createSecondaryWebGPURenderer: (device, context, format, antialias) =>
    new WebGPURenderer(device, context, format, antialias),
  createWebGLRenderer: (canvas, gl) => new WebGLRenderer(canvas, gl),
  createTextureManager: (device) => new TextureManager(device),
  createWebGLTextureManager: (gl) => new WebGLTextureManager(gl),
  createGpuImageAnalysis: (device) => new GpuImageAnalysis(device),
};

/**
 * Owns one shared GPU session (WebGPU device or WebGL2 context) plus a texture
 * manager, and manages N renderer instances bound to separate canvases.
 */
export class RendererOrchestrator {
  private readonly slots = new Map<string, RendererSlot>();
  private session: WebGpuSession | null = null;
  private primaryCanvas: HTMLCanvasElement | null = null;
  private webglContext: WebGL2RenderingContext | null = null;
  private textureManager: ChromashiftTextureManager | null = null;
  private gpuImageAnalysis: GpuImageAnalysis | null = null;
  private backend: RendererBackend;
  private fallbackReason: string | null = null;
  private readonly antialias: boolean;
  private readonly onRuntimeError?: (error: GpuRuntimeError) => void;
  private readonly deps: RendererOrchestratorDeps;
  private destroyed = false;

  private constructor(
    backend: RendererBackend,
    antialias: boolean,
    onRuntimeError: ((error: GpuRuntimeError) => void) | undefined,
    deps: RendererOrchestratorDeps,
  ) {
    this.backend = backend;
    this.antialias = antialias;
    this.onRuntimeError = onRuntimeError;
    this.deps = deps;
  }

  static async bootstrap(
    options: BootstrapRendererOrchestratorOptions,
    deps: RendererOrchestratorDeps = defaultRendererOrchestratorDeps,
  ): Promise<BootstrapRendererOrchestratorResult> {
    const preferredBackend = options.backend ?? getRendererPreference();
    const orchestrator = new RendererOrchestrator(
      preferredBackend,
      options.antialias,
      options.onRuntimeError,
      deps,
    );
    const primarySlotId = options.primarySlotId ?? 'main';
    let fallbackReason: string | null = null;
    let actualBackend = preferredBackend;

    try {
      if (preferredBackend === 'webgl') {
        orchestrator.bootstrapWebGL(options.primaryCanvas);
        orchestrator.createSlot(primarySlotId, options.primaryCanvas);
      } else {
        await orchestrator.bootstrapWebGpuSession(options.primaryCanvas);
        await orchestrator.createPrimaryWebGpuSlot(primarySlotId, options.primaryCanvas);
      }
    } catch (primaryError) {
      if (preferredBackend === 'webgpu') {
        fallbackReason = primaryError instanceof Error ? primaryError.message : String(primaryError);
        actualBackend = 'webgl';
        orchestrator.setBackend('webgl');
        orchestrator.bootstrapWebGL(options.primaryCanvas);
        orchestrator.createSlot(primarySlotId, options.primaryCanvas);
      } else {
        throw primaryError;
      }
    }

    orchestrator.fallbackReason = fallbackReason;
    const primarySlot = orchestrator.getSlot(primarySlotId);
    if (!primarySlot) {
      throw new Error(`Primary slot "${primarySlotId}" was not created.`);
    }

    return {
      orchestrator,
      primarySlot,
      backend: actualBackend,
      fallbackReason,
    };
  }

  getBackend(): RendererBackend {
    return this.backend;
  }

  getFallbackReason(): string | null {
    return this.fallbackReason;
  }

  sessionRef(): WebGpuSession | null {
    return this.session;
  }

  sharedDevice(): GPUDevice | null {
    return this.session?.device ?? null;
  }

  textureManagerRef(): ChromashiftTextureManager | null {
    return this.textureManager;
  }

  gpuImageAnalysisRef(): GpuImageAnalysis | null {
    return this.gpuImageAnalysis;
  }

  getSlot(id: string): RendererSlot | undefined {
    return this.slots.get(id);
  }

  slotIds(): string[] {
    return [...this.slots.keys()];
  }

  /**
   * Bind a renderer to `canvas`. WebGPU slots share the bootstrapped device;
   * the primary canvas reuses the session context from bootstrap.
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
    return this.createWebGLSlot(id, canvas);
  }

  destroySlot(id: string, options?: { unconfigureContext?: boolean }): void {
    const slot = this.slots.get(id);
    if (!slot) return;

    slot.renderer.destroy();

    if (slot.webgpuContext) {
      const isPrimary = slot.webgpuContext === this.session?.context;
      if (!isPrimary || options?.unconfigureContext) {
        slot.webgpuContext.unconfigure();
      }
    }

    this.slots.delete(id);
  }

  /** Reconfigure every active WebGPU canvas context after resize / DPR changes. */
  resizeAll(): void {
    if (!this.session) return;

    this.session.reconfigure();
    for (const slot of this.slots.values()) {
      const ctx = slot.webgpuContext;
      if (ctx && ctx !== this.session.context) {
        this.deps.configureWebGpuCanvas(ctx, this.session.device, this.session.format);
      }
    }
  }

  /** Tear down all slots, shared textures, and the GPU session/device. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    for (const id of [...this.slots.keys()]) {
      this.destroySlot(id, { unconfigureContext: true });
    }

    this.gpuImageAnalysis?.destroy();
    this.textureManager?.destroy();
    this.session?.detach();
    this.session?.device.destroy();

    this.gpuImageAnalysis = null;
    this.textureManager = null;
    this.session = null;
    this.primaryCanvas = null;
    this.webglContext = null;
  }

  private setBackend(backend: RendererBackend): void {
    this.backend = backend;
  }

  private async bootstrapWebGpuSession(primaryCanvas: HTMLCanvasElement): Promise<void> {
    this.primaryCanvas = primaryCanvas;
    this.session = await this.deps.bootstrapWebGpu({
      canvas: primaryCanvas,
      antialias: this.antialias,
      onRuntimeError: (error) => {
        if (error.kind === 'device-lost') {
          this.destroyAllSlots();
        }
        this.onRuntimeError?.(error);
      },
    });
    this.textureManager = this.deps.createTextureManager(this.session.device);
    this.gpuImageAnalysis = this.deps.createGpuImageAnalysis(this.session.device);
    publishGpuComputeBreadcrumbs(this.gpuImageAnalysis.support);
  }

  private bootstrapWebGL(primaryCanvas: HTMLCanvasElement): void {
    this.primaryCanvas = primaryCanvas;
    const gl = this.deps.createWebGL2Context(primaryCanvas, { antialias: this.antialias });
    this.webglContext = gl;
    this.textureManager = this.deps.createWebGLTextureManager(gl);
  }

  private resolveWebGpuContext(canvas: HTMLCanvasElement): GPUCanvasContext {
    if (!this.session) {
      throw new Error('WebGPU session is not bootstrapped.');
    }

    if (canvas === this.primaryCanvas) {
      return this.session.context;
    }

    const ctx = canvas.getContext('webgpu');
    if (!ctx) {
      throw new Error('Failed to get WebGPU context from canvas.');
    }
    if (canvas.width === 0) canvas.width = 1;
    if (canvas.height === 0) canvas.height = 1;
    this.deps.configureWebGpuCanvas(ctx, this.session.device, this.session.format);
    return ctx;
  }

  private async createPrimaryWebGpuSlot(id: string, canvas: HTMLCanvasElement): Promise<RendererSlot> {
    if (!this.session) {
      throw new Error('WebGPU session is not bootstrapped.');
    }
    if (this.slots.has(id)) {
      throw new Error(`Renderer slot "${id}" already exists.`);
    }

    const context = this.resolveWebGpuContext(canvas);
    const renderer = await this.deps.createWebGPURenderer(
      this.session.device,
      context,
      this.session.format,
      this.antialias,
    );

    const slot: RendererSlot = { id, canvas, renderer, webgpuContext: context };
    this.slots.set(id, slot);
    return slot;
  }

  private createWebGpuSlot(id: string, canvas: HTMLCanvasElement): RendererSlot {
    if (!this.session) {
      throw new Error('WebGPU session is not bootstrapped.');
    }

    const context = this.resolveWebGpuContext(canvas);
    const renderer = this.deps.createSecondaryWebGPURenderer(
      this.session.device,
      context,
      this.session.format,
      this.antialias,
    );

    const slot: RendererSlot = { id, canvas, renderer, webgpuContext: context };
    this.slots.set(id, slot);
    return slot;
  }

  private createWebGLSlot(id: string, canvas: HTMLCanvasElement): RendererSlot {
    if (!this.webglContext || !this.primaryCanvas) {
      throw new Error('WebGL context is not bootstrapped.');
    }
    if (canvas !== this.primaryCanvas) {
      throw new Error('WebGL orchestrator supports only the primary canvas slot.');
    }
    if (this.slots.size > 0) {
      throw new Error('WebGL orchestrator supports only a single renderer slot.');
    }

    const renderer = this.deps.createWebGLRenderer(canvas, this.webglContext);
    const slot: RendererSlot = { id, canvas, renderer };
    this.slots.set(id, slot);
    return slot;
  }

  private destroyAllSlots(): void {
    for (const id of [...this.slots.keys()]) {
      this.destroySlot(id, { unconfigureContext: true });
    }
  }
}
