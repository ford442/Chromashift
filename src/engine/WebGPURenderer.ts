import { layerFragmentSources } from './shaders';
import {
  MAX_LAYER_COUNT,
  compileGraph,
  graphVariantKey,
  passGraphRefusal,
  publishGraphExecutorBreadcrumbs,
  publishGraphVariant,
  publishSlotExecuting,
  type GraphPresetName,
  type GraphVariant,
  type PassGraphSource,
} from './graph';
import { WebGpuGraphExecutor, type GraphOutputTextures } from './graph/exec/WebGpuGraphExecutor';
import { buildEncodePlan, motionFieldUse, type MotionFieldUse } from './graph/exec/plan';
import type { CompiledGraph } from './graph/types';
import { WebGPUPipelines, drawnLayerCount, encodeLayerClear, type LayerPipeline } from './WebGPUPipelines';
import { MAIN_VIEW_MODES } from './viewModes';
import {
  createLayerBindGroupCache,
  getOrCreateLayerBindGroup,
  invalidateLayerBindGroupCache,
  type LayerTextures,
} from './BindGroupCache';
import { MotionFieldPass } from './MotionFieldPass';
import { MOTION_FIELD_DIVISOR, MOTION_MODE_DIRECTION } from './motionModes';
import { PersistencePass } from './PersistencePass';
import { CompositorPass } from './CompositorPass';
import { TracerInspectPass } from './TracerInspectPass';
import {
  bandLayerUniforms,
  compositorUniforms,
  rendererStateValue,
  tracerInspectSettings,
} from './graph/exec/uniforms';
import { packUniforms } from './graph/templates/uniformLayout';
import { BAND_LAYER_UNIFORMS } from './graph/templates/wgsl';
import { GpuReadback } from './GpuReadback';
import { GpuTimestampProfiler, publishGpuTimestampBreadcrumbs } from './GpuTimestampProfiler';
import { StationaryPreviewRenderer } from './StationaryPreviewRenderer';
import type { StationaryPreviewOptions, StationaryPreviewResult } from './stationaryPreview';
import type { CpuMotionField, ExportFrameOptions, ExportFrameResult, ExportPassMode, ExportTracerOptions, ExportTracerResult, GpuRenderTiming, PassGraphSlotOptions, RenderTiming } from './types/RendererContracts';
import { EMPTY_GPU_RENDER_TIMING } from './types/RendererContracts';
import type { CollisionStats, RendererState } from './types/RendererState';
import type { ChromashiftTextureHandle } from './types/TextureHandle';
import { layerRotationUniforms } from './math/rotation';
import { ProfileLutTexture } from './color/ProfileLutTexture';
import {
  HDR_CANVAS_FORMAT,
  type CanvasPresentation,
  canvasHdrInternalNote,
  internalColorFormatBytesPerPixel,
  selectInternalColorFormat,
} from './gpuOptions';

/**
 * WebGPURenderer — one canvas's WebGPU frame. The pass-graph executor draws it
 * (the gate is on by default; docs/PASS_GRAPH.md); the hand-written five-pass
 * encoder below is what `?graph=0`, a refused variant, and the frames before
 * the device has validated a variant's pipelines get.
 */

/** Size contract for helpers that only need texture dimensions, not the GPU resource itself. */
type TextureSize = { readonly width: number; readonly height: number };

/** A frame whose graph reads no motion field and solves no flow. */
const NO_MOTION_FIELD_USE: MotionFieldUse = { reads: false, needsFlow: false };

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

export class WebGPURenderer {
  readonly backend = 'webgpu' as const;
  static readonly DIAGNOSTIC_SIZE = GpuReadback.DIAGNOSTIC_SIZE;

  private device         : GPUDevice;
  private context        : GPUCanvasContext;
  private internalFormat : GPUTextureFormat;
  public pipelines: WebGPUPipelines;
  public sampler        : GPUSampler;
  private sampleCount    : number = 4;

  private layerPipelines : LayerPipeline[] = [];
  private currentTexture : GPUTexture | null = null;
  private classificationMaskTexture: GPUTexture | null = null;
  private fallbackMaskTexture: GPUTexture;
  private readonly profileLut: ProfileLutTexture;

  private layerTextures : GPUTexture[] = [];
  private msaaTexture   : GPUTexture | null = null;
  private texW = 0;
  private texH = 0;
  private currentLayerScale = 1.0;
  private currentTracerScale = 1.0;
  private layerScale = 1.0;
  private tracerScale = 1.0;

  private readonly persistence: PersistencePass;
  private readonly motionField: MotionFieldPass;
  /**
   * Set whenever the source texture *object* changes (a new image, a live
   * frame at a new resolution). A live source re-uploads into the same texture
   * every tick, so identity — not the `setTexture` call itself — is what tells
   * a genuinely new source apart from the next frame of the current one.
   */
  private motionResetPending = true;
  /** Inspect passes for a layer count other than the canonical one, by `count:presentation`. */
  private readonly inspectPassSets = new Map<string, TracerInspectPass>();
  /** Whether this frame ran the motion chore, so `afterSubmit` maps its stats only then. */
  private motionFieldEncoded = false;
  /** `motionFieldUse` per compiled graph — asked every frame, computed once. */
  private readonly fieldUseByGraph = new WeakMap<CompiledGraph, MotionFieldUse>();
  private readonly compositor: CompositorPass;
  private readonly tracerInspect: TracerInspectPass;
  /**
   * Canvas-target passes for `hdr-extended` presentation: built lazily, the
   * first frame the canvas comes back `rgba16float`, against that format and
   * the unclamped OETF. Export, preview readback and the graph executor keep
   * using the SDR passes above, so only what lands on the HDR canvas changes.
   */
  private hdrPresent: {
    pipelines: WebGPUPipelines;
    compositor: CompositorPass;
    tracerInspect: TracerInspectPass;
  } | null = null;
  /** Whether the last frame presented HDR, so the breadcrumb only moves on a change. */
  private presentedHdr = false;
  private readonly readback: GpuReadback;
  private readonly gpuProfiler: GpuTimestampProfiler | null;
  private readonly compositorSampler: GPUSampler;
  private readonly stationaryPreview: StationaryPreviewRenderer;
  /**
   * One entry per band layer. Sized from the pipelines this renderer built —
   * `layerFragmentSources.length` today, whatever the graph executor schedules
   * once it owns the layer passes.
   */
  private readonly layerBindGroupCache = createLayerBindGroupCache(layerFragmentSources.length);

  private lastRenderCpuMs = 0;
  private averageRenderCpuMs = 0;

  /**
   * Pass-graph executor (docs/PASS_GRAPH.md). Non-null once `setPassGraph()`
   * adopts a graph source; `render()` then encodes the variant the frame asks
   * for instead of the hand-written five-pass topology.
   */
  private graphExecutor: WebGpuGraphExecutor | null = null;
  private graphSource: PassGraphSource | null = null;
  /**
   * The source's variants compiled so far, by `graphVariantKey` — or, for one
   * that will not compile or encode, the refusal it produced. Remembered either
   * way, so a frame never compiles twice and a refused variant is not retried
   * every frame.
   */
  private readonly graphVariants = new Map<string, CompiledGraph | string>();
  /** The variant the executor holds right now. */
  private adoptedGraph: CompiledGraph | null = null;
  /** The orchestrator slot this renderer draws, and whether it is the primary canvas. */
  private graphSlot = 'main';
  private graphPrimary = true;
  /**
   * Whether the graph executor — rather than the hand encoder — encoded the
   * most recent frame.
   *
   * Adopting a graph is not the same as drawing with it: a variant the device
   * has not validated yet, a refused one, or a `?graph=0` session draws with
   * the hand encoder, which writes *its* layer and persistence textures. The
   * readback, inspect and export helpers below have to follow whichever path
   * actually ran, or they publish a stale frame from the other one's targets.
   */
  private executorEncodedLastFrame = false;

  constructor(device: GPUDevice, context: GPUCanvasContext, format: GPUTextureFormat, enableMSAA = false) {
    this.device  = device;
    this.context = context;
    this.internalFormat = selectInternalColorFormat(device);
    this.sampleCount = enableMSAA ? 4 : 1;
    this.pipelines = new WebGPUPipelines(device, format, this.internalFormat);

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

    for (const src of layerFragmentSources) {
      this.layerPipelines.push(this.pipelines.createLayerPipeline(src, this.sampleCount));
    }

    this.persistence = new PersistencePass(device, this.pipelines, this.internalFormat, this.compositorSampler);
    this.motionField = new MotionFieldPass(device);
    this.compositor = new CompositorPass(device, this.pipelines, this.compositorSampler);
    this.tracerInspect = new TracerInspectPass(device, this.pipelines, this.compositorSampler);
    this.readback = new GpuReadback(device, format, this.pipelines);
    this.stationaryPreview = new StationaryPreviewRenderer(
      device,
      this.pipelines,
      this.internalFormat,
      format,
      this.compositorSampler,
      (layerCount) => this.inspectPassesFor(layerCount, 'sdr'),
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

  private invalidateBindGroupCaches(): void {
    invalidateLayerBindGroupCache(this.layerBindGroupCache);
    this.persistence.invalidateCaches();
    this.compositor.invalidateCaches();
    this.tracerInspect.invalidateCaches();
    this.hdrPresent?.compositor.invalidateCaches();
    this.hdrPresent?.tracerInspect.invalidateCaches();
    this.readback.invalidateCaches();
  }

  /** The HDR canvas passes, created on first use. */
  private hdrPresentPasses(): { compositor: CompositorPass; tracerInspect: TracerInspectPass } {
    if (!this.hdrPresent) {
      const pipelines = new WebGPUPipelines(
        this.device,
        HDR_CANVAS_FORMAT,
        this.internalFormat,
        this.pipelines.layerCount,
        'hdr-extended',
      );
      this.hdrPresent = {
        pipelines,
        compositor: new CompositorPass(this.device, pipelines, this.compositorSampler),
        tracerInspect: new TracerInspectPass(this.device, pipelines, this.compositorSampler),
      };
    }
    return this.hdrPresent;
  }

  /**
   * The hand encoder's layer, MSAA and tracer targets, at `w`×`h`.
   *
   * Allocated only by a frame the hand encoder draws — under the default
   * `?graph` gate that is the few frames before the device has validated the
   * executor's pipelines — and released as soon as the executor takes over
   * (`releaseHandTextures`), so a session does not hold two sets of
   * full-resolution targets for the one it draws.
   */
  private ensureTextures(w: number, h: number): void {
    const layerCount = this.layerPipelines.length;
    if (this.texW === w && this.texH === h &&
        this.currentLayerScale === this.layerScale &&
        this.currentTracerScale === this.tracerScale &&
        this.layerTextures.length === layerCount) return;

    this.currentLayerScale = this.layerScale;
    this.currentTracerScale = this.tracerScale;

    for (const t of this.layerTextures) t.destroy();
    this.msaaTexture?.destroy();

    const layerW = Math.max(1, Math.round(w * this.layerScale));
    const layerH = Math.max(1, Math.round(h * this.layerScale));
    const tracerW = Math.max(1, Math.round(w * this.tracerScale));
    const tracerH = Math.max(1, Math.round(h * this.tracerScale));

    this.layerTextures = Array.from({ length: layerCount }, () => this.device.createTexture({
      size: [layerW, layerH, 1],
      format: this.internalFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      sampleCount: 1,
    }));

    if (this.sampleCount > 1) {
      this.msaaTexture = this.device.createTexture({
        size: [layerW, layerH, 1],
        format: this.internalFormat,
        sampleCount: this.sampleCount,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
    } else {
      this.msaaTexture = null;
    }

    this.persistence.ensureTextures(tracerW, tracerH);

    this.texW = w;
    this.texH = h;
    this.invalidateBindGroupCaches();
  }

  /** Free the hand encoder's targets: the executor's pool draws the frame now. */
  private releaseHandTextures(): void {
    if (this.texW === 0 && this.layerTextures.length === 0) return;
    for (const t of this.layerTextures) t.destroy();
    this.layerTextures = [];
    this.msaaTexture?.destroy();
    this.msaaTexture = null;
    this.persistence.resetTextures();
    this.texW = 0;
    this.texH = 0;
    this.invalidateBindGroupCaches();
  }

  /**
   * Adopt a pass-graph source, or `null` to return to the hand encoder.
   *
   * The source names a shape; each frame then asks it for the *variant* that
   * frame needs (the temporal term on or off, today) and the executor draws
   * that. A variant that will not compile, or compiles but cannot be
   * *encoded* — a `decay` reading the wrong number of stamp inputs, a `blend`
   * with three tracers — is refused with the node named, and that variant
   * draws with the hand encoder rather than an approximation of it.
   *
   * Nor does an adopted variant draw straight away: the hand encoder keeps the
   * canvas until the device has validated its pipelines (see
   * `verifyGraphPipelines`), so emitted WGSL the device rejects is a refusal
   * too, rather than a black canvas.
   */
  setPassGraph(source: PassGraphSource | null, options?: PassGraphSlotOptions): void {
    if (options) {
      this.graphSlot = options.slot;
      this.graphPrimary = options.primary;
    }
    this.graphVariants.clear();
    this.adoptedGraph = null;
    if (!source) {
      this.graphExecutor?.destroy();
      this.graphExecutor = null;
      this.graphSource = null;
      this.publishExecuting(null, []);
      return;
    }

    this.graphSource = source;
    this.graphExecutor ??= new WebGpuGraphExecutor(
      this.device,
      this.internalFormat,
      this.pipelines.format,
      this.sampler,
      this.compositorSampler,
    );
    this.graphExecutor.setSampleCount(this.sampleCount);
    // The variant a still SDR session draws, adopted now so its pipelines are
    // validating before the first frame asks for it.
    this.adoptGraphVariant({ layerCount: this.pipelines.layerCount, motion: false, presentation: 'sdr' });
  }

  /**
   * The source's graph for `variant`, compiled on first request and cached —
   * or `null` when that variant was refused. A refusal is published once, when
   * it happens, and that variant then draws with the hand encoder.
   */
  private compiledGraphVariant(variant: GraphVariant): CompiledGraph | null {
    const source = this.graphSource;
    if (!source) return null;
    const key = graphVariantKey(variant);
    let entry = this.graphVariants.get(key);
    if (entry === undefined) {
      try {
        entry = compileGraph(source.build(variant), 'webgpu');
        // Planning is where an encodable-but-not-drawable graph is refused.
        buildEncodePlan(entry);
      } catch (error) {
        entry = passGraphRefusal(error);
        console.warn('[Chromashift:PassGraph] refused a graph variant —', key, entry);
        if (this.graphPrimary) publishGraphVariant(null, entry, source.name, key);
      }
      this.graphVariants.set(key, entry);
    }
    return typeof entry === 'string' ? null : entry;
  }

  /**
   * Hand `variant` to the executor if it is not already holding it, and start
   * the device validating its pipelines. Returns the compiled variant, or
   * `null` when it was refused.
   */
  private adoptGraphVariant(variant: GraphVariant): CompiledGraph | null {
    const compiled = this.compiledGraphVariant(variant);
    const executor = this.graphExecutor;
    if (!compiled || !executor || !this.graphSource) return null;
    if (compiled !== this.adoptedGraph) {
      executor.setGraph(compiled);
      this.adoptedGraph = compiled;
      if (this.graphPrimary) {
        publishGraphVariant(compiled, null, this.graphSource.name, graphVariantKey(variant));
      }
      this.verifyGraphPipelines();
    }
    return compiled;
  }

  /**
   * Build the executor's pipelines and let it draw only once the device has
   * accepted all of them.
   *
   * Invalid WGSL is not an exception in WebGPU: it produces an invalid
   * pipeline, and the first frame that binds it is a command buffer the queue
   * drops whole. `?graph=warp` shipped exactly that way — its emitted shader
   * failed uniformity analysis and the canvas went black, while every
   * breadcrumb said it was drawing. Waiting for the error scope turns that
   * into a named refusal, with the hand encoder still on screen.
   *
   * A variant the executor has validated before answers at once: its
   * pipelines are cached on the structural hash, verdict and all.
   */
  private verifyGraphPipelines(): void {
    const executor = this.graphExecutor;
    if (!executor || !executor.active) return;
    let verdict: Promise<string | null>;
    try {
      verdict = executor.prepare();
    } catch (error) {
      this.refuseGraph(`invalid-pipeline: ${String(error)}`);
      return;
    }
    // The breadcrumb says what is drawing, and until the device answers that
    // is the hand encoder.
    if (!executor.ready) this.publishExecuting(null, []);
    const adopted = this.adoptedGraph;
    void verdict.then((error) => {
      // Torn down, or superseded by another variant, while the device
      // answered. A superseded variant's verdict stays cached with it, so
      // adopting it again re-reads this one rather than losing it.
      if (executor !== this.graphExecutor || adopted !== this.adoptedGraph) return;
      if (error !== null) {
        this.refuseGraph(`invalid-pipeline: ${error}`);
        return;
      }
      if (executor.ready) {
        this.publishExecuting(this.graphSource?.name ?? null, executor.encodedPasses());
      }
    });
  }

  /** Drop the executor, name the refusal, and leave the hand encoder drawing. */
  private refuseGraph(message: string): void {
    console.warn('[Chromashift:PassGraph] executor refused the graph —', message);
    this.graphExecutor?.destroy();
    this.graphExecutor = null;
    this.graphSource = null;
    this.graphVariants.clear();
    this.adoptedGraph = null;
    if (typeof window !== 'undefined' && this.graphPrimary) window.passGraphError = message;
    this.publishExecuting(null, []);
  }

  /**
   * What this renderer's executor is drawing: always into its slot's entry,
   * and into the session-wide breadcrumbs only from the primary canvas.
   */
  private publishExecuting(name: GraphPresetName | null, encodedPasses: string[]): void {
    publishSlotExecuting(this.graphSlot, name);
    if (this.graphPrimary) publishGraphExecutorBreadcrumbs(name, encodedPasses);
  }

  /** Name of the graph shape the executor is drawing, or `null`. */
  get passGraphName(): GraphPresetName | null {
    return this.graphSource?.name ?? null;
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
    invalidateLayerBindGroupCache(this.layerBindGroupCache);
  }

  setClassificationMaskTexture(texture: GPUTexture | null): void {
    this.classificationMaskTexture = texture;
    this.stationaryPreview.setMaskTexture(texture);
    for (const entry of this.layerBindGroupCache) {
      entry.bindGroup = null;
      entry.maskTexture = null;
    }
  }

  setAntialiasing(enabled: boolean): void {
    const next = enabled ? 4 : 1;
    if (next === this.sampleCount) return;
    this.sampleCount = next;

    this.layerPipelines = [];
    for (const src of layerFragmentSources) {
      this.layerPipelines.push(this.pipelines.createLayerPipeline(src, this.sampleCount));
    }

    for (const t of this.layerTextures) t.destroy();
    this.layerTextures = [];
    this.msaaTexture?.destroy();
    this.msaaTexture = null;
    this.persistence.resetTextures();
    this.graphExecutor?.setSampleCount(this.sampleCount);
    // The band-layer pipelines are rebuilt at the new sample count, and the
    // hand encoder draws until the device has validated them.
    this.verifyGraphPipelines();
    this.texW = 0;
    this.texH = 0;
    this.layerScale = 1.0;
    this.tracerScale = 1.0;
    this.invalidateBindGroupCaches();
  }

  async renderStationaryPreviews(
    state: RendererState,
    options?: StationaryPreviewOptions,
  ): Promise<StationaryPreviewResult> {
    return this.stationaryPreview.render(state, options);
  }

  requestCollisionStats(callback: (stats: CollisionStats) => void): boolean {
    return this.readback.requestCollisionStats(callback, this.getLayerTextures().length);
  }

  clearPersistence(): void {
    this.persistence.clear();
    // The graph's pool owns the tracers while the executor draws, so clearing
    // only the hand encoder's pass would leave the trails on screen.
    this.graphExecutor?.clearAccumulators();
  }

  /**
   * Textures the preview, readback and inspect passes read.
   *
   * When the executor drew the frame, these come out of *its* pool — otherwise
   * the live preview and the collision-stats readback would sample the hand
   * encoder's now-untouched targets and report a black frame.
   */
  /** Graph-owned textures, but only when the graph encoded the current frame. */
  private lastFrameOutputs(): GraphOutputTextures | null {
    if (!this.executorEncodedLastFrame) return null;
    return this.graphExecutor?.outputTextures() ?? null;
  }

  /**
   * This frame's band-layer textures, in layer order.
   *
   * Length, not a literal three: the graph executor owns as many as its
   * schedule allocated, and the fallback owns as many as `ensureTextures`
   * created. Every pass downstream binds `layers.length` of them.
   */
  private getLayerTextures(): LayerTextures {
    const roles = this.lastFrameOutputs();
    return roles ? roles.layers : this.layerTextures;
  }

  private getTracerTextures(): { below: GPUTexture; above: GPUTexture } {
    const roles = this.lastFrameOutputs();
    if (roles) return { below: roles.tracerBelow, above: roles.tracerAbove };
    return {
      below: this.persistence.belowTextures[this.persistence.pingPong]!,
      above: this.persistence.aboveTextures[this.persistence.pingPong]!,
    };
  }

  /** Ping-pong index the bind-group caches key on, from whichever path drew. */
  private get activePingPong(): 0 | 1 {
    return this.lastFrameOutputs()?.pingPong ?? this.persistence.pingPong;
  }

  private encodeLayerPasses(
    enc: GPUCommandEncoder,
    state: RendererState,
    canvasSize: TextureSize,
  ): void {
    const maskTexture = this.classificationMaskTexture ?? this.fallbackMaskTexture;
    // Non-classic colour profiles render from the baked LUT (docs/COLOR_PROFILES.md).
    this.profileLut.update(state.colorProfileLut);
    const aspect = canvasSize.width / canvasSize.height;

    const drawn = drawnLayerCount(this.layerPipelines.length, state.layers.length);
    for (let i = 0; i < this.layerPipelines.length; i++) {
      if (i >= drawn) {
        encodeLayerClear(enc, this.layerTextures[i]);
        continue;
      }
      const lp = this.layerPipelines[i];
      const layer = state.layers[i];

      const [rad, flipX, flipY, layerAspect] = layerRotationUniforms(layer, aspect);
      lp.rotationData.set([rad, flipX, flipY, layerAspect]);
      this.device.queue.writeBuffer(lp.rotationBuffer, 0, lp.rotationData.buffer as ArrayBuffer, lp.rotationData.byteOffset, 16);

      packUniforms(BAND_LAYER_UNIFORMS, bandLayerUniforms(state, {
        layerIndex: i,
        hasClassificationMask: this.classificationMaskTexture !== null,
      }), lp.fragUniforms);
      this.device.queue.writeBuffer(lp.fragUniformBuffer, 0, lp.fragUniforms.buffer);

      const bindGroup = getOrCreateLayerBindGroup(
        this.device,
        this.layerBindGroupCache[i],
        lp.bindGroupLayout,
        this.currentTexture!,
        maskTexture,
        this.sampler,
        lp.rotationBuffer,
        lp.fragUniformBuffer,
        this.profileLut.texture,
      );

      const usesMSAA = this.sampleCount > 1 && this.msaaTexture !== null;
      const pass = enc.beginRenderPass({
        colorAttachments: [{
          view: usesMSAA ? this.msaaTexture!.createView() : this.layerTextures[i].createView(),
          resolveTarget: usesMSAA ? this.layerTextures[i].createView() : undefined,
          loadOp: 'clear',
          storeOp: usesMSAA ? 'discard' : 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        }],
      });
      pass.setPipeline(lp.pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(6);
      pass.end();
    }
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
    this.layerScale = rendererStateValue(state, 'layerScale');
    this.tracerScale = rendererStateValue(state, 'tracerScale');

    const hdrCanvas = canvasTex.format === HDR_CANVAS_FORMAT;
    if (hdrCanvas !== this.presentedHdr) {
      this.presentedHdr = hdrCanvas;
      if (typeof window !== 'undefined') {
        window.canvasHdrNote = canvasHdrInternalNote(hdrCanvas, this.internalFormat);
      }
    }

    const enc = this.device.createCommandEncoder();
    const profiling = state.profilePerformance === true && this.gpuProfiler !== null;
    this.gpuProfiler?.setEnabled(profiling);
    if (profiling && this.gpuProfiler) {
      this.gpuProfiler.setBandwidthInput({
        canvasW: canvasTex.width,
        canvasH: canvasTex.height,
        layerScale: this.layerScale,
        tracerScale: this.tracerScale,
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

    const statsEncoded = this.readback.encodeQueuedReadbacks(
      enc,
      this.diagnosticForReadback(rendererStateValue(state, 'paused')),
    );

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

  /** Stamp-diagnostic texture the collision-stats readback samples. */
  private diagnosticForReadback(paused: boolean): GPUTexture | null {
    const roles = this.lastFrameOutputs();
    if (roles) return roles.diagnostic;
    return this.persistence.getDiagnosticTextureForReadback(paused);
  }

  /**
   * Rebuild GPU targets after export at a different resolution. Only the hand
   * encoder's, and only if it has any: the executor's pool resizes on the
   * next frame it encodes.
   */
  restoreRenderSize(width: number, height: number): void {
    if (width > 0 && height > 0 && this.texW > 0) {
      this.ensureTextures(width, height);
    }
  }

  async exportFrame(state: RendererState, options: ExportFrameOptions): Promise<ExportFrameResult | null> {
    if (!this.currentTexture) return null;

    const width = Math.max(1, Math.floor(options.width));
    const height = Math.max(1, Math.floor(options.height));
    const fps = options.fps ?? 30;
    const passMode = options.passMode ?? 'composite';

    this.layerScale = rendererStateValue(state, 'layerScale');
    this.tracerScale = rendererStateValue(state, 'tracerScale');

    // Always the SDR pipelines' format, never the live canvas's: export stays
    // SDR (`encode_display` + clip) even while the canvas presents HDR.
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
    this.encodeFrameCore(enc, exportState, output.createView(), width, height, fps, exportMainView(passMode, state));
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
    // first, for whichever encoder draws. It is wanted when the temporal term
    // is on (any mode but `off`), or when the graph itself reads it — a
    // `displace` steered by it, which also needs the solved flow. Otherwise
    // nothing runs: `motionMode: 'off'` leaves the frame exactly as it was
    // before the temporal term existed, down to the command buffers.
    //
    // `encodeAndSubmit` records into (and submits) its own command buffer
    // rather than this frame's `enc` — a validation failure in the
    // frame-difference dispatch or, in `direction` mode, the two Lucas–Kanade
    // dispatches on top of it, must not poison the composite `enc` draws. It is
    // submitted ahead of `enc` wherever in the frame it is called, so producing
    // it up front changes nothing on the queue.
    const motionMode = rendererStateValue(state, 'motionMode');
    // The frame's band count. The executor draws exactly this many passes; the
    // hand encoder, while it is still the fallback, draws the first
    // min(n, 3) of its three and clears the rest.
    const layerCount = Math.max(1, Math.min(MAX_LAYER_COUNT, state.layers.length));
    const graphMayDraw = this.graphExecutor !== null;
    const graphField = graphMayDraw ? this.graphFieldUse(layerCount) : NO_MOTION_FIELD_USE;
    this.motionFieldEncoded = (motionMode !== 0 || graphField.reads) && this.currentTexture !== null;
    const motionTexture = this.motionFieldEncoded
      ? this.encodeMotionField(state, motionMode === MOTION_MODE_DIRECTION || graphField.needsFlow)
      : null;

    // Pass-graph executor (docs/PASS_GRAPH.md). It encodes the variant this
    // frame needs — with the temporal term on (a mode selected *and* a field
    // to read) the graph carries a `motion` node fused into its accumulators,
    // and with it off it is the pre-motion graph; on an HDR canvas its output
    // presents `hdr-extended`, and the compositor writing it emits the
    // unclamped OETF into the float canvas — and the hand-written encode path
    // is skipped whole rather than partly reused.
    //
    // A frame whose canvas shows an inspect view rather than the composite
    // still runs every pass but the compositor, so the tracers keep
    // accumulating, and the view is drawn from the graph's outputs.
    if (graphMayDraw && this.currentTexture) {
      const compiled = this.adoptGraphVariant({
        layerCount,
        motion: motionMode !== 0 && motionTexture !== null,
        presentation,
      });
      const executor = this.graphExecutor;
      if (compiled && executor?.ready) {
        this.executorEncodedLastFrame = true;
        this.releaseHandTextures();
        const { outputs } = compiled;
        const inspectView = mainView !== MAIN_VIEW_MODES.PROCESSED_COMPOSITE
          && outputs.layers.length > 0
          && outputs.tracers.length >= 2
          && TracerInspectPass.drawsMainView(mainView, outputs.layers.length);
        executor.encode(
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
        );
        if (inspectView) {
          const textures = executor.outputTextures()!;
          this.encodeInspectView(enc, state, mainView, outputView, width, height, presentation, {
            layers: textures.layers,
            below: textures.tracerBelow,
            above: textures.tracerAbove,
            diagnostic: textures.diagnostic,
            pingPong: textures.pingPong,
          });
          profiler?.markCompositorEnd(enc);
        }
        return;
      }
    }

    this.executorEncodedLastFrame = false;
    this.ensureTextures(width, height);
    const layerTextures = this.getLayerTextures();
    const { below: persistBelow, above: persistAbove } = this.getTracerTextures();
    const canvasSize: TextureSize = { width, height };

    this.encodeLayerPasses(enc, state, canvasSize);
    profiler?.markLayersEnd(enc);
    // The motion field was produced above, in its own command buffer; the
    // markers keep the HUD's motion rows where they have always been.
    profiler?.markMotionEnd(enc);
    profiler?.markMotionFlowEnd(enc);

    this.persistence.encode(enc, layerTextures, { state, fps, motionTexture });
    profiler?.markPersistenceEnd(enc);

    const drewView = TracerInspectPass.drawsMainView(mainView, layerTextures.length)
      && this.encodeInspectView(enc, state, mainView, outputView, width, height, presentation, {
        layers: layerTextures,
        // The tracers as they were before this frame's accumulate — what the
        // hand encoder has always shown — and this frame's stamp diagnostic.
        below: persistBelow,
        above: persistAbove,
        diagnostic: this.persistence.diagnosticTextures[this.persistence.pingPong],
        pingPong: this.persistence.pingPong,
      });
    if (!drewView) {
      const compositor = hdrCanvas ? this.hdrPresentPasses().compositor : this.compositor;
      compositor.writeUniforms(compositorUniforms(state, this.pipelines.layerCount));
      compositor.encode(
        enc,
        outputView,
        layerTextures,
        persistBelow,
        persistAbove,
        this.persistence.pingPong,
      );
    }
    profiler?.markCompositorEnd(enc);
  }

  /**
   * Draw one of the inspect views (`TracerInspectPass.drawsMainView`) into
   * `outputView` from whichever encoder's textures drew this frame. Returns
   * whether it drew.
   */
  private encodeInspectView(
    enc: GPUCommandEncoder,
    state: RendererState,
    mainView: number,
    outputView: GPUTextureView,
    width: number,
    height: number,
    presentation: CanvasPresentation,
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
    return this.inspectPassesFor(textures.layers.length, presentation).encodeMainView(enc, {
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
   * `presentation`: their shaders and layouts bind every layer, so a frame of
   * another count needs its own set. The renderer's canonical set is reused;
   * others are built on first use and kept.
   */
  private inspectPassesFor(layerCount: number, presentation: CanvasPresentation): TracerInspectPass {
    if (layerCount === this.pipelines.layerCount) {
      return presentation === 'hdr-extended' ? this.hdrPresentPasses().tracerInspect : this.tracerInspect;
    }
    const key = `${layerCount}:${presentation}`;
    let pass = this.inspectPassSets.get(key);
    if (!pass) {
      const pipelines = new WebGPUPipelines(
        this.device,
        presentation === 'hdr-extended' ? HDR_CANVAS_FORMAT : this.pipelines.format,
        this.internalFormat,
        layerCount,
        presentation,
      );
      pass = new TracerInspectPass(this.device, pipelines, this.compositorSampler);
      this.inspectPassSets.set(key, pass);
    }
    return pass;
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
    const above = outputs?.tracerAbove ?? this.persistence.aboveTextures[this.persistence.pingPong];
    const below = outputs?.tracerBelow ?? this.persistence.belowTextures[this.persistence.pingPong];
    if (!above || !below) return null;
    if (!outputs && this.layerTextures.length < this.layerPipelines.length) return null;
    const layers = this.getLayerTextures();

    return this.readback.exportTracerView(
      this.inspectPassesFor(layers.length, 'sdr'),
      {
        persistAbove: above,
        persistBelow: below,
        layerTextures: layers,
        pingPong: this.activePingPong,
      },
      options,
    );
  }

  destroy(): void {
    if (this.graphSource) publishSlotExecuting(this.graphSlot, undefined);
    this.graphExecutor?.destroy();
    this.graphExecutor = null;
    for (const lp of this.layerPipelines) {
      lp.rotationBuffer.destroy();
      lp.fragUniformBuffer.destroy();
    }
    for (const t of this.layerTextures) t.destroy();
    this.msaaTexture?.destroy();
    this.persistence.destroy();
    this.motionField.destroy();
    this.compositor.destroy();
    this.tracerInspect.destroy();
    this.hdrPresent?.compositor.destroy();
    this.hdrPresent?.tracerInspect.destroy();
    for (const pass of this.inspectPassSets.values()) pass.destroy();
    this.readback.destroy();
    this.stationaryPreview.destroy();
    this.gpuProfiler?.destroy();
    this.fallbackMaskTexture.destroy();
    this.profileLut.destroy();
  }
}
