import { WebGLRenderer } from '../webgl/WebGLRenderer';
import { WebGLTextureManager } from '../WebGLTextureManager';
import type { RendererState } from '../types/RendererState';

export const XR_RENDER_SCALE = 0.5;

export interface WebXrRenderViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type WebXrFrameRenderer = (
  renderer: WebGLRenderer,
  viewport: WebXrRenderViewport,
  fps: number,
) => void;

/**
 * Phase-0 WebXR spike: renders the WebGL composite into an XRWebGLLayer at half
 * resolution per eye. Requires a dedicated xr-compatible WebGL2 context.
 */
export class WebXrPresenter {
  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  readonly renderer: WebGLRenderer;
  readonly textureManager: WebGLTextureManager;

  private session: XRSession | null = null;
  private layer: XRWebGLLayer | null = null;
  private refSpace: XRReferenceSpace | null = null;
  private active = false;
  private currentUrl: string | null = null;
  private frameRenderer: WebXrFrameRenderer | null = null;
  private fps = 30;
  private onSessionEnd: (() => void) | null = null;

  constructor() {
    this.canvas = document.createElement('canvas');
    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      xrCompatible: true,
    }) as WebGL2RenderingContext | null;
    if (!gl) {
      throw new Error('WebGL2 (xrCompatible) is required for WebXR.');
    }
    this.gl = gl;
    this.renderer = new WebGLRenderer(this.canvas, gl);
    this.textureManager = new WebGLTextureManager(gl);
  }

  isActive(): boolean {
    return this.active;
  }

  setFrameRenderer(renderer: WebXrFrameRenderer | null, fps = 30): void {
    this.frameRenderer = renderer;
    this.fps = fps;
  }

  async syncTexture(url: string): Promise<void> {
    if (!url || url === this.currentUrl) return;
    const texture = await this.textureManager.loadTexture(url);
    this.renderer.setTexture(texture);
    this.renderer.clearPersistence();
    this.currentUrl = url;
  }

  async enter(onEnd?: () => void): Promise<void> {
    if (this.active) return;
    if (!navigator.xr) throw new Error('WebXR is not available.');

    const supported = await navigator.xr.isSessionSupported('immersive-vr');
    if (!supported) throw new Error('immersive-vr is not supported on this device.');

    this.onSessionEnd = onEnd ?? null;
    const session = await navigator.xr.requestSession('immersive-vr', {
      requiredFeatures: ['local-floor'],
    });
    this.session = session;

    await this.gl.makeXRCompatible();
    const layer = new XRWebGLLayer(session, this.gl);
    this.layer = layer;
    session.updateRenderState({ baseLayer: layer });
    this.refSpace = await session.requestReferenceSpace('local-floor');

    const handleEnd = () => {
      this.teardownSession();
      this.onSessionEnd?.();
    };
    session.addEventListener('end', handleEnd, { once: true });

    this.active = true;
    session.requestAnimationFrame(this.onXrFrame);
  }

  exit(): void {
    if (!this.session) return;
    void this.session.end();
  }

  destroy(): void {
    this.exit();
    this.teardownSession();
    this.renderer.destroy();
    this.textureManager.destroy();
    this.currentUrl = null;
  }

  private teardownSession(): void {
    this.active = false;
    this.session = null;
    this.layer = null;
    this.refSpace = null;
  }

  private onXrFrame = (_time: number, frame: XRFrame): void => {
    const session = this.session;
    const layer = this.layer;
    const refSpace = this.refSpace;
    if (!session || !layer || !refSpace || !this.active) return;

    const pose = frame.getViewerPose(refSpace);
    if (pose && this.frameRenderer) {
      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, layer.framebuffer);
      this.gl.disable(this.gl.DEPTH_TEST);
      this.gl.disable(this.gl.CULL_FACE);
      this.gl.disable(this.gl.BLEND);

      for (const view of pose.views) {
        const viewport = layer.getViewport(view);
        if (!viewport) continue;

        const width = Math.max(1, Math.floor(viewport.width * XR_RENDER_SCALE));
        const height = Math.max(1, Math.floor(viewport.height * XR_RENDER_SCALE));
        const x = viewport.x + Math.floor((viewport.width - width) / 2);
        const y = viewport.y + Math.floor((viewport.height - height) / 2);

        this.gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
        this.gl.clearColor(0, 0, 0, 1);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT);

        this.frameRenderer(this.renderer, { x, y, width, height }, this.fps);
      }
    }

    session.requestAnimationFrame(this.onXrFrame);
  };
}

/** Renderer overrides for XR (half internal scale, no readback/HUD). */
export function xrRendererStateOverrides(state: RendererState): Partial<RendererState> {
  return {
    layerScale: (state.layerScale ?? 1) * XR_RENDER_SCALE,
    tracerScale: (state.tracerScale ?? 1) * XR_RENDER_SCALE,
    livePreviewEnabled: false,
    profilePerformance: false,
    viewportQuarterZoom: false,
    viewportHalfOverlay: false,
    diagnosticsMode: false,
  };
}
