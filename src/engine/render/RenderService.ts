/**
 * The renderer behind the render protocol (#253): the orchestrator, its
 * slots, the live frame loop, source media, readbacks and exports — the one
 * implementation both transports carry (`protocol.ts`).
 *
 * On the **worker** transport it lives in `render.worker.ts`: the canvases are
 * transferred `OffscreenCanvas`es and its `FrameClock` is the worker's own,
 * paced by the worker's `requestAnimationFrame`. On the **main** transport
 * `RenderHost` runs it in-process on the page's clock, so the loop's tasks sit
 * between reactive input and WebXR exactly as they always have.
 *
 * Nothing here reads the page. What the page knows — the store, the URL, the
 * pass-graph preference, the canvas sizes — arrives in messages; what the page
 * shows — breadcrumbs, telemetry, errors — leaves as events.
 */

import { resendForwardedDiagnostics } from '../diagnostics';
import { writeLayerAngles } from '../buildRendererState';
import { effectiveLayerScaleForMultiView, isQuadCompareLayout, isTwoSlotCompareLayout } from '../compareViews';
import { createImageAnalysisRuntime, publishChoreBreadcrumbs } from '../compute/chores';
import { createWorkerChromashiftCpuHost } from '../compute/chores/analysisWorkerHost';
import type { ChoresRuntime, CpuChoreHost, CpuImageAnalysisOutput } from '../compute/chores';
import type { FrameClock, FrameTick } from '../frame/FrameClock';
import { getGpuFatalError, simulateDeviceLoss, toBootstrapRuntimeError, type GpuRuntimeError } from '../gpu/gpuErrors';
import { isOffscreenCanvas, type RenderCanvas } from '../gpu/renderCanvas';
import { activatePassGraph, presetGraphSource } from '../graph';
import { LIVE_SOURCE_CACHE_KEY, type LiveFrameSource } from '../live/liveSourceTexture';
import { advanceAngles } from '../math/rotation';
import { adoptPageSearch } from '../pageSearch';
import type { ReactiveModulation } from '../reactive/types';
import { publishRendererBootFailure, publishRendererBreadcrumbs } from '../rendererMode';
import {
  PRIMARY_SLOT_ID,
  RendererOrchestrator,
  type BootstrapRendererOrchestratorOptions,
} from '../RendererOrchestrator';
import { warmupTracerPersistence } from '../stationaryPreview';
import type { ChromashiftRenderer, ExportFrameResult } from '../types/RendererContracts';
import type { CollisionStats, RendererState } from '../types/RendererState';
import type { ChromashiftTextureHandle } from '../types/TextureHandle';
import { textureHandleSize, webGpuTextureFromHandle } from '../types/TextureHandle';
import { MAIN_VIEW_MODES } from '../viewModes';
import { computeImageAverageLuminanceWith, isWasmReady, loadWasmEngine } from '../WasmEngine';
import { releasePageGpuDevice } from '../webgpu/adapter';
import { GPU_TIMING_HISTORY_SIZE } from '../webgpu/GpuTimestampProfiler';
import { readPresentedTexture } from '../webgpu/presentedFrame';
import {
  probeFailureMessage,
  probeWebGPU,
  publishWebGpuProbe,
  recordProbeStageFailure,
  recordProbeSuccess,
  type WebGpuProbeResult,
} from '../webgpu/webgpuProbe';
import { isXrImmersiveActive } from '../xr/xrSupport';
import type { RpcHandlerContext, RpcHandlers } from '../workers/rpc';
import type {
  MotionDemand,
  PresentedFrame,
  RenderBootRequest,
  RenderBootResult,
  RenderEmit,
  RenderLoopInput,
  RenderProtocol,
  RenderSurface,
  RenderTelemetry,
  RenderTransportKind,
} from './protocol';

/** Compare slot B (dual / swipe): drawn by the live loop with its own angles. */
export const COMPARE_B_SLOT = 'compare-b';

/** Tick times kept for `__renderDebug.frameTimeline` — about four seconds at 60 Hz. */
const TIMELINE_SIZE = 256;

/** How often the loop sends angles and timings to the page (ms). */
const TELEMETRY_INTERVAL_MS = 200;

type MaskOwner = 'gpu-analysis' | 'wasm-upload';

/** Injectable for unit tests: no WebGPU, no workers. */
export interface RenderServiceDeps {
  probeWebGPU: () => Promise<WebGpuProbeResult>;
  bootstrap: (options: BootstrapRendererOrchestratorOptions) => Promise<{ orchestrator: RendererOrchestrator }>;
  /** The CPU lanes of image analysis — a nested analysis worker, inline as a fallback. */
  createCpuHost: (wasmEnabled: () => boolean) => CpuChoreHost;
  /** Decode `url` for the CPU lanes and the Original thumbnail. */
  decodeBitmap: (url: string) => Promise<ImageBitmap>;
}

async function fetchBitmap(url: string): Promise<ImageBitmap> {
  // `mode: 'cors'` is what an `<img crossOrigin="anonymous">` asks for, so the
  // corpus's CORS rules are the same as before the decode moved here.
  const response = await fetch(url, { mode: 'cors', credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Failed to load image: ${url} (HTTP ${response.status})`);
  return createImageBitmap(await response.blob());
}

/** One decode of a source, shared by every consumer whose use overlaps it. */
interface SharedDecode {
  url: string;
  bitmap: Promise<ImageBitmap>;
  users: number;
}

const defaultDeps: RenderServiceDeps = {
  probeWebGPU,
  bootstrap: (options) => RendererOrchestrator.bootstrap(options),
  createCpuHost: (wasmEnabled) => createWorkerChromashiftCpuHost(wasmEnabled),
  decodeBitmap: fetchBitmap,
};

export interface RenderServiceOptions {
  /** The clock the live loop registers on: the worker's own, or the page's. */
  clock: FrameClock;
  /**
   * The service owns `clock` (the worker). A video export then takes it
   * offline and steps it per frame; on the page the exporter steps the page's
   * clock itself.
   */
  ownsClock: boolean;
  transport: RenderTransportKind;
  emit: RenderEmit;
  deps?: Partial<RenderServiceDeps>;
}

interface PendingRead {
  resolve: (frame: PresentedFrame) => void;
  reject: (error: Error) => void;
}

interface ExportSession {
  exitOffline: () => void;
  unregister: () => void;
  /** The frame the next offline step draws, and where its pixels go. */
  pending: { state: RendererState; options: Parameters<ChromashiftRenderer['exportFrame']>[1]; result: ExportFrameResult | null } | null;
}

const CANCELLED: RenderBootResult = { ok: false, cancelled: true };

function sameBytes(a: Uint8Array | null | undefined, b: Uint8Array | null | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

export class RenderService {
  private readonly clock: FrameClock;
  private readonly ownsClock: boolean;
  private readonly transport: RenderTransportKind;
  private readonly emit: RenderEmit;
  private readonly deps: RenderServiceDeps;

  /** Bumped by every boot and shutdown; a boot that sees it move was overtaken. */
  private generation = 0;
  private orchestrator: RendererOrchestrator | null = null;
  /** Every canvas the page handed over, by id — they outlive boots (a transferred canvas cannot be sent twice). */
  private readonly canvases = new Map<number, RenderCanvas>();

  private source: ChromashiftTextureHandle | null = null;
  /** What `source` was loaded from — the GPU analysis lane reads it only for that URL. */
  private sourceUrl: string | null = null;
  private mask: GPUTexture | null = null;
  private maskOwner: MaskOwner | null = null;
  private analysis: { runtime: ChoresRuntime; device: GPUDevice | null } | null = null;
  private cpuHost: CpuChoreHost | null = null;
  private cpuHostWasm = false;

  private loop: RenderLoopInput | null = null;
  private modulation: ReactiveModulation | null = null;
  private angles: number[] = [0, 0, 0];
  private anglesB: number[] = [0, 0, 0];
  private unregisterLoop: (() => void) | null = null;
  /** The frame object the main slot draws, reused every tick (the renderer never keeps it). */
  private readonly frameMain: RendererState = { layers: [], avgLuminance: 0 };
  private readonly frameB: RendererState = { layers: [], avgLuminance: 0 };

  private lastAngleSync = 0;
  private lastMetricSync = 0;
  private frameHistory: number[] = [];
  private autoDegradeApplied = false;
  private motionDemand: MotionDemand | null = null;

  private exportSession: ExportSession | null = null;

  private readonly timeline: number[] = [];
  private readonly presentedReads = new Map<string, PendingRead[]>();
  private sharedDecode: SharedDecode | null = null;

  constructor(options: RenderServiceOptions) {
    this.clock = options.clock;
    this.ownsClock = options.ownsClock;
    this.transport = options.transport;
    this.emit = options.emit;
    this.deps = { ...defaultDeps, ...options.deps };
  }

  /** The angles the loop drew last, exact — the main transport's `currentAngles()`. */
  currentAngles(): readonly number[] {
    return this.angles;
  }

  /** The protocol's handlers, for `exposeWorkerRpc` or an in-process host. */
  handlers(): RpcHandlers<RenderProtocol> {
    return {
      boot: (req) => this.boot(req),
      shutdown: () => this.shutdown(),
      attach: ({ slot, surface }) => this.attach(slot, surface),
      detach: ({ slot }) => { this.orchestrator?.destroySlot(slot); },
      resize: ({ surfaces }) => this.resize(surfaces),
      'release-canvas': ({ canvasId }) => { this.canvases.delete(canvasId); },

      'set-loop': (input) => this.setLoop(input),
      'set-modulation': ({ modulation }) => { this.modulation = modulation; },
      'set-angles': ({ angles }) => { this.angles = [...angles]; },
      'get-angles': () => [...this.angles],

      'set-antialiasing': ({ enabled }) => { this.primary()?.setAntialiasing(enabled); },
      'set-canvas': ({ colorSpace, canvasHdr }) => {
        if (colorSpace !== undefined) this.orchestrator?.setCanvasColorSpace(colorSpace);
        if (canvasHdr !== undefined) this.orchestrator?.setCanvasPresentation(canvasHdr ? 'hdr-extended' : 'sdr');
      },
      'clear-persistence': ({ slots }) => {
        this.primary()?.clearPersistence();
        for (const slot of slots ?? []) this.orchestrator?.getSlot(slot)?.renderer.clearPersistence();
      },

      'load-source': (req, ctx) => this.loadSource(req, ctx),
      'upload-pixels': ({ key, pixels, width, height }) => {
        const textures = this.orchestrator?.textureManagerRef();
        if (!textures) throw new Error('The renderer is not running.');
        this.setSource(textures.uploadPixels(key, pixels, width, height));
      },
      'set-video-frame': ({ frame }) => this.setVideoFrame(frame),
      'release-video': () => { this.orchestrator?.textureManagerRef()?.releaseVideoTexture(LIVE_SOURCE_CACHE_KEY); },
      'analyze-source': (req) => this.analyzeSource(req.url, req.useWasm),
      'clear-mask': () => this.clearMask(),
      'set-motion-field': ({ motion }) => { this.primary()?.setMotionField?.(motion); },

      'stationary-previews': async ({ state, options }, ctx) => {
        const renderer = this.requirePrimary();
        const result = await renderer.renderStationaryPreviews(state, options);
        if (result.separated) ctx.transfer(result.separated.buffer);
        if (result.tracer) ctx.transfer(result.tracer.buffer);
        return result;
      },
      'render-cells': ({ cells }) => {
        for (const cell of cells) {
          const renderer = this.orchestrator?.getSlot(cell.slot)?.renderer;
          if (!renderer) continue;
          if (cell.warmup) warmupTracerPersistence(renderer, cell.warmup, cell.fps);
          renderer.render(cell.state, cell.fps);
          this.afterRender(cell.slot);
        }
      },
      'collision-stats': () => this.collisionStats(),
      'export-tracer': async (options, ctx) => {
        const result = await this.requirePrimary().exportTracerView(options);
        if (result) ctx.transfer(result.data.buffer);
        return result;
      },
      'export-frame': async (req, ctx) => {
        if (req.liveAngles) writeLayerAngles(req.state, this.angles);
        const result = await this.exportFrame(req.state, req.options);
        if (result) ctx.transfer(result.data.buffer);
        return result;
      },
      'export-begin': () => this.exportBegin(),
      'export-end': ({ width, height }) => this.exportEnd(width, height),

      'debug-presented-frame': ({ slot }, ctx) => this.readPresentedFrame(slot, ctx),
      'debug-lose-device': () => {
        const device = this.orchestrator?.sharedDevice();
        if (!device) throw new Error('There is no WebGPU device to lose.');
        simulateDeviceLoss(device, 'renderDebug: simulated driver reset');
      },
      'debug-frame-timeline': () => [...this.timeline],
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  private async boot(req: RenderBootRequest): Promise<RenderBootResult> {
    const generation = ++this.generation;
    this.teardown();
    if (this.transport === 'worker') adoptPageSearch(req.pageSearch);
    // A spec may have cleared a breadcrumb on the page since the last boot.
    resendForwardedDiagnostics();
    if (req.retry) releasePageGpuDevice();
    const canvas = this.adoptCanvas(req.surface);

    const fatal = getGpuFatalError();
    if (fatal) return { ok: false, error: fatal };

    const cancelled = () => generation !== this.generation;
    const onRuntimeError = (error: GpuRuntimeError) => this.reportRuntimeError(generation, error);
    let orchestrator: RendererOrchestrator;

    if (req.backend === 'webgl') {
      // Explicit diagnostic / XR / screenshot session: never request a WebGPU
      // adapter or device, so gpu-chores cannot adopt a leftover GPUDevice.
      if (isOffscreenCanvas(canvas)) throw new Error('The WebGL backend draws a page canvas, on the main transport.');
      try {
        ({ orchestrator } = await this.deps.bootstrap({
          primaryCanvas: canvas,
          antialias: req.antialias,
          backend: 'webgl',
          onRuntimeError,
          // Not gated on this boot's generation: a Retry pressed while the
          // context was still lost overtook it, and the restore must land.
          onContextRestored: () => this.emit('context-restored', {}),
        }));
      } catch (error) {
        if (cancelled()) return CANCELLED;
        publishRendererBootFailure(error instanceof Error ? error.message : String(error));
        return { ok: false, error: getGpuFatalError() ?? toBootstrapRuntimeError(error) };
      }
      if (cancelled()) {
        orchestrator.destroy();
        return CANCELLED;
      }
    } else {
      // WebGPU is required. Pre-flight before touching the orchestrator so an
      // unsupported browser gets a blocking screen with adapter/browser detail
      // rather than a silent WebGL slide.
      const probe = await this.deps.probeWebGPU();
      publishWebGpuProbe(probe);
      if (cancelled()) return CANCELLED;
      if (!probe.ok) {
        const { message, detail } = probeFailureMessage(probe);
        console.error(`[Chromashift:GPU] ${message} ${detail}`, probe);
        publishRendererBootFailure(detail);
        // Not recoverable by retry: the browser/device cannot run this app.
        return { ok: false, error: { kind: 'bootstrap', message, detail, recoverable: false } };
      }
      try {
        ({ orchestrator } = await this.deps.bootstrap({
          primaryCanvas: canvas,
          antialias: req.antialias,
          backend: 'webgpu',
          onRuntimeError,
          canvasOptions: { readback: req.debug },
        }));
      } catch (error) {
        if (cancelled()) return CANCELLED;
        // The adapter was fine but device/context/pipeline creation failed —
        // the Chrome-vs-Edge case. Record which stage died, then hard-fail.
        const reason = error instanceof Error ? error.message : String(error);
        const failed = recordProbeStageFailure(probe, 'device', reason);
        const { message, detail } = probeFailureMessage(failed);
        console.error(`[Chromashift:GPU] ${message} ${detail}`, failed);
        publishRendererBootFailure(detail);
        return { ok: false, error: getGpuFatalError() ?? toBootstrapRuntimeError(error) };
      }
      if (cancelled()) {
        orchestrator.destroy();
        return CANCELLED;
      }
      recordProbeSuccess(probe);
    }

    this.orchestrator = orchestrator;
    const backend = orchestrator.getBackend();
    const fallbackReason = orchestrator.getFallbackReason();
    publishRendererBreadcrumbs(backend, fallbackReason);
    // Pass-graph gate: the page chose the shape (`?graph=`, the stored
    // preference); compile it for this backend, publish the breadcrumbs, and
    // hand the source to every slot. See docs/PASS_GRAPH.md.
    activatePassGraph(backend, undefined, { name: req.passGraph });
    orchestrator.setPassGraph(presetGraphSource(req.passGraph));
    orchestrator.setCanvasColorSpace(req.colorSpace);
    if (req.canvasHdr) orchestrator.setCanvasPresentation('hdr-extended');
    this.motionDemand = null;
    this.publishMotionDemand();
    this.syncLoop();
    return { ok: true, backend, fallbackReason };
  }

  private shutdown(): void {
    this.generation += 1;
    this.teardown();
  }

  /** Drop the renderer. The page's canvases and the device lease stay. */
  private teardown(): void {
    this.endExport();
    this.stopLoop();
    this.rejectPresentedReads('the renderer was torn down');
    if (this.maskOwner === 'wasm-upload') this.mask?.destroy();
    this.mask = null;
    this.maskOwner = null;
    this.source = null;
    this.sourceUrl = null;
    this.analysis = null;
    this.orchestrator?.destroy();
    this.orchestrator = null;
  }

  private reportRuntimeError(generation: number, error: GpuRuntimeError): void {
    // A replaced renderer's errors are its successor's business now.
    if (generation !== this.generation) return;
    if (error.kind === 'device-lost') {
      // The orchestrator destroyed itself; everything on the device is gone.
      this.orchestrator = null;
      this.teardown();
    }
    this.emit('runtime-error', error);
  }

  /** The canvas `surface` names: adopted the first time it rides along, looked up after. */
  private adoptCanvas(surface: RenderSurface): RenderCanvas {
    if (surface.canvas) this.canvases.set(surface.canvasId, surface.canvas);
    const canvas = this.canvases.get(surface.canvasId);
    if (!canvas) throw new Error(`Canvas ${surface.canvasId} was never handed to the renderer.`);
    this.sizeCanvas(canvas, surface.width, surface.height);
    return canvas;
  }

  /** An `OffscreenCanvas` is sized here; a page canvas (main transport) was sized by the page. */
  private sizeCanvas(canvas: RenderCanvas, width: number, height: number): boolean {
    if (!isOffscreenCanvas(canvas) || width <= 0 || height <= 0) return false;
    if (canvas.width === width && canvas.height === height) return false;
    canvas.width = width;
    canvas.height = height;
    return true;
  }

  private attach(slot: string, surface: RenderSurface): void {
    const canvas = this.adoptCanvas(surface);
    const orchestrator = this.orchestrator;
    if (!orchestrator) return;
    orchestrator.destroySlot(slot);
    const created = orchestrator.createSlot(slot, canvas);
    if (this.source) created.renderer.setTexture(this.source);
    if (this.mask) created.renderer.setClassificationMaskTexture(this.mask);
    if (slot === COMPARE_B_SLOT) this.anglesB = [...this.angles];
  }

  private resize(surfaces: { canvasId: number; width: number; height: number }[]): void {
    for (const { canvasId, width, height } of surfaces) {
      const canvas = this.canvases.get(canvasId);
      if (canvas) this.sizeCanvas(canvas, width, height);
    }
    // Reconfigured before the next frame, never racing a `getCurrentTexture`.
    this.orchestrator?.resizeAll();
  }

  private primary(): ChromashiftRenderer | null {
    return this.orchestrator?.getSlot(PRIMARY_SLOT_ID)?.renderer ?? null;
  }

  private requirePrimary(): ChromashiftRenderer {
    const renderer = this.primary();
    if (!renderer) throw new Error('The renderer is not running.');
    return renderer;
  }

  // ── The live loop ─────────────────────────────────────────────────────────

  private setLoop(input: RenderLoopInput): void {
    const previous = this.loop;
    // Keep the profile LUT's identity when its bytes did not change: the
    // renderer re-uploads on a new array, and every post is a new array.
    const lut = previous?.main.colorProfileLut;
    if (lut && sameBytes(lut, input.main.colorProfileLut)) input.main.colorProfileLut = lut;
    const lutB = previous?.compareB?.state.colorProfileLut;
    if (lutB && input.compareB && sameBytes(lutB, input.compareB.state.colorProfileLut)) {
      input.compareB.state.colorProfileLut = lutB;
    }
    if (previous && previous.hud.autoDegrade !== input.hud.autoDegrade) this.autoDegradeApplied = false;
    if (!input.hud.enabled) this.frameHistory = [];
    this.loop = input;
    this.syncLoop();
  }

  /** The loop runs while the page asks for frames and a renderer exists; it is off the clock otherwise. */
  private syncLoop(): void {
    const want = this.loop?.running === true && this.orchestrator !== null;
    if (want && !this.unregisterLoop) this.startLoop();
    else if (!want) this.stopLoop();
  }

  private stopLoop(): void {
    this.unregisterLoop?.();
    this.unregisterLoop = null;
  }

  private startLoop(): void {
    const clock = this.clock;
    // What `modulate` decided for this tick, for `render` and `telemetry`.
    let last: number | null = null;
    let due = false;
    let mod: ReactiveModulation | null = null;

    // modulate: is a frame due at the session fps, and where are the layers?
    const unregisterModulate = clock.register('modulate', ({ now }: FrameTick) => {
      due = false;
      const loop = this.loop;
      if (!loop) return;
      this.recordTick(now);
      const msPerFrame = 1000 / loop.fps;
      // The first tick renders: `now - (now - msPerFrame)` can round to a hair
      // under a frame, so compute it rather than seeding `last` with it.
      const delta = last === null ? msPerFrame : now - last;
      if (delta < msPerFrame) return;
      last = now - (delta % msPerFrame);
      due = true;
      // Posted by the page's `sources` phase (or written in-process), so it is this tick's.
      mod = loop.reactive ? this.modulation : null;
      this.angles = advanceAngles(this.angles, mod?.extensions ?? loop.extensions, loop.fps);
    }, 'animation-angles');

    const unregisterRender = clock.register('render', () => {
      if (due) this.renderFrame(mod);
    }, 'main-render');

    const unregisterTelemetry = clock.register('telemetry', ({ now }: FrameTick) => {
      if (due) this.publishTelemetry(now);
    }, 'render-telemetry');

    this.unregisterLoop = () => {
      unregisterModulate();
      unregisterRender();
      unregisterTelemetry();
    };
  }

  private recordTick(now: number): void {
    // Epoch ms, so a spec can line them up with page-side timestamps.
    this.timeline.push(performance.timeOrigin + now);
    if (this.timeline.length > TIMELINE_SIZE) this.timeline.shift();
  }

  private renderFrame(mod: ReactiveModulation | null): void {
    const loop = this.loop;
    const orchestrator = this.orchestrator;
    if (!loop || !orchestrator) return;
    const compareB = orchestrator.getSlot(COMPARE_B_SLOT);
    const layout = loop.layout;
    const twoSlotActive = isTwoSlotCompareLayout(layout) && compareB !== undefined;
    const quadActive = isQuadCompareLayout(layout);

    const frame = this.frameMain;
    const layers = frame.layers;
    Object.assign(frame, loop.main);
    frame.layers = layers;
    writeLayerAngles(frame, this.angles);
    if (mod) {
      frame.tracerAboveIntensity = mod.tracerAboveIntensity;
      frame.tracerBelowIntensity = mod.tracerBelowIntensity;
      frame.avgLuminance = mod.avgLuminance;
    }
    if (twoSlotActive || quadActive) {
      frame.layerScale = effectiveLayerScaleForMultiView(loop.main.layerScale ?? 1, layout).scale;
      frame.tracerScale = effectiveLayerScaleForMultiView(loop.main.tracerScale ?? 1, layout).scale;
    }
    if (quadActive) {
      frame.mainViewMode = MAIN_VIEW_MODES.PROCESSED_COMPOSITE;
      frame.showTracerView = false;
      frame.livePreviewEnabled = false;
      frame.profilePerformance = false;
    }
    // While immersive, the headset is the output: WebXR registers its own render task.
    if (isXrImmersiveActive()) return;

    orchestrator.reconfigureIfNeeded();
    orchestrator.getSlot(PRIMARY_SLOT_ID)?.renderer.render(frame);
    this.afterRender(PRIMARY_SLOT_ID);

    if (twoSlotActive && compareB && loop.compareB) {
      const b = loop.compareB;
      const anglesB = b.syncPlay
        ? this.angles
        : (this.anglesB = advanceAngles(this.anglesB, b.extensions, b.fps));
      const frameB = this.frameB;
      const layersB = frameB.layers;
      Object.assign(frameB, b.state);
      frameB.layers = layersB;
      writeLayerAngles(frameB, anglesB);
      compareB.renderer.render(frameB);
      this.afterRender(COMPARE_B_SLOT);
    }
    this.publishMotionDemand();
  }

  private publishTelemetry(now: number): void {
    const loop = this.loop;
    if (!loop) return;
    const telemetry: RenderTelemetry = {};
    let any = false;
    if (now - this.lastAngleSync > TELEMETRY_INTERVAL_MS) {
      this.lastAngleSync = now;
      telemetry.angles = [...this.angles];
      any = true;
    }
    if (now - this.lastMetricSync > TELEMETRY_INTERVAL_MS) {
      this.lastMetricSync = now;
      const renderer = this.primary();
      const timing = renderer?.getRenderTiming();
      if (renderer && timing) {
        any = true;
        telemetry.cpu = { last: timing.lastCpuMs, avg: timing.averageCpuMs };
        telemetry.gpu = timing.gpu;
        if (loop.hud.enabled) {
          const frameMs = Math.max(timing.lastCpuMs, timing.gpu.last?.totalGpuMs ?? 0);
          this.frameHistory.push(frameMs);
          if (this.frameHistory.length > GPU_TIMING_HISTORY_SIZE) this.frameHistory.shift();
          telemetry.frameHistory = [...this.frameHistory];
          const overBudget = frameMs > 1000 / loop.fps;
          telemetry.overBudget = overBudget;
          if (overBudget && loop.hud.autoDegrade && !this.autoDegradeApplied) {
            this.autoDegradeApplied = true;
            renderer.setAntialiasing(false);
            this.emit('perf-degrade', {});
          }
        }
      }
    }
    if (any) this.emit('telemetry', telemetry);
  }

  /** Tell the page when the CPU motion-field lane's inputs change (the live source samples for it). */
  private publishMotionDemand(): void {
    const renderer = this.primary();
    if (!renderer) return;
    const wantsCpu = Boolean(renderer.setMotionField) && (renderer.wantsCpuMotionField?.() ?? true);
    const use = renderer.cpuMotionFieldUse?.() ?? { reads: false, needsFlow: false };
    const previous = this.motionDemand;
    if (previous && previous.wantsCpu === wantsCpu
      && previous.use.reads === use.reads && previous.use.needsFlow === use.needsFlow) return;
    this.motionDemand = { wantsCpu, use: { ...use } };
    this.emit('motion-demand', this.motionDemand);
  }

  // ── Media ─────────────────────────────────────────────────────────────────

  /** Route a source texture to every slot, and keep it for slots attached later. */
  private setSource(handle: ChromashiftTextureHandle, url: string | null = null): void {
    this.source = handle;
    this.sourceUrl = url;
    for (const slot of this.orchestrator?.listSlots() ?? []) slot.renderer.setTexture(handle);
  }

  private async loadSource(
    req: { url: string; keep: string[]; preview?: { width: number; height: number } },
    ctx: RpcHandlerContext<never>,
  ) {
    const textures = this.orchestrator?.textureManagerRef();
    if (!textures) throw new Error('The renderer is not running.');
    const generation = this.generation;
    const handle = await textures.loadTexture(req.url);
    if (generation !== this.generation) throw new Error('The renderer restarted while the source loaded.');
    this.setSource(handle, req.url);
    textures.evictExcept(req.keep);
    let preview: ImageBitmap | null = null;
    const size = req.preview;
    if (size) {
      try {
        preview = await this.withDecodedSource(req.url, (image) => createImageBitmap(image, {
          resizeWidth: size.width,
          resizeHeight: size.height,
          resizeQuality: 'high',
        }));
        ctx.transfer(preview);
      } catch (error) {
        console.warn('Failed to decode the Original thumbnail:', req.url, error);
      }
    }
    return { ...textureHandleSize(handle), preview };
  }

  /**
   * Run `consume` on `url` decoded, sharing the decode with every other use that
   * overlaps it — a load's thumbnail and the analyses that follow it (on a
   * busy thread each fetch-and-decode is several turns of the event loop).
   * The bitmap is closed when the last overlapping use finishes, so a session
   * holds no decoded copy of its source between loads.
   */
  private async withDecodedSource<T>(url: string, consume: (image: ImageBitmap) => Promise<T> | T): Promise<T> {
    let entry = this.sharedDecode;
    if (!entry || entry.url !== url) {
      entry = { url, bitmap: this.deps.decodeBitmap(url), users: 0 };
      this.sharedDecode = entry;
    }
    entry.users += 1;
    const decoded = entry;
    try {
      return await consume(await decoded.bitmap);
    } finally {
      decoded.users -= 1;
      if (decoded.users === 0) {
        if (this.sharedDecode === decoded) this.sharedDecode = null;
        decoded.bitmap.then((bitmap) => bitmap.close(), () => {});
      }
    }
  }

  private setVideoFrame(frame: LiveFrameSource): void {
    try {
      const handle = this.orchestrator?.textureManagerRef()?.updateVideoTexture(LIVE_SOURCE_CACHE_KEY, frame);
      if (handle) this.setSource(handle, LIVE_SOURCE_CACHE_KEY);
    } finally {
      // A frame posted to the worker is the service's to close; the page's own element is not.
      if ('close' in frame) frame.close();
    }
  }

  private clearMask(): void {
    for (const slot of this.orchestrator?.listSlots() ?? []) slot.renderer.setClassificationMaskTexture(null);
    if (this.maskOwner === 'wasm-upload') this.mask?.destroy();
    this.mask = null;
    this.maskOwner = null;
  }

  private bindMask(texture: GPUTexture, owner: MaskOwner): void {
    if (this.maskOwner === 'wasm-upload' && this.mask && this.mask !== texture) this.mask.destroy();
    this.mask = texture;
    this.maskOwner = owner;
    for (const slot of this.orchestrator?.listSlots() ?? []) slot.renderer.setClassificationMaskTexture(texture);
  }

  private getCpuHost(useWasm: boolean): CpuChoreHost {
    this.cpuHostWasm = useWasm;
    this.cpuHost ??= this.deps.createCpuHost(() => this.cpuHostWasm);
    return this.cpuHost;
  }

  /**
   * The chores runtime, rebuilt only when the device changes. Its `webgpu`
   * lane wraps the orchestrator's own `GpuImageAnalysis`, so pipelines and
   * the reused mask texture stay shared and no second device is requested;
   * a WebGL session registers no GPU lane at all.
   */
  private analysisRuntime(useWasm: boolean): ChoresRuntime {
    const orchestrator = this.orchestrator;
    const device = orchestrator?.getBackend() === 'webgpu' ? orchestrator.sharedDevice() : null;
    const cached = this.analysis;
    if (cached && cached.device === device) return cached.runtime;
    const gpuLane = device ? orchestrator?.gpuImageAnalysisRef()?.backend ?? null : null;
    const runtime = createImageAnalysisRuntime({ gpuBackend: gpuLane, cpuHost: this.getCpuHost(useWasm) });
    this.analysis = { runtime, device };
    return runtime;
  }

  /** Average luminance from the CPU host alone: WebGL, or every analysis lane declined. */
  private async averageLuminanceOnly(image: ImageBitmap, useWasm: boolean): Promise<number> {
    const host = this.getCpuHost(useWasm);
    const wasm = host.isWasmReady();
    const { avgLuminance, mode } = await host.computeAverageLuminance(image, wasm);
    publishChoreBreadcrumbs(`${wasm ? 'wasm' : 'ts'}-${mode}`, null);
    return avgLuminance;
  }

  private uploadCpuMask(device: GPUDevice, output: CpuImageAnalysisOutput): void {
    const texture = device.createTexture({
      size: [output.width, output.height, 1],
      format: 'r8uint',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const bytes = new Uint8Array(output.mask.byteLength);
    bytes.set(output.mask);
    device.queue.writeTexture(
      { texture },
      bytes,
      { bytesPerRow: output.width, rowsPerImage: output.height },
      [output.width, output.height, 1],
    );
    this.bindMask(texture, 'wasm-upload');
  }

  /**
   * Classification mask + average luminance for the current source. `auto`
   * walks webgpu → wasm → ts, recording why each lane declined; with no lane
   * left (or no WebGPU device) the mask is cleared and only the luminance is
   * computed. The CPU lanes read a bitmap decoded here, off the page.
   */
  private async analyzeSource(url: string, useWasm: boolean): Promise<{ avgLuminance: number }> {
    // The CPU lanes run WASM in this realm only if it is loaded here too.
    if (useWasm && !isWasmReady()) await loadWasmEngine();
    return this.withDecodedSource(url, async (image) => {
      const orchestrator = this.orchestrator;
      const device = orchestrator?.getBackend() === 'webgpu' ? orchestrator.sharedDevice() : null;
      if (!device) {
        this.clearMask();
        return { avgLuminance: await this.averageLuminanceOnly(image, useWasm) };
      }
      try {
        const shown = this.sourceUrl === url && image.width > 0 && image.height > 0;
        const source = shown ? webGpuTextureFromHandle(this.source) : null;
        const result = await this.analysisRuntime(useWasm).runJob({
          op: 'image-analysis',
          source,
          image,
          width: image.width,
          height: image.height,
          prefer: 'auto',
        });
        if (result.ok) {
          if (result.value.kind === 'gpu-texture') this.bindMask(result.value.maskTexture, 'gpu-analysis');
          else this.uploadCpuMask(device, result.value);
          return { avgLuminance: result.value.avgLuminance };
        }
        console.warn('Classification mask unavailable:', result.reason);
        this.clearMask();
        return { avgLuminance: await this.averageLuminanceOnly(image, useWasm) };
      } catch (error) {
        console.warn('Could not generate classification mask:', error);
        this.clearMask();
        return { avgLuminance: computeImageAverageLuminanceWith(image, useWasm) };
      }
    });
  }

  // ── Readbacks and export ──────────────────────────────────────────────────

  private collisionStats() {
    const renderer = this.primary();
    // A WebGL pixel-pack map drains every pass still queued on the context;
    // the live collision poll stays on the WebGPU readback path.
    if (!renderer || renderer.backend === 'webgl') return null;
    return new Promise<CollisionStats | null>((resolve) => {
      if (!renderer.requestCollisionStats(resolve)) resolve(null);
    });
  }

  private exportBegin(): void {
    this.primary()?.clearPersistence();
    if (!this.ownsClock || this.exportSession) return;
    // The worker's clock goes offline like the page's: each export frame is
    // one step, running the same phases in the same order as a live frame.
    const exitOffline = this.clock.enterOffline(performance.now());
    const session: ExportSession = { exitOffline, unregister: () => {}, pending: null };
    session.unregister = this.clock.register('render', async () => {
      const pending = session.pending;
      const renderer = this.primary();
      if (pending && renderer) pending.result = await renderer.exportFrame(pending.state, pending.options);
    }, 'video-export');
    this.exportSession = session;
  }

  private async exportFrame(
    state: RendererState,
    options: Parameters<ChromashiftRenderer['exportFrame']>[1],
  ): Promise<ExportFrameResult | null> {
    const session = this.exportSession;
    if (!session) return this.requirePrimary().exportFrame(state, options);
    session.pending = { state, options, result: null };
    try {
      await this.clock.step(1000 / (options.fps ?? 30));
      return session.pending.result;
    } finally {
      session.pending = null;
    }
  }

  private exportEnd(width: number, height: number): void {
    this.primary()?.restoreRenderSize(width, height);
    this.endExport();
  }

  private endExport(): void {
    const session = this.exportSession;
    this.exportSession = null;
    session?.unregister();
    session?.exitOffline();
  }

  // ── Debug ─────────────────────────────────────────────────────────────────

  private readPresentedFrame(slot: string, ctx: RpcHandlerContext<never>): Promise<PresentedFrame> {
    if (!this.orchestrator?.getSlot(slot)) return Promise.reject(new Error(`No "${slot}" slot is drawing.`));
    return new Promise<PresentedFrame>((resolve, reject) => {
      const reads = this.presentedReads.get(slot) ?? [];
      reads.push({
        resolve: (frame) => {
          ctx.transfer(frame.bytes);
          resolve(frame);
        },
        reject,
      });
      this.presentedReads.set(slot, reads);
    });
  }

  /** The texture a slot just drew is still current: copy it out for any waiting read. */
  private afterRender(slot: string): void {
    const reads = this.presentedReads.get(slot);
    if (!reads || reads.length === 0) return;
    this.presentedReads.delete(slot);
    const device = this.orchestrator?.sharedDevice();
    const context = this.orchestrator?.getSlot(slot)?.webgpuContext;
    if (!device || !context) {
      for (const read of reads) read.reject(new Error('The slot has no WebGPU canvas to read.'));
      return;
    }
    let texture: GPUTexture;
    try {
      texture = context.getCurrentTexture();
    } catch (error) {
      for (const read of reads) read.reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    void readPresentedTexture(device, texture).then(
      (frame) => {
        const [first, ...rest] = reads;
        // Each waiter gets its own bytes; the first one's go out by transfer.
        for (const read of rest) read.resolve({ ...frame, bytes: frame.bytes.slice(0) });
        first?.resolve(frame);
      },
      (error: unknown) => {
        for (const read of reads) read.reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  }

  private rejectPresentedReads(reason: string): void {
    for (const reads of this.presentedReads.values()) {
      for (const read of reads) read.reject(new Error(reason));
    }
    this.presentedReads.clear();
  }
}
