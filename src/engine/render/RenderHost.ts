/**
 * The page's half of the render protocol (#253): everything the UI asks of
 * the renderer goes through here, whichever thread the renderer runs on.
 *
 * One host per page. Before its first boot it picks the transport
 * (`transport.ts`), once — a canvas handed to a worker cannot come back:
 *
 * - **worker**: a page-lifetime `render.worker.ts` behind the shared worker
 *   channel. Each canvas is transferred (`transferControlToOffscreen`) the
 *   first time it is booted or attached, and named by id after that; resizes
 *   are messages, since a transferred canvas cannot be sized from the page.
 *   `set-loop` posts coalesce to one per task.
 * - **main**: the same `RenderService`, in-process, on the page's clock.
 *   Calls run synchronously up to their first `await` and events are
 *   delivered synchronously, so the loop behaves exactly as it did when the
 *   hooks drove the renderer themselves.
 *
 * The host also applies the worker's forwarded breadcrumbs to `window`,
 * publishes `renderTransport` / `renderTransportReason`, and installs
 * `window.__renderDebug` when armed (`debug.ts`).
 */

import { applyForwardedDiagnostics, publishDiagnostics } from '../diagnostics';
import type { FrameClock } from '../frame/FrameClock';
import type { RenderWorkerPageScope } from '../graph/capabilities';
import type { GpuRuntimeError } from '../gpu/gpuErrors';
import type { ReactiveModulation } from '../reactive/types';
import type { CpuMotionField, ExportRenderer, RendererBackend } from '../types/RendererContracts';
import {
  createWorkerRpc,
  type RpcHandlerContext,
  type RpcHandlers,
  type RpcRequest,
  type RpcResponse,
  type WorkerRpc,
} from '../workers/rpc';
import { installRenderDebug, renderDebugArmed } from './debug';
import { RenderService, type RenderServiceDeps } from './RenderService';
import { selectRenderTransport, type RenderTransportChoice } from './transport';
import type {
  ExportFrameRequest,
  LoadSourceRequest,
  MotionDemand,
  RenderBootRequest,
  RenderBootResult,
  RenderCellRequest,
  RenderEvents,
  RenderLoopInput,
  RenderProtocol,
  RenderSurface,
  RenderTransportKind,
  RenderWorkerProtocol,
} from './protocol';

type Method = keyof RenderWorkerProtocol & string;
type Req<M extends Method> = RpcRequest<RenderWorkerProtocol, M>;
type Res<M extends Method> = RpcResponse<RenderWorkerProtocol, M>;

/** One way to reach the service. */
interface RenderChannel {
  call<M extends Method>(method: M, req: Req<M>, transfer?: Transferable[]): Promise<Res<M>>;
  notify<M extends Method>(method: M, req: Req<M>, transfer?: Transferable[]): void;
}

type Listener<K extends keyof RenderEvents> = (payload: RenderEvents[K]) => void;

/** How long the worker half of the capability may take to answer before the page renders itself. */
const WORKER_PROBE_TIMEOUT_MS = 10_000;

const NOOP_CONTEXT: RpcHandlerContext<never> = { progress: () => {}, transfer: () => {} };

function reportNotifyError(method: string, error: unknown): void {
  console.error(`[render] "${method}" failed:`, error);
}

/** The service in this realm: a call starts synchronously, exactly as a direct method call would. */
function inProcessChannel(handlers: RpcHandlers<RenderProtocol>): RenderChannel {
  const run = (method: string, req: unknown): unknown => {
    if (!Object.prototype.hasOwnProperty.call(handlers, method)) throw new Error(`unknown method "${method}"`);
    const handler = handlers[method as keyof RenderProtocol] as (req: unknown, ctx: RpcHandlerContext<never>) => unknown;
    return handler(req, NOOP_CONTEXT);
  };
  return {
    call: <M extends Method>(method: M, req: Req<M>) =>
      new Promise<Res<M>>((resolve) => resolve(run(method, req) as Res<M> | Promise<Res<M>>)),
    notify: (method, req) => {
      try {
        const result = run(method, req);
        if (result instanceof Promise) result.catch((error: unknown) => reportNotifyError(method, error));
      } catch (error) {
        reportNotifyError(method, error);
      }
    },
  };
}

function workerCrashError(error: Error): GpuRuntimeError {
  return {
    kind: 'bootstrap',
    message: 'The render worker stopped — reload the page to draw again.',
    detail: error.message,
    recoverable: false,
  };
}

function defaultRenderWorker(): Worker {
  return new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module', name: 'chromashift-render' });
}

export interface RenderHostOptions {
  /** The page's clock: the in-process service's loop runs on it. */
  clock: FrameClock;
  /** Overridable for tests. */
  createWorker?: () => Worker;
  /** Injected into an in-process service (tests). */
  serviceDeps?: Partial<RenderServiceDeps>;
  /** Skip selection and use this transport (tests). */
  transport?: RenderTransportKind;
  /** The page's `location.search`; read when needed, so tests and history changes see the current one. */
  search?: () => string;
  pageScope?: RenderWorkerPageScope;
}

/** Everything a boot needs that the host does not work out itself. */
export type RenderHostBootRequest = Omit<RenderBootRequest, 'surface' | 'pageSearch' | 'debug'>;

export class RenderHost {
  private readonly clock: FrameClock;
  private readonly options: RenderHostOptions;
  private selection: Promise<RenderChannel> | null = null;
  private channel: RenderChannel | null = null;
  private kind: RenderTransportKind | null = null;
  private service: RenderService | null = null;
  private rpc: WorkerRpc<RenderWorkerProtocol, never, RenderEvents> | null = null;
  private crashed: GpuRuntimeError | null = null;

  private readonly canvasIds = new WeakMap<HTMLCanvasElement, number>();
  private readonly handedOver = new Set<number>();
  private readonly sizes = new Map<number, { width: number; height: number }>();
  private readonly resized = new Set<number>();
  private nextCanvasId = 1;
  private readonly finalizer = typeof FinalizationRegistry === 'function'
    ? new FinalizationRegistry<number>((id) => this.releaseCanvas(id))
    : null;

  private readonly listeners = new Map<keyof RenderEvents, Set<(payload: never) => void>>();
  private pendingLoop: RenderLoopInput | null = null;
  private latestLoop: RenderLoopInput | null = null;
  private lastAngles: readonly number[] = [0, 0, 0];
  private demand: MotionDemand = { wantsCpu: false, use: { reads: false, needsFlow: false } };

  constructor(options: RenderHostOptions) {
    this.clock = options.clock;
    this.options = options;
  }

  /** The live transport, once chosen. */
  get transport(): RenderTransportKind | null {
    return this.kind;
  }

  /** What the CPU motion-field lane should feed, as the renderer last reported it. */
  get motionDemand(): MotionDemand {
    return this.demand;
  }

  private search(): string {
    if (this.options.search) return this.options.search();
    return typeof location === 'undefined' ? '' : location.search;
  }

  // ── Events ────────────────────────────────────────────────────────────────

  /** Listen for an event the renderer reports. Returns the unsubscribe. */
  on<K extends keyof RenderEvents>(event: K, listener: Listener<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    const entry = listener as (payload: never) => void;
    set.add(entry);
    return () => { set.delete(entry); };
  }

  private dispatch<K extends keyof RenderEvents>(event: K, payload: RenderEvents[K]): void {
    if (event === 'diagnostics') applyForwardedDiagnostics(payload as RenderEvents['diagnostics']);
    if (event === 'telemetry') {
      const angles = (payload as RenderEvents['telemetry']).angles;
      if (angles) this.lastAngles = angles;
    }
    if (event === 'motion-demand') this.demand = payload as MotionDemand;
    for (const listener of this.listeners.get(event) ?? []) (listener as Listener<K>)(payload);
  }

  // ── Transport ─────────────────────────────────────────────────────────────

  private ensureChannel(backend: RendererBackend): Promise<RenderChannel> {
    this.selection ??= this.select(backend);
    return this.selection;
  }

  private async select(backend: RendererBackend): Promise<RenderChannel> {
    let choice: RenderTransportChoice;
    if (this.options.transport) {
      choice = { kind: this.options.transport, reason: 'chosen by the host’s owner' };
    } else {
      choice = await selectRenderTransport({
        backend,
        search: this.search(),
        pageScope: this.options.pageScope ?? (globalThis as RenderWorkerPageScope),
        probeWorker: () => this.probeWorker(),
      });
    }
    if (choice.kind === 'worker') {
      this.channel = this.workerChannel();
    } else {
      this.rpc?.terminate('the page renders itself');
      this.rpc = null;
      this.service = new RenderService({
        clock: this.clock,
        ownsClock: false,
        transport: 'main',
        emit: (event, payload) => this.dispatch(event, payload),
        deps: this.options.serviceDeps,
      });
      this.channel = inProcessChannel(this.service.handlers());
    }
    this.kind = choice.kind;
    // What the page said before there was anyone to tell.
    if (this.latestLoop) this.channel.notify('set-loop', this.latestLoop);
    this.channel.notify('set-angles', { angles: [...this.lastAngles] });
    publishDiagnostics({ renderTransport: choice.kind, renderTransportReason: choice.reason });
    if (renderDebugArmed(this.search())) this.installDebug(choice.kind);
    return this.channel;
  }

  private workerRpc(): WorkerRpc<RenderWorkerProtocol, never, RenderEvents> {
    if (this.rpc) return this.rpc;
    const rpc = createWorkerRpc<RenderWorkerProtocol, never, RenderEvents>(
      this.options.createWorker ?? defaultRenderWorker,
      { label: 'render' },
    );
    const events: (keyof RenderEvents)[] = [
      'diagnostics', 'runtime-error', 'context-restored', 'telemetry', 'perf-degrade', 'motion-demand',
    ];
    for (const event of events) rpc.on(event, (payload) => this.dispatch(event, payload as never));
    rpc.onCrash((error) => {
      // The canvases died with it; a new worker could not draw them.
      if (this.kind !== 'worker') return;
      this.crashed = workerCrashError(error);
      this.dispatch('runtime-error', this.crashed);
    });
    this.rpc = rpc;
    return rpc;
  }

  private probeWorker() {
    return this.workerRpc().call('probe', {}, { timeoutMs: WORKER_PROBE_TIMEOUT_MS });
  }

  private workerChannel(): RenderChannel {
    const rpc = this.workerRpc();
    return {
      call: (method, req, transfer) => rpc.call(method, req, { transfer }),
      notify: (method, req, transfer) => rpc.notify(method, req, { transfer }),
    };
  }

  private installDebug(kind: RenderTransportKind): void {
    installRenderDebug({
      transport: kind,
      readPresentedFrame: (slot = 'main') => this.require().call('debug-presented-frame', { slot }),
      loseDevice: () => this.require().call('debug-lose-device', {}),
      frameTimeline: () => this.require().call('debug-frame-timeline', {}),
    });
  }

  private require(): RenderChannel {
    if (!this.channel) throw new Error('The renderer has not booted.');
    return this.channel;
  }

  /** Post to the service if there is one. Before the first boot there is nothing to tell. */
  private notify<M extends Method>(method: M, req: Req<M>, transfer?: Transferable[]): void {
    this.channel?.notify(method, req, transfer);
  }

  private call<M extends Method>(method: M, req: Req<M>, transfer?: Transferable[]): Promise<Res<M>> {
    if (!this.channel) return Promise.reject(new Error('The renderer has not booted.'));
    return this.channel.call(method, req, transfer);
  }

  // ── Canvases ──────────────────────────────────────────────────────────────

  private canvasId(canvas: HTMLCanvasElement): number {
    let id = this.canvasIds.get(canvas);
    if (id === undefined) {
      id = this.nextCanvasId++;
      this.canvasIds.set(canvas, id);
      this.finalizer?.register(canvas, id);
    }
    return id;
  }

  /** The surface naming `canvas`, carrying it (transferred, on the worker) the first time. */
  private surface(canvas: HTMLCanvasElement): { surface: RenderSurface; transfer: Transferable[] } {
    const canvasId = this.canvasId(canvas);
    const { width, height } = this.canvasSize(canvas);
    this.resized.delete(canvasId);
    if (this.handedOver.has(canvasId)) return { surface: { canvasId, width, height }, transfer: [] };
    this.handedOver.add(canvasId);
    if (this.kind === 'worker') {
      const offscreen = canvas.transferControlToOffscreen();
      return { surface: { canvasId, canvas: offscreen, width, height }, transfer: [offscreen] };
    }
    return { surface: { canvasId, canvas, width, height }, transfer: [] };
  }

  /**
   * Size `canvas`'s backing store. Before it is handed to a worker (or on the
   * main transport) the element is sized directly; after, the size is kept
   * here and posted by {@link flushResize}. Returns whether it changed.
   */
  sizeCanvas(canvas: HTMLCanvasElement, width: number, height: number): boolean {
    const id = this.canvasId(canvas);
    const current = this.canvasSize(canvas);
    if (current.width === width && current.height === height) return false;
    this.sizes.set(id, { width, height });
    if (this.kind !== 'worker' || !this.handedOver.has(id)) {
      canvas.width = width;
      canvas.height = height;
    }
    if (this.handedOver.has(id)) this.resized.add(id);
    return true;
  }

  /** `canvas`'s backing-store size — tracked here, since a transferred canvas's element no longer says. */
  canvasSize(canvas: HTMLCanvasElement): { width: number; height: number } {
    const id = this.canvasIds.get(canvas);
    const tracked = id === undefined ? undefined : this.sizes.get(id);
    return tracked ?? { width: canvas.width, height: canvas.height };
  }

  /** Tell the renderer which canvases changed size; it reconfigures before its next frame. */
  flushResize(): void {
    if (!this.channel) return;
    const surfaces = [...this.resized].map((canvasId) => ({ canvasId, ...this.sizes.get(canvasId)! }));
    this.resized.clear();
    this.notify('resize', { surfaces });
  }

  private releaseCanvas(id: number): void {
    this.handedOver.delete(id);
    this.sizes.delete(id);
    this.resized.delete(id);
    this.notify('release-canvas', { canvasId: id });
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async boot(canvas: HTMLCanvasElement, req: RenderHostBootRequest): Promise<RenderBootResult> {
    const channel = await this.ensureChannel(req.backend);
    if (this.crashed) return { ok: false, error: this.crashed };
    const { surface, transfer } = this.surface(canvas);
    const search = this.search();
    return channel.call('boot', { ...req, surface, pageSearch: search, debug: renderDebugArmed(search) }, transfer);
  }

  /** Tear the renderer down (a React cleanup); a boot in flight is cancelled. */
  shutdown(): void {
    this.notify('shutdown', {});
  }

  attach(slot: string, canvas: HTMLCanvasElement): void {
    if (!this.channel) return;
    const { surface, transfer } = this.surface(canvas);
    this.notify('attach', { slot, surface }, transfer);
  }

  detach(slot: string): void {
    this.notify('detach', { slot });
  }

  // ── The live loop ─────────────────────────────────────────────────────────

  /**
   * The latest loop input. In-process it lands at once; to the worker the
   * posts of one task coalesce into one message.
   */
  setLoop(input: RenderLoopInput): void {
    this.latestLoop = input;
    if (this.kind !== 'worker') {
      this.notify('set-loop', input);
      return;
    }
    const scheduled = this.pendingLoop !== null;
    this.pendingLoop = input;
    if (scheduled) return;
    queueMicrotask(() => {
      const latest = this.pendingLoop;
      this.pendingLoop = null;
      if (latest) this.notify('set-loop', latest);
    });
  }

  /** Stop drawing frames until the next `setLoop` asks for them (the loop's owner unmounted). */
  stopLoop(): void {
    if (this.latestLoop?.running) this.setLoop({ ...this.latestLoop, running: false });
  }

  setModulation(modulation: ReactiveModulation | null): void {
    this.notify('set-modulation', { modulation });
  }

  /** Reset the live angles (a knob, a preset). */
  setAngles(angles: readonly number[]): void {
    this.lastAngles = [...angles];
    this.notify('set-angles', { angles: [...angles] });
  }

  /** The live angles, exact: asked of the renderer. */
  getAngles(): Promise<number[]> {
    if (!this.channel) return Promise.resolve([...this.lastAngles]);
    return this.call('get-angles', {});
  }

  /**
   * The live angles now, synchronously: exact in-process (WebXR draws with
   * them every headset frame), the last telemetry sample on the worker.
   */
  currentAngles(): readonly number[] {
    return this.service?.currentAngles() ?? this.lastAngles;
  }

  setAntialiasing(enabled: boolean): void {
    this.notify('set-antialiasing', { enabled });
  }

  setCanvas(req: Req<'set-canvas'>): void {
    this.notify('set-canvas', req);
  }

  clearPersistence(slots?: string[]): void {
    this.notify('clear-persistence', { slots });
  }

  // ── Media ─────────────────────────────────────────────────────────────────

  loadSource(req: LoadSourceRequest): Promise<Res<'load-source'>> {
    return this.call('load-source', req);
  }

  uploadPixels(key: string, pixels: Uint8ClampedArray<ArrayBuffer>, width: number, height: number): Promise<void> {
    return this.call('upload-pixels', { key, pixels, width, height }, [pixels.buffer]);
  }

  /**
   * Upload the live source's current frame. In-process the element itself
   * is uploaded, as it always was; to the worker a `VideoFrame` of it is
   * transferred (an `ImageBitmap` where there is no `VideoFrame`), which the
   * renderer closes. Returns whether a decoded frame was there to send.
   */
  uploadVideo(video: HTMLVideoElement): boolean {
    if (!this.channel) return false;
    if (video.videoWidth === 0 || video.videoHeight === 0 || video.readyState < 2 /* HAVE_CURRENT_DATA */) {
      return false;
    }
    if (this.kind !== 'worker') {
      this.notify('set-video-frame', { frame: video });
      return true;
    }
    if (typeof VideoFrame === 'function') {
      const frame = new VideoFrame(video);
      this.notify('set-video-frame', { frame }, [frame]);
      return true;
    }
    void createImageBitmap(video).then((bitmap) => {
      this.notify('set-video-frame', { frame: bitmap }, [bitmap]);
    }, () => {});
    return true;
  }

  releaseVideo(): void {
    this.notify('release-video', {});
  }

  analyzeSource(url: string, useWasm: boolean): Promise<{ avgLuminance: number }> {
    return this.call('analyze-source', { url, useWasm });
  }

  clearMask(): void {
    this.notify('clear-mask', {});
  }

  /** Copied, not transferred: the sampler hands its last field out again while it is busy. */
  setMotionField(motion: CpuMotionField | null): void {
    this.notify('set-motion-field', { motion });
  }

  // ── Readbacks ─────────────────────────────────────────────────────────────

  stationaryPreviews(req: Req<'stationary-previews'>): Promise<Res<'stationary-previews'>> {
    return this.call('stationary-previews', req);
  }

  renderCells(cells: RenderCellRequest[]): void {
    this.notify('render-cells', { cells });
  }

  collisionStats(): Promise<Res<'collision-stats'>> {
    return this.call('collision-stats', {});
  }

  exportTracer(req: Req<'export-tracer'>): Promise<Res<'export-tracer'>> {
    return this.call('export-tracer', req);
  }

  exportFrame(req: ExportFrameRequest): Promise<Res<'export-frame'>> {
    return this.call('export-frame', req);
  }

  /**
   * The renderer, as offline video export sees it: frames come back by
   * readback on either transport, so the file is the same.
   */
  exportRenderer(): ExportRenderer {
    return {
      clearPersistence: () => this.notify('export-begin', {}),
      exportFrame: (state, options) => this.exportFrame({ state, options }),
      restoreRenderSize: (width, height) => this.notify('export-end', { width, height }),
    };
  }
}
