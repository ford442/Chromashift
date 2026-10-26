import { WebGLRenderer } from '../webgl/WebGLRenderer';
import { WebGLTextureManager } from '../webgl/WebGLTextureManager';
import type { RendererState } from '../types/RendererState';
import { rendererStateValue } from '../graph/exec/uniforms';
import { createWebGL2Context } from '../gpu/gpuBootstrap';
import { passGraphSelection } from '../graph/gate';
import { presetGraphSource } from '../graph/variants';
import type { FrameClock, FrameScheduler } from '../frame/FrameClock';

/**
 * An immersive session's frame loop as a {@link FrameScheduler}. While a
 * session is presenting, the window's `requestAnimationFrame` may stop (a
 * standalone headset) or run at the monitor's rate; the headset's own loop is
 * the one every output should tick on.
 */
export function xrSessionScheduler(session: XRSession): FrameScheduler {
  return {
    request: (callback) => session.requestAnimationFrame((now, frame) => callback(now, frame)),
    cancel: (handle) => session.cancelAnimationFrame(handle),
  };
}

/** The XR renderer's slot in `window.passGraphSlotsExecuting`. */
export const XR_GRAPH_SLOT = 'xr';

/**
 * The layer's framebuffer scale: the headset's recommended resolution × this,
 * per eye. Half resolution is the UA's job (`framebufferScaleFactor`), not a
 * centred quarter-area patch of a full-size viewport.
 */
export const XR_RENDER_SCALE = 0.5;

export interface WebXrRenderViewport {
  x: number;
  y: number;
  width: number;
  height: number;
  /** The `XRWebGLLayer`'s framebuffer: the composite lands in it, not on the canvas. */
  framebuffer: WebGLFramebuffer | null;
}

/**
 * Draws one eye. `advance` is true for the last eye of an XR frame only: the
 * tracers decay and flip once per frame, not once per eye, so every eye shows
 * the same accumulation (see {@link xrRendererStateOverrides}).
 */
export type WebXrFrameRenderer = (
  renderer: WebGLRenderer,
  viewport: WebXrRenderViewport,
  fps: number,
  advance: boolean,
) => void;

/**
 * Phase-0 WebXR spike: renders the WebGL composite into an XRWebGLLayer at half
 * resolution per eye. Requires a dedicated xr-compatible WebGL2 context (sharing
 * the desktop one is #178).
 *
 * While presenting, the app's {@link FrameClock} ticks on the session's frame
 * loop (see {@link xrSessionScheduler}) and the headset is drawn by a `render`
 * task — every subsystem shares the headset's tick.
 *
 * The headset draws the session's pass graph, through the same
 * `WebGLGraphExecutor` the desktop WebGL canvas uses — so a `?graph=feedback`
 * session shows the feedback graph in the headset too. Its renderer is not the
 * primary canvas: it reports into its own `window.passGraphSlotsExecuting`
 * entry and leaves the session-wide breadcrumbs alone.
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
  /** Undo the clock wiring made in `enter`. */
  private releaseClock: (() => void) | null = null;

  constructor() {
    this.canvas = document.createElement('canvas');
    // The same attempt order and attribute matrix as the desktop canvas.
    let gl: WebGL2RenderingContext;
    try {
      gl = createWebGL2Context(this.canvas, {
        antialias: false,
        preserveDrawingBuffer: false,
        xrCompatible: true,
      });
    } catch (error) {
      throw new Error('WebGL2 (xrCompatible) is required for WebXR.', { cause: error });
    }
    this.gl = gl;
    this.renderer = new WebGLRenderer(this.canvas, gl);
    this.renderer.setPassGraph(presetGraphSource(passGraphSelection().name), {
      slot: XR_GRAPH_SLOT,
      primary: false,
    });
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

  async enter(clock: FrameClock, onEnd?: () => void): Promise<void> {
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
    const layer = new XRWebGLLayer(session, this.gl, { framebufferScaleFactor: XR_RENDER_SCALE });
    this.layer = layer;
    // The spec returns undefined; @types/webxr says Promise. Nothing to await either way.
    void session.updateRenderState({ baseLayer: layer });
    this.refSpace = await session.requestReferenceSpace('local-floor');

    const handleEnd = () => {
      this.teardownSession();
      this.onSessionEnd?.();
    };
    session.addEventListener('end', handleEnd, { once: true });

    this.active = true;
    const restoreScheduler = clock.useScheduler(xrSessionScheduler(session));
    const unregister = clock.register('render', ({ xrFrame }) => {
      if (xrFrame) this.drawFrame(xrFrame);
    }, 'xr-render');
    this.releaseClock = () => {
      unregister();
      restoreScheduler();
    };
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
    this.releaseClock?.();
    this.releaseClock = null;
    this.active = false;
    this.session = null;
    this.layer = null;
    this.refSpace = null;
  }

  /** Draw both eyes for one XR frame (the clock's `render` phase calls this). */
  drawFrame(frame: XRFrame): void {
    const layer = this.layer;
    const refSpace = this.refSpace;
    if (!layer || !refSpace || !this.active) return;

    const pose = frame.getViewerPose(refSpace);
    if (pose && this.frameRenderer) {
      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, layer.framebuffer);
      this.gl.disable(this.gl.DEPTH_TEST);
      this.gl.disable(this.gl.CULL_FACE);
      this.gl.disable(this.gl.BLEND);

      const viewports = xrEyeViewports(pose.views.map((view) => layer.getViewport(view)));
      viewports.forEach((viewport, index) => {
        this.frameRenderer!(
          this.renderer,
          { ...viewport, framebuffer: layer.framebuffer },
          this.fps,
          index === viewports.length - 1,
        );
      });
    }
  }
}

/**
 * Each eye's whole viewport in the layer's framebuffer — already at
 * `XR_RENDER_SCALE`, since the layer was sized with it. Views the layer has no
 * viewport for are skipped.
 */
export function xrEyeViewports(
  viewports: readonly (XRViewport | null | undefined)[],
): { x: number; y: number; width: number; height: number }[] {
  return viewports
    .filter((viewport): viewport is XRViewport => viewport != null)
    .map(({ x, y, width, height }) => ({ x, y, width, height }));
}

/**
 * Renderer overrides for one eye (no readback/HUD).
 *
 * Every eye but the last draws `paused`, which skips the accumulator passes
 * and the ping-pong flip: the compositor reads the previous frame's
 * accumulation either way, so all eyes show the same tracers, and the last
 * eye advances them — once per XR frame. Advancing per eye decayed the
 * tracers twice as fast as the desktop and left the eyes a frame apart.
 */
export function xrRendererStateOverrides(state: RendererState, advance = true): Partial<RendererState> {
  return {
    paused: rendererStateValue(state, 'paused') || !advance,
    livePreviewEnabled: false,
    profilePerformance: false,
    viewportQuarterZoom: false,
    viewportHalfOverlay: false,
    diagnosticsMode: false,
  };
}
