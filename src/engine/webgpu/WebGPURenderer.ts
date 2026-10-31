import {
  DEFAULT_LAYER_COUNT,
  MAX_LAYER_COUNT,
  compileGraph,
  graphVariantKey,
  passGraphRefusal,
  presetGraphSource,
  publishGraphExecutorBreadcrumbs,
  publishGraphVariant,
  publishSlotExecuting,
  type GraphPresetName,
  type GraphVariant,
  type PassGraphSource,
} from '../graph';
import { WebGpuGraphExecutor, type GraphOutputTextures } from '../graph/exec/WebGpuGraphExecutor';
import { buildEncodePlan, motionFieldUse, type MotionFieldUse } from '../graph/exec/plan';
import type { CompiledGraph } from '../graph/types';
import { WebGPUPipelines } from './WebGPUPipelines';
import { MAIN_VIEW_MODES } from '../viewModes';
import type { LayerTextures } from './bindGroups';
import { MotionFieldPass } from './MotionFieldPass';
import { MOTION_FIELD_DIVISOR, MOTION_MODE_DIRECTION } from '../motionModes';
import { TracerInspectPass } from './TracerInspectPass';
import { compositorUniforms, rendererStateValue, tracerInspectSettings } from '../graph/exec/uniforms';
import { GpuReadback } from './GpuReadback';
import { pipelineRuntimeError, type GpuRuntimeError } from '../gpu/gpuErrors';
import { GpuTimestampProfiler, publishGpuTimestampBreadcrumbs } from './GpuTimestampProfiler';
import { StationaryPreviewRenderer } from './StationaryPreviewRenderer';
import type { StationaryPreviewOptions, StationaryPreviewResult } from '../stationaryPreview';
import type { CpuMotionField, ExportFrameOptions, ExportFrameResult, ExportPassMode, ExportTracerOptions, ExportTracerResult, GpuRenderTiming, PassGraphSlotOptions, RenderTiming } from '../types/RendererContracts';
import { EMPTY_GPU_RENDER_TIMING } from '../types/RendererContracts';
import type { CollisionStats, RendererState } from '../types/RendererState';
import type { ChromashiftTextureHandle } from '../types/TextureHandle';
import { ProfileLutTexture } from '../color/ProfileLutTexture';
import {
  HDR_CANVAS_FORMAT,
  type CanvasPresentation,
  canvasHdrInternalNote,
  internalColorFormatBytesPerPixel,
  selectInternalColorFormat,
} from '../gpu/gpuOptions';
import { publishDiagnostic } from '../diagnostics';
import type { PresentationTarget } from './presentationTarget';

/**
 * WebGPURenderer — one canvas's WebGPU frame, drawn by the pass-graph
 * executor (docs/PASS_GRAPH.md). Every frame is a variant of the session's
 * graph source; the inspect views, readbacks and exports read that graph's
 * named outputs.
 */

/** A frame whose graph reads no motion field and solves no flow. */
const NO_MOTION_FIELD_USE: MotionFieldUse = { reads: false, needsFlow: false };

/**
 * What a slot draws until the orchestrator hands it the session's source, and
 * what a selected shape draws at a variant it refuses: there is no hand
 * encoder to fall back to any more.
 */
const DEFAULT_GRAPH_SOURCE = presetGraphSource('default');

/**
 * The main view an export pass mode draws: `composite` the processed
 * composite, `tracers` the full-res tracer view, and `layers` whatever view
 * the session shows, with its tracers zeroed by the caller.
 */
function exportMainView(passMode: ExportPassMode, state: RendererState): number {
  if (passMode === 'tracers') return MAIN_VIEW_MODES.FULL_RES_TRACER;
  if (passMode === 'layers') return rendererStateValue(state, 'mainViewMode');
  return MAIN_VIEW_MODES.PROCESSED_COMPOSITE;
}

/** One layer count × presentation's inspect passes. */
interface InspectPassEntry {
  /** `null` while the device compiles them, and for good if it refused them. */
  pass: TracerInspectPass | null;
  /** Settles once compiled (the passes) or refused (`null`). */
  ready: Promise<TracerInspectPass | null>;
}

/** Clear `view` to opaque black: a frame with nothing validated to draw it. */
function encodeClear(enc: GPUCommandEncoder, view: GPUTextureView): void {
  enc.beginRenderPass({
    colorAttachments: [{
      view,
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
    }],
  }).end();
}

/** A compiled variant and where it came from, for the breadcrumbs. */
interface VariantOrigin {
  /** The shape it is a variant of — the session's, or `default` standing in for it. */
  readonly name: GraphPresetName;
  readonly key: string;
}

export class WebGPURenderer {
  readonly backend = 'webgpu' as const;
  static readonly DIAGNOSTIC_SIZE = GpuReadback.DIAGNOSTIC_SIZE;

  private device         : GPUDevice;
  /** The canvas's context, or an offscreen target (`presentationTarget.ts`). */
  private context        : PresentationTarget;
  private internalFormat : GPUTextureFormat;
  /** The SDR canvas format's inspect/readback layouts at the canonical layer count. */
  public pipelines: WebGPUPipelines;
  /** Band-layer sampler (mipmapped, as the layer passes have always sampled). */
  public sampler        : GPUSampler;
  private sampleCount    : number = 4;

  private currentTexture : GPUTexture | null = null;
  private classificationMaskTexture: GPUTexture | null = null;
  private fallbackMaskTexture: GPUTexture;
  private readonly profileLut: ProfileLutTexture;

  private readonly motionField: MotionFieldPass;
  /**
   * Set whenever the source texture *object* changes (a new image, a live
   * frame at a new resolution). A live source re-uploads into the same texture
   * every tick, so identity — not the `setTexture` call itself — is what tells
   * a genuinely new source apart from the next frame of the current one.
   */
  private motionResetPending = true;
  /** Inspect passes by `layerCount:presentation`, built on first use. */
  /** Inspect passes per layer count × presentation: compiling, compiled, or refused. */
  private readonly inspectPassSets = new Map<string, InspectPassEntry>();
  /** Where a refused pipeline is reported — the orchestrator's error overlay. */
  private runtimeErrorHandler: ((error: GpuRuntimeError) => void) | null = null;
  /** Whether this frame ran the motion chore, so `afterSubmit` maps its stats only then. */
  private motionFieldEncoded = false;
  /** `motionFieldUse` per compiled graph — asked every frame, computed once. */
  private readonly fieldUseByGraph = new WeakMap<CompiledGraph, MotionFieldUse>();
  /** Whether the last frame presented HDR, so the breadcrumb only moves on a change. */
  private presentedHdr = false;
  private readonly readback: GpuReadback;
  private readonly gpuProfiler: GpuTimestampProfiler | null;
  /** Sampler for every pass that reads a band layer or an accumulator. */
  private readonly compositorSampler: GPUSampler;
  private readonly stationaryPreview: StationaryPreviewRenderer;

  private lastRenderCpuMs = 0;
  private averageRenderCpuMs = 0;

  /** The pass-graph executor (docs/PASS_GRAPH.md): it encodes every frame. */
  private readonly graphExecutor: WebGpuGraphExecutor;
  private graphSource: PassGraphSource = DEFAULT_GRAPH_SOURCE;
  /**
   * The source's variants compiled so far, by `graphVariantKey` — or, for one
   * that will not compile, encode or validate, the refusal it produced.
   * Remembered either way, so a frame never compiles twice and a refused
   * variant is not retried every frame.
   */
  private readonly graphVariants = new Map<string, CompiledGraph | string>();
  /** The default graph's variants, standing in for ones the source refused. */
  private readonly defaultVariants = new Map<string, CompiledGraph | string>();
  private readonly variantOrigins = new WeakMap<CompiledGraph, VariantOrigin>();
  /** The variant the executor targets right now. */
  private adoptedGraph: CompiledGraph | null = null;
  /** What the last frame drew (`null`: a cleared frame), `undefined` until published. */
  private drawnGraph: CompiledGraph | null | undefined = undefined;
  /** The orchestrator slot this renderer draws, and whether it is the primary canvas. */
  private graphSlot = 'main';
  private graphPrimary = true;
  private destroyed = false;

  constructor(device: GPUDevice, context: PresentationTarget, format: GPUTextureFormat, enableMSAA = false) {
    this.device  = device;
    this.context = context;
    this.internalFormat = selectInternalColorFormat(device);
    this.sampleCount = enableMSAA ? 4 : 1;
    this.pipelines = new WebGPUPipelines(device, format);

    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    this.compositorSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    this.fallbackMaskTexture = device.createTexture({
      size: [1, 1, 1],
      format: 'r8uint',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: this.fallbackMaskTexture },
      new Uint8Array([0]),
      { bytesPerRow: 1, rowsPerImage: 1 },
      [1, 1, 1],
    );

    this.profileLut = new ProfileLutTexture(device);
    this.motionField = new MotionFieldPass(device);
    this.readback = new GpuReadback(device, format, this.pipelines);
    this.graphExecutor = new WebGpuGraphExecutor(
      device,
      this.internalFormat,
      format,
      this.sampler,
      this.compositorSampler,
    );
    this.graphExecutor.setSampleCount(this.sampleCount);
    this.stationaryPreview = new StationaryPreviewRenderer(
      device,
      this.pipelines,
      this.internalFormat,
      format,
      this.compositorSampler,
      (layerCount) => this.inspectPassesFor(layerCount, 'sdr').ready,
    );
    const timestamp = GpuTimestampProfiler.create(device);
    this.gpuProfiler = timestamp.profiler;
    publishGpuTimestampBreadcrumbs(this.gpuProfiler !== null, timestamp.reason);
  }

  getRenderTiming(): RenderTiming {
    const gpu: GpuRenderTiming = this.gpuProfiler
      ? this.gpuProfiler.getSnapshot()
      : EMPTY_GPU_RENDER_TIMING;
    return {
      lastCpuMs: this.lastRenderCpuMs,
      averageCpuMs: this.averageRenderCpuMs,
      gpu,
    };
  }

  /**
   * Adopt a pass-graph source — `null` for the default graph.
   *
   * The source names a shape; each frame then asks it for the *variant* that
   * frame needs (the layer count, the temporal term, the canvas it presents
   * to) and the executor draws that. A variant that will not compile, encode
   * or validate is refused with the node named, and that variant draws the
   * default graph instead — never an approximation of the shape.
   */
  setPassGraph(source: PassGraphSource | null, options?: PassGraphSlotOptions): void {
    if (options) {
      this.graphSlot = options.slot;
      this.graphPrimary = options.primary;
    }
    this.graphSource = source ?? DEFAULT_GRAPH_SOURCE;
    this.graphVariants.clear();
    this.adoptedGraph = null;
    // Republish what this slot draws under its (possibly new) name.
    this.drawnGraph = undefined;
    // The variant a still SDR session draws, adopted now so its pipelines are
    // validating before the first frame asks for it.
    this.adoptGraphVariant({ layerCount: DEFAULT_LAYER_COUNT, motion: false, presentation: 'sdr' });
  }

  /**
   * The graph a frame of `variant` draws: the source's, or — when the source
   * refused that variant — the default graph's. `null` when even the default
   * graph refused it.
   */
  private compiledGraphVariant(variant: GraphVariant): CompiledGraph | null {
    const key = graphVariantKey(variant);
    const own = this.compileVariant(this.graphSource, this.graphVariants, variant, key);
    if (typeof own !== 'string') return own;
    if (this.graphSource.name === 'default') return null;
    const fallback = this.compileVariant(DEFAULT_GRAPH_SOURCE, this.defaultVariants, variant, key);
    return typeof fallback === 'string' ? null : fallback;
  }

  /** `source`'s graph for `variant`, compiled on first request into `cache` — or its refusal. */
  private compileVariant(
    source: PassGraphSource,
    cache: Map<string, CompiledGraph | string>,
    variant: GraphVariant,
    key: string,
  ): CompiledGraph | string {
    let entry = cache.get(key);
    if (entry === undefined) {
      try {
        entry = compileGraph(source.build(variant), 'webgpu');
        // Planning is where an encodable-but-not-drawable graph is refused.
        buildEncodePlan(entry);
        this.variantOrigins.set(entry, { name: source.name, key });
      } catch (error) {
        entry = passGraphRefusal(error);
        console.warn('[Chromashift:PassGraph] refused a graph variant —', source.name, key, entry);
        if (this.graphPrimary) publishGraphVariant(null, entry, this.graphSource.name, key);
      }
      cache.set(key, entry);
    }
    return entry;
  }

  /**
   * Make `variant` the executor's target if it is not already, and start the
   * device validating its pipelines. Returns the compiled variant, or `null`
   * when nothing could be compiled for it.
   */
  private adoptGraphVariant(variant: GraphVariant): CompiledGraph | null {
    const compiled = this.compiledGraphVariant(variant);
    if (compiled !== this.adoptedGraph) {
      this.graphExecutor.setGraph(compiled);
      this.adoptedGraph = compiled;
      if (compiled && this.graphPrimary) {
        // A stand-in default keeps the source's refusal on the breadcrumb.
        const key = graphVariantKey(variant);
        const own = this.graphVariants.get(key);
        publishGraphVariant(compiled, typeof own === 'string' ? own : null, this.graphSource.name, key);
      }
      this.verifyGraphPipelines();
    }
    return compiled;
  }

  /**
   * Build the target's pipelines and refuse the variant if the device rejects
   * any of them.
   *
   * Invalid WGSL is not an exception in WebGPU: it produces an invalid
   * pipeline, and the first frame that binds it is a command buffer the queue
   * drops whole. `?graph=warp` shipped exactly that way — its emitted shader
   * failed uniformity analysis and the canvas went black, while every
   * breadcrumb said it was drawing. Until the device answers, the executor
   * keeps drawing the last frame (`readyFrame`); a rejection is a named
   * refusal, and that variant draws the default graph.
   *
   * A variant validated before answers at once: its programs are cached on
   * the structural hash, verdict and all.
   */
  private verifyGraphPipelines(): void {
    const adopted = this.adoptedGraph;
    if (!adopted) return;
    let verdict: Promise<string | null>;
    try {
      verdict = this.graphExecutor.prepare();
    } catch (error) {
      this.refuseVariant(adopted, `invalid-pipeline: ${String(error)}`);
      return;
    }
    void verdict.then((error) => {
      // A superseded variant's rejection still stands: it is that variant's.
      if (error !== null && !this.destroyed) this.refuseVariant(adopted, `invalid-pipeline: ${error}`);
    });
  }

  /** Remember `compiled`'s variant as refused, so the next frame adopts its stand-in. */
  private refuseVariant(compiled: CompiledGraph, message: string): void {
    console.warn('[Chromashift:PassGraph] the device rejected a graph variant —', message);
    for (const cache of [this.graphVariants, this.defaultVariants]) {
      for (const [key, entry] of cache) {
        if (entry === compiled) cache.set(key, message);
      }
    }
    if (this.adoptedGraph === compiled) this.adoptedGraph = null;
    if (this.graphPrimary) publishDiagnostic('passGraphError', message);
  }

  /**
   * What this renderer drew: always into its slot's entry, and into the
   * session-wide breadcrumbs only from the primary canvas. Published when it
   * changes, so a variant switch shows up the frame it lands.
   */
  private publishDrawn(compiled: CompiledGraph | null): void {
    if (compiled === this.drawnGraph) return;
    this.drawnGraph = compiled;
    const origin = compiled ? this.variantOrigins.get(compiled) : undefined;
    const name = origin?.name ?? null;
    publishSlotExecuting(this.graphSlot, name);
    if (this.graphPrimary) {
      publishGraphExecutorBreadcrumbs(
        name,
        compiled ? this.graphExecutor.encodedPasses(compiled) : [],
        origin?.key ?? null,
      );
    }
  }

  /** Name of the graph shape this renderer draws. */
  get passGraphName(): GraphPresetName {
    return this.graphSource.name;
  }

  /** CPU-lane fallback for when `MotionFieldPass` declines; see its docs. */
  setMotionField(motion: CpuMotionField | null): void {
    this.motionField.setCpuField(motion);
  }

  wantsCpuMotionField(): boolean {
    return this.motionField.wantsCpuField();
  }

  setTexture(handle: ChromashiftTextureHandle): void {
    if (handle.backend !== 'webgpu') {
      throw new Error(`Expected a webgpu texture handle, received ${handle.backend}.`);
    }
    if (this.currentTexture !== handle.texture) {
      this.motionResetPending = true;
    }
    this.currentTexture = handle.texture;
    this.stationaryPreview.setSourceTexture(this.currentTexture);
  }

  setClassificationMaskTexture(texture: GPUTexture | null): void {
    this.classificationMaskTexture = texture;
    this.stationaryPreview.setMaskTexture(texture);
  }

  setAntialiasing(enabled: boolean): void {
    const next = enabled ? 4 : 1;
    if (next === this.sampleCount) return;
    this.sampleCount = next;
    // The band-layer pipelines are rebuilt at the new sample count; the last
    // frame keeps drawing at the old one until the device has validated them.
    this.graphExecutor.setSampleCount(this.sampleCount);
    this.verifyGraphPipelines();
  }

  async renderStationaryPreviews(
    state: RendererState,
    options?: StationaryPreviewOptions,
  ): Promise<StationaryPreviewResult> {
    return this.stationaryPreview.render(state, options);
  }

  requestCollisionStats(callback: (stats: CollisionStats) => void): boolean {
    const layers = this.lastFrameOutputs()?.layers.length ?? DEFAULT_LAYER_COUNT;
    return this.readback.requestCollisionStats(callback, layers);
  }

  clearPersistence(): void {
    this.graphExecutor.clearAccumulators();
  }

  /**
   * The last frame's named outputs (`CompiledGraph.outputs`) as textures —
   * what the inspect, readback and export helpers read. `null` when the last
   * frame drew nothing, or its graph has no such outputs.
   */
  private lastFrameOutputs(): GraphOutputTextures | null {
    if (!this.drawnGraph) return null;
    return this.graphExecutor.outputTextures();
  }

  render(state: RendererState, fps = 30): void {
    if (!this.currentTexture) return;
    const renderStart = performance.now();

    let canvasTex: GPUTexture;
    try {
      canvasTex = this.context.getCurrentTexture();
    } catch (error) {
      console.warn('[WebGPURenderer] Canvas texture unavailable:', error);
      return;
    }

    const hdrCanvas = canvasTex.format === HDR_CANVAS_FORMAT;
    if (hdrCanvas !== this.presentedHdr) {
      this.presentedHdr = hdrCanvas;
      if (typeof window !== 'undefined') {
        publishDiagnostic('canvasHdrNote', canvasHdrInternalNote(hdrCanvas, this.internalFormat));
      }
    }

    const enc = this.device.createCommandEncoder();
    const profiling = state.profilePerformance === true && this.gpuProfiler !== null;
    this.gpuProfiler?.setEnabled(profiling);
    if (profiling && this.gpuProfiler) {
      this.gpuProfiler.setBandwidthInput({
        canvasW: canvasTex.width,
        canvasH: canvasTex.height,
        layerScale: rendererStateValue(state, 'layerScale'),
        tracerScale: rendererStateValue(state, 'tracerScale'),
        sampleCount: this.sampleCount,
        readbackActive: state.livePreviewEnabled !== false,
        internalBytesPerPixel: internalColorFormatBytesPerPixel(this.internalFormat),
        motionActive: rendererStateValue(state, 'motionMode') !== 0,
        motionFlowActive: rendererStateValue(state, 'motionMode') === MOTION_MODE_DIRECTION,
        motionDivisor: MOTION_FIELD_DIVISOR,
      });
    }

    // The live canvas shows whichever main view the session selected — the
    // processed composite, or one of the inspect views (the full-res tracer, a
    // band layer, the heatmap, …).
    this.encodeFrameCore(
      enc,
      state,
      canvasTex.createView(),
      canvasTex.width,
      canvasTex.height,
      fps,
      rendererStateValue(state, 'mainViewMode'),
      this.gpuProfiler,
      hdrCanvas,
    );

    const statsEncoded = this.readback.encodeQueuedReadbacks(enc, this.lastFrameOutputs()?.diagnostic ?? null);

    this.gpuProfiler?.finishFrame(enc);

    this.device.queue.submit([enc.finish()]);
    this.lastRenderCpuMs = performance.now() - renderStart;
    this.averageRenderCpuMs = this.averageRenderCpuMs === 0
      ? this.lastRenderCpuMs
      : this.averageRenderCpuMs * 0.9 + this.lastRenderCpuMs * 0.1;
    this.gpuProfiler?.afterSubmit();
    // Only when the chore ran: `off` must not map a stats buffer, or publish a
    // breadcrumb, for a pass that never ran.
    if (this.motionFieldEncoded) this.motionField.afterSubmit();
    this.readback.afterSubmit(statsEncoded);
  }

  /**
   * After an export at another resolution. Nothing to do: the executor's pool
   * is sized by the frame it encodes, so the next live frame resizes it.
   */
  restoreRenderSize(): void {}

  async exportFrame(state: RendererState, options: ExportFrameOptions): Promise<ExportFrameResult | null> {
    if (!this.currentTexture) return null;

    const width = Math.max(1, Math.floor(options.width));
    const height = Math.max(1, Math.floor(options.height));
    const fps = options.fps ?? 30;
    const passMode = options.passMode ?? 'composite';

    // An export is always SDR, so on an HDR canvas its variant may never have
    // drawn: wait for the device to validate it rather than export a black
    // frame because the live (HDR) variant cannot draw into an SDR target.
    if (this.adoptGraphVariant({
      layerCount: Math.max(1, Math.min(MAX_LAYER_COUNT, state.layers.length)),
      motion: rendererStateValue(state, 'motionMode') !== 0,
      presentation: 'sdr',
    })) {
      await this.graphExecutor.prepare();
    }
    // An inspect-view export (tracers, a layer) needs its passes compiled, or
    // it would export the composite instead.
    const mainView = exportMainView(passMode, state);
    if (mainView !== MAIN_VIEW_MODES.PROCESSED_COMPOSITE) {
      await this.inspectPassesFor(Math.max(1, Math.min(MAX_LAYER_COUNT, state.layers.length)), 'sdr').ready;
    }
    if (this.destroyed || !this.currentTexture) return null;

    // Always the SDR canvas format, never the live canvas's: export stays SDR
    // (`encode_display` + clip) even while the canvas presents HDR.
    const output = this.device.createTexture({
      size: [width, height, 1],
      format: this.pipelines.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });

    const exportState: RendererState = {
      ...state,
      viewportQuarterZoom: false,
      viewportHalfOverlay: false,
      diagnosticsMode: false,
      ...(passMode === 'layers'
        ? { tracerAboveIntensity: 0, tracerBelowIntensity: 0 }
        : {}),
    };

    const enc = this.device.createCommandEncoder();
    this.encodeFrameCore(enc, exportState, output.createView(), width, height, fps, mainView);
    this.device.queue.submit([enc.finish()]);

    const result = await this.readback.readTexturePixels(output, width, height);
    output.destroy();
    return result;
  }

  private encodeFrameCore(
    enc: GPUCommandEncoder,
    state: RendererState,
    outputView: GPUTextureView,
    width: number,
    height: number,
    fps: number,
    mainView: number,
    profiler: GpuTimestampProfiler | null = null,
    hdrCanvas = false,
  ): void {
    profiler?.beginFrame(enc);
    const presentation: CanvasPresentation = hdrCanvas ? 'hdr-extended' : 'sdr';

    // The motion field depends only on the source frame, so it is produced
    // first. It is wanted when the temporal term is on (any mode but `off`),
    // or when the graph itself reads it — a `displace` steered by it, which
    // also needs the solved flow. Otherwise nothing runs: `motionMode: 'off'`
    // leaves the frame exactly as it was before the temporal term existed,
    // down to the command buffers.
    //
    // `encodeAndSubmit` records into (and submits) its own command buffer
    // rather than this frame's `enc` — a validation failure in the
    // frame-difference dispatch or, in `direction` mode, the two Lucas–Kanade
    // dispatches on top of it, must not poison the composite `enc` draws. It is
    // submitted ahead of `enc` wherever in the frame it is called, so producing
    // it up front changes nothing on the queue.
    const motionMode = rendererStateValue(state, 'motionMode');
    // The frame's band count: the executor draws exactly this many passes.
    const layerCount = Math.max(1, Math.min(MAX_LAYER_COUNT, state.layers.length));
    const graphField = this.graphFieldUse(layerCount);
    this.motionFieldEncoded = (motionMode !== 0 || graphField.reads) && this.currentTexture !== null;
    const motionTexture = this.motionFieldEncoded
      ? this.encodeMotionField(state, motionMode === MOTION_MODE_DIRECTION || graphField.needsFlow)
      : null;

    // The variant this frame needs — with the temporal term on (a mode
    // selected *and* a field to read) the graph carries a `motion` node fused
    // into its accumulators, and with it off it is the pre-motion graph; on an
    // HDR canvas its output presents `hdr-extended`, and the compositor
    // writing it emits the unclamped OETF into the float canvas.
    this.adoptGraphVariant({
      layerCount,
      motion: motionMode !== 0 && motionTexture !== null,
      presentation,
    });
    // That variant once the device has validated it; until then the last
    // frame's, if it draws into the same canvas format.
    const frame = this.currentTexture ? this.graphExecutor.readyFrame(presentation) : null;
    this.publishDrawn(frame?.compiled ?? null);

    if (!frame || !this.currentTexture) {
      // Nothing validated can draw this canvas yet — the first frames of a
      // session, or the switch to an HDR canvas, for as long as validation
      // takes. Black, rather than a frame the queue would drop.
      encodeClear(enc, outputView);
      profiler?.markLayersEnd(enc);
      profiler?.markMotionEnd(enc);
      profiler?.markMotionFlowEnd(enc);
      profiler?.markPersistenceEnd(enc);
      profiler?.markCompositorEnd(enc);
      return;
    }

    // A frame whose canvas shows an inspect view rather than the composite
    // still runs every pass but the compositor, so the tracers keep
    // accumulating, and the view is drawn from the graph's outputs.
    // Until the device has compiled the inspect pipelines (off the frame),
    // the canvas keeps the composite.
    const { outputs } = frame.compiled;
    const inspectPass = mainView !== MAIN_VIEW_MODES.PROCESSED_COMPOSITE
      && outputs.layers.length > 0
      && outputs.tracers.length >= 2
      && TracerInspectPass.drawsMainView(mainView, outputs.layers.length)
      ? this.inspectPassesFor(outputs.layers.length, presentation).pass
      : null;
    const inspectView = inspectPass !== null;
    this.graphExecutor.encode(
      enc,
      {
        source: this.currentTexture,
        classificationMask: this.classificationMaskTexture ?? this.fallbackMaskTexture,
        hasClassificationMask: this.classificationMaskTexture !== null,
        profileLut: this.updatedProfileLut(state),
        motionField: motionTexture,
      },
      {
        state,
        outputView,
        width,
        height,
        fps,
        composite: !inspectView,
        marks: {
          layersEnd: () => {
            profiler?.markLayersEnd(enc);
            profiler?.markMotionEnd(enc);
            profiler?.markMotionFlowEnd(enc);
          },
          stampEnd: () => profiler?.markPersistenceEnd(enc),
          // An inspect view is the frame's compositor; it is marked below.
          compositorEnd: inspectView ? undefined : () => profiler?.markCompositorEnd(enc),
        },
      },
      frame,
    );
    if (inspectPass) {
      const textures = this.graphExecutor.outputTextures()!;
      this.encodeInspectView(inspectPass, enc, state, mainView, outputView, width, height, {
        layers: textures.layers,
        below: textures.tracerBelow,
        above: textures.tracerAbove,
        diagnostic: textures.diagnostic,
        pingPong: textures.pingPong,
      });
      profiler?.markCompositorEnd(enc);
    }
  }

  /**
   * Draw one of the inspect views (`TracerInspectPass.drawsMainView`) into
   * `outputView` from the frame's outputs. Returns whether it drew.
   */
  private encodeInspectView(
    inspectPass: TracerInspectPass,
    enc: GPUCommandEncoder,
    state: RendererState,
    mainView: number,
    outputView: GPUTextureView,
    width: number,
    height: number,
    textures: {
      layers: LayerTextures;
      below: GPUTexture;
      above: GPUTexture;
      diagnostic: GPUTexture | null;
      pingPong: 0 | 1;
    },
  ): boolean {
    const {
      tracerAboveOpacity, tracerBelowOpacity, tracerBlendMode, layerBlendMode, layerOpacities,
      ...inspectView
    } = tracerInspectSettings(state);
    const compositorValues = compositorUniforms(state, textures.layers.length);
    return inspectPass.encodeMainView(enc, {
      mainViewMode: mainView,
      canvasView: outputView,
      canvasWidth: width,
      canvasHeight: height,
      sourceTexture: this.currentTexture!,
      sourceSampler: this.sampler,
      layerTextures: textures.layers,
      persistBelow: textures.below,
      persistAbove: textures.above,
      persistDiagnostic: textures.diagnostic,
      pingPong: textures.pingPong,
      colorThresh: rendererStateValue(state, 'tracerThreshold'),
      tracerAboveOp: tracerAboveOpacity,
      tracerBelowOp: tracerBelowOpacity,
      layerBlendMode,
      tracerBlendMode,
      layerOpacities,
      stampBoost: compositorValues.stampBoost,
      outputMode: compositorValues.outputMode,
      tracerMode: compositorValues.tracerMode,
      tracerInspect: inspectView,
    });
  }

  /**
   * The inspect passes for a frame of `layerCount` band layers presented to
   * `presentation`: their shaders and layouts bind every layer, so each count
   * needs its own set. Compiled off the frame on first use (`pass` stays
   * `null` until then, and for good if the device refuses them) and kept.
   */
  private inspectPassesFor(layerCount: number, presentation: CanvasPresentation): InspectPassEntry {
    const key = `${layerCount}:${presentation}`;
    const cached = this.inspectPassSets.get(key);
    if (cached) return cached;

    const pipelines = new WebGPUPipelines(
      this.device,
      presentation === 'hdr-extended' ? HDR_CANVAS_FORMAT : this.pipelines.format,
      layerCount,
      presentation,
    );
    const entry: InspectPassEntry = { pass: null, ready: Promise.resolve(null) };
    entry.ready = TracerInspectPass.create(this.device, pipelines, this.compositorSampler).then(
      (pass) => {
        if (this.destroyed) {
          pass.destroy();
          return null;
        }
        entry.pass = pass;
        return pass;
      },
      (error: unknown) => {
        console.error('[WebGPURenderer] Inspect view pipelines refused:', error);
        if (!this.destroyed) this.runtimeErrorHandler?.(pipelineRuntimeError('An inspect view', error));
        return null;
      },
    );
    this.inspectPassSets.set(key, entry);
    return entry;
  }

  /** Report a refused pipeline (to the orchestrator, and so the error overlay). */
  setRuntimeErrorHandler(handler: ((error: GpuRuntimeError) => void) | null): void {
    this.runtimeErrorHandler = handler;
  }

  /**
   * Run the motion chore for this frame and return its field (`null` when the
   * lane declined and no CPU field exists).
   */
  private encodeMotionField(state: RendererState, wantFlow: boolean): GPUTexture | null {
    const source = this.currentTexture!;
    const field = this.motionField.encodeAndSubmit(
      source,
      source.width,
      source.height,
      {
        threshold: rendererStateValue(state, 'motionThreshold'),
        // A paused session shows a frozen frame; differencing it against
        // itself is zero anyway, but the explicit reset keeps the first frame
        // after unpausing from stamping a whole-screen "change".
        reset: this.motionResetPending || rendererStateValue(state, 'paused'),
      },
      wantFlow,
    );
    this.motionResetPending = false;
    return field;
  }

  /**
   * How the source's graph reads the motion field before the temporal term
   * is added — a `displace` steered by it, say. Asked of the still variant,
   * because it decides whether the chore runs at all, and that decides which
   * variant the frame gets.
   */
  private graphFieldUse(layerCount: number): MotionFieldUse {
    const still = this.compiledGraphVariant({ layerCount, motion: false, presentation: 'sdr' });
    if (!still) return NO_MOTION_FIELD_USE;
    let use = this.fieldUseByGraph.get(still);
    if (!use) {
      use = motionFieldUse(still);
      this.fieldUseByGraph.set(still, use);
    }
    return use;
  }

  /** Upload the active colour profile LUT and hand back its texture. */
  private updatedProfileLut(state: RendererState): GPUTexture {
    this.profileLut.update(state.colorProfileLut);
    return this.profileLut.texture;
  }

  async exportTracerView(options: ExportTracerOptions): Promise<ExportTracerResult | null> {
    const outputs = this.lastFrameOutputs();
    if (!outputs) return null;
    const inspect = await this.inspectPassesFor(outputs.layers.length, 'sdr').ready;
    if (!inspect || this.destroyed) return null;
    return this.readback.exportTracerView(
      inspect,
      {
        persistAbove: outputs.tracerAbove,
        persistBelow: outputs.tracerBelow,
        layerTextures: outputs.layers,
        pingPong: outputs.pingPong,
      },
      options,
    );
  }

  destroy(): void {
    this.destroyed = true;
    publishSlotExecuting(this.graphSlot, undefined);
    this.graphExecutor.destroy();
    this.motionField.destroy();
    for (const entry of this.inspectPassSets.values()) entry.pass?.destroy();
    this.readback.destroy();
    this.stationaryPreview.destroy();
    this.gpuProfiler?.destroy();
    this.fallbackMaskTexture.destroy();
    this.profileLut.destroy();
  }
}
