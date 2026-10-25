import { MAIN_VIEW_MODES } from '../viewModes';
import type { CollisionStats, RendererState } from '../types/RendererState';
import type {
  ChromashiftRenderer,
  CpuMotionField,
  ExportFrameOptions,
  ExportFrameResult,
  ExportTracerOptions,
  ExportTracerResult,
  PassGraphSlotOptions,
  RenderTiming,
} from '../types/RendererContracts';
import { EMPTY_GPU_RENDER_TIMING } from '../types/RendererContracts';
import { rendererStateValue } from '../graph/exec/uniforms';
import { DEFAULT_PER_LAYER_OPACITY } from '../../state/defaults';
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
import { buildEncodePlan, motionFieldUse, type MotionFieldUse } from '../graph/exec/plan';
import {
  WebGLGraphExecutor,
  type WebGLGraphEncodeParams,
  type WebGLGraphInputs,
} from '../graph/exec/WebGLGraphExecutor';
import type { CompiledGraph } from '../graph/types';
import type { ChromashiftTextureHandle, WebGlTextureHandle } from '../types/TextureHandle';
import { WebGLBlit } from './WebGLBlit';
import { WebGLDebugPasses } from './WebGLDebugPasses';
import { WebGLMotionField } from './WebGLMotionField';
import { WebGLProfileLut } from './WebGLProfileLut';
import { WebGLReadback } from './WebGLReadback';
import { WebGLStationaryPreviewRenderer } from './WebGLStationaryPreviewRenderer';
import {
  createWebglScaleController,
  stepWebglInternalScale,
  type WebglScaleController,
} from './internalScale';
import { createTarget, destroyTarget, type RenderTarget } from './resources';
import type { StationaryPreviewOptions, StationaryPreviewResult } from '../stationaryPreview';
import type { WebGLRenderViewport } from './types';
import { publishDiagnostic, publishDiagnostics } from '../diagnostics';
import { webglInternalFormatNote } from '../gpuOptions';

export type { WebGLRenderViewport } from './types';

/**
 * What a slot draws until the orchestrator hands it the session's source, and
 * what a selected shape draws at a variant it refuses.
 */
const DEFAULT_GRAPH_SOURCE = presetGraphSource('default');

/** A frame whose graph reads no motion field and solves no flow. */
const NO_MOTION_FIELD_USE: MotionFieldUse = { reads: false, needsFlow: false };

/** A compiled variant and where it came from, for the breadcrumbs. */
interface VariantOrigin {
  /** The shape it is a variant of — the session's, or `default` standing in for it. */
  readonly name: GraphPresetName;
  readonly key: string;
}

/**
 * WebGLRenderer — the WebGL2 diagnostic / XR / screenshot backend.
 *
 * Every frame is a variant of the session's pass graph, drawn by
 * `WebGLGraphExecutor` exactly as the WebGPU renderer draws it with its own
 * executor (docs/PASS_GRAPH.md): the same compiled graph, the same encode
 * plan, the same uniforms. A variant that will not compile, plan or link is
 * refused by name, and that variant draws the default graph. The debug views
 * (`webglDebugMode`) are not graph nodes; they replace the band layers'
 * program for inspection.
 */
export class WebGLRenderer implements ChromashiftRenderer {
  readonly backend = 'webgl' as const;

  private readonly gl: WebGL2RenderingContext;
  private readonly canvas: HTMLCanvasElement;
  private readonly debugPasses: WebGLDebugPasses;
  private readonly profileLut: WebGLProfileLut;
  private readonly motionField: WebGLMotionField;
  private readonly readback: WebGLReadback;
  private readonly blit: WebGLBlit;
  private readonly stationaryPreview: WebGLStationaryPreviewRenderer;
  private readonly scaleController: WebglScaleController = createWebglScaleController();
  private compositeTarget: RenderTarget | null = null;
  private currentTexture: WebGlTextureHandle | null = null;
  private lastCpuMs = 0;
  private avgCpuMs = 0;
  /** Previous on-screen frame's main-thread time, fed into the scale controller. */
  private pendingElapsedMs: number | null = null;

  /** The pass-graph executor: it draws every frame. */
  private readonly graphExecutor: WebGLGraphExecutor;
  private graphSource: PassGraphSource = DEFAULT_GRAPH_SOURCE;
  /**
   * The source's variants compiled so far, by `graphVariantKey` — or, for one
   * that will not compile, plan or link, the refusal it produced. Remembered
   * either way, so a frame never compiles twice and a refusal is not retried.
   */
  private readonly graphVariants = new Map<string, CompiledGraph | string>();
  /** The default graph's variants, standing in for ones the source refused. */
  private readonly defaultVariants = new Map<string, CompiledGraph | string>();
  private readonly variantOrigins = new WeakMap<CompiledGraph, VariantOrigin>();
  /** `motionFieldUse` per compiled graph — asked every frame, computed once. */
  private readonly fieldUseByGraph = new WeakMap<CompiledGraph, MotionFieldUse>();
  /** The variant the executor targets right now. */
  private adoptedGraph: CompiledGraph | null = null;
  /** What the last frame drew; `undefined` until the first frame publishes it. */
  private drawnGraph: CompiledGraph | null | undefined = undefined;
  private graphSlot = 'main';
  private graphPrimary = true;
  /** The last frame's layer count, for `cpuMotionFieldUse`. */
  private lastLayerCount = DEFAULT_LAYER_COUNT;

  constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.canvas = canvas;
    this.gl = gl;
    this.debugPasses = new WebGLDebugPasses(gl);
    this.profileLut = new WebGLProfileLut(gl);
    this.motionField = new WebGLMotionField(gl);
    this.readback = new WebGLReadback(gl);
    this.blit = new WebGLBlit(gl);
    this.graphExecutor = new WebGLGraphExecutor(gl);
    this.stationaryPreview = new WebGLStationaryPreviewRenderer(gl, this.profileLut);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
  }

  setTexture(handle: ChromashiftTextureHandle): void {
    if (handle.backend !== 'webgl') {
      throw new Error(`Expected a webgl texture handle, received ${handle.backend}.`);
    }
    this.currentTexture = handle;
    this.stationaryPreview.setSourceTexture(handle);
    this.clearPersistence();
  }

  setClassificationMaskTexture(texture: GPUTexture | null): void {
    void texture;
    // WebGL fallback intentionally derives masks in GLSL from the shared source image.
  }

  /**
   * MSAA 4x: the band layers render into a `samples: 4` renderbuffer and blit
   * into their layer targets, as WebGPU's band-layer pipelines multisample.
   * Persistence and the compositor stay 1×. Same context, same programs — the
   * next frame reallocates the renderbuffer.
   */
  setAntialiasing(enabled: boolean): void {
    this.graphExecutor.setSampleCount(enabled ? 4 : 1);
  }

  clearPersistence(): void {
    this.graphExecutor.clearAccumulators();
  }

  /**
   * Hand the diagnostic backend the latest motion field (the CPU lanes'
   * output; see `useLiveSource`). `null` drops it, which returns the frame to
   * the pre-motion variant and a `displace` to the identity.
   */
  setMotionField(motion: CpuMotionField | null): void {
    this.motionField.set(motion);
  }

  /**
   * What the graph needs of the CPU motion field beyond the temporal term: a
   * `displace` steered by it reads the field — and its flow — whatever the
   * motion mode, so the live-source sampler must produce one for it.
   */
  cpuMotionFieldUse(): MotionFieldUse {
    return this.graphFieldUse(this.lastLayerCount);
  }

  /**
   * Adopt a pass-graph source — `null` for the default graph. Each frame asks
   * it for the variant it needs (the layer count, the temporal term) and the
   * executor draws that.
   */
  setPassGraph(source: PassGraphSource | null, options?: PassGraphSlotOptions): void {
    if (options) {
      this.graphSlot = options.slot;
      this.graphPrimary = options.primary;
    }
    if (this.graphPrimary) {
      const format = this.graphExecutor.internalFormat;
      publishDiagnostics({ webglInternalFormat: format, webglInternalFormatNote: webglInternalFormatNote(format) });
    }
    this.graphSource = source ?? DEFAULT_GRAPH_SOURCE;
    this.graphVariants.clear();
    this.adoptedGraph = null;
    // Republish what this slot draws under its (possibly new) name.
    this.drawnGraph = undefined;
    this.adoptGraphVariant({ layerCount: DEFAULT_LAYER_COUNT, motion: false, presentation: 'sdr' });
  }

  /** Name of the graph shape this renderer draws. */
  get passGraphName(): GraphPresetName {
    return this.graphSource.name;
  }

  async renderStationaryPreviews(
    state: RendererState,
    options?: StationaryPreviewOptions,
  ): Promise<StationaryPreviewResult> {
    return this.stationaryPreview.render(state, options);
  }

  requestCollisionStats(callback: (stats: CollisionStats) => void): boolean {
    return this.readback.requestCollisionStats(callback);
  }

  getRenderTiming(): RenderTiming {
    return {
      lastCpuMs: this.lastCpuMs,
      averageCpuMs: this.avgCpuMs,
      gpu: EMPTY_GPU_RENDER_TIMING,
    };
  }

  render(state: RendererState, fps = 30, viewport?: WebGLRenderViewport): void {
    if (!this.currentTexture) return;
    const start = performance.now();
    const canvasW = Math.max(1, this.canvas.width);
    const canvasH = Math.max(1, this.canvas.height);
    const destW = viewport?.width ?? canvasW;
    const destH = viewport?.height ?? canvasH;
    // An explicit viewport (WebXR) is already the draw size. The on-screen
    // canvas applies the internal budget plus the layer/tracer scale sliders.
    const contentScale = viewport
      ? 1
      : stepWebglInternalScale(
          this.scaleController,
          canvasW,
          canvasH,
          this.pendingElapsedMs,
          1000 / Math.max(1, fps),
        );
    if (!viewport) publishWebglInternalScale(contentScale);
    const internalW = Math.max(1, Math.round(destW * contentScale));
    const internalH = Math.max(1, Math.round(destH * contentScale));
    const layerScale = viewport ? 1 : rendererStateValue(state, 'layerScale');
    const tracerScale = viewport ? 1 : rendererStateValue(state, 'tracerScale');
    const upsample = !viewport && (internalW !== canvasW || internalH !== canvasH);
    const compositeTarget = upsample ? this.ensureCompositeTarget(internalW, internalH) : null;
    const drew = this.renderFrameInternal(state, fps, {
      layer: scaled(internalW, internalH, layerScale),
      tracer: scaled(internalW, internalH, tracerScale),
      aspect: internalW / internalH,
      output: {
        target: compositeTarget,
        framebuffer: viewport?.framebuffer ?? null,
        viewport: upsample || !viewport
          ? { x: 0, y: 0, width: upsample ? internalW : destW, height: upsample ? internalH : destH }
          : viewport,
      },
    });
    if (drew && upsample && compositeTarget) {
      this.blit.draw(compositeTarget.texture, canvasW, canvasH);
    }
    if (!viewport) {
      this.readback.afterFrame((target, size) => this.graphExecutor.composite(this.inputs(), {
        ...state,
        mainViewMode: MAIN_VIEW_MODES.COINCIDENCE_HEATMAP,
      }, { target, viewport: { x: 0, y: 0, width: size, height: size } }));
    }
    // Hand the queued passes to the GPU every frame. Leaving them buffered
    // makes the next pixel read (preview, export) execute the whole backlog
    // on the main thread in one hitch.
    this.gl.flush();
    const elapsed = performance.now() - start;
    this.lastCpuMs = elapsed;
    this.avgCpuMs = this.avgCpuMs === 0 ? elapsed : this.avgCpuMs * 0.9 + elapsed * 0.1;
    if (!viewport) this.pendingElapsedMs = elapsed;
  }

  restoreRenderSize(): void {
    // The executor's pool sizes itself from the next frame's targets.
  }

  async exportFrame(state: RendererState, options: ExportFrameOptions): Promise<ExportFrameResult | null> {
    if (!this.currentTexture) return null;

    const width = Math.max(1, Math.floor(options.width));
    const height = Math.max(1, Math.floor(options.height));
    const fps = options.fps ?? 30;
    const passMode = options.passMode ?? 'composite';

    const exportState: RendererState = {
      ...state,
      viewportQuarterZoom: false,
      viewportHalfOverlay: false,
      diagnosticsMode: false,
      mainViewMode: passMode === 'tracers'
        ? MAIN_VIEW_MODES.FULL_RES_TRACER
        : MAIN_VIEW_MODES.PROCESSED_COMPOSITE,
      ...(passMode === 'layers'
        ? { tracerAboveIntensity: 0, tracerBelowIntensity: 0 }
        : {}),
    };

    const target = createTarget(this.gl, width, height);
    try {
      this.renderFrameInternal(exportState, fps, {
        layer: { width, height },
        tracer: { width, height },
        aspect: width / height,
        output: { target, viewport: { x: 0, y: 0, width, height } },
      });
      const pixels = await this.readback.readTexturePixelsAsync(target, width, height)
        ?? this.readback.readTexturePixels(target, width, height);
      return { data: pixels, width, height };
    } finally {
      destroyTarget(this.gl, target);
    }
  }

  async exportTracerView(options: ExportTracerOptions): Promise<ExportTracerResult | null> {
    if (!this.currentTexture) return null;
    const layerCount = this.graphExecutor.outputTargets()?.layers.length ?? DEFAULT_LAYER_COUNT;
    const state: RendererState = {
      layers: Array.from({ length: layerCount }, (_, i) => ({ angleDeg: 0, ...(i === 1 ? { flipY: true } : {}) })),
      avgLuminance: 128,
      mainViewMode: MAIN_VIEW_MODES.FULL_RES_TRACER,
      tracerAboveIntensity: options.tracerAboveOpacity,
      tracerBelowIntensity: options.tracerBelowOpacity,
      tracerBlendMode: options.tracerBlendMode,
      layerBlendMode: options.layerBlendMode,
      layerOpacities: Array.from(
        { length: layerCount },
        (_, i) => options.layerOpacities?.[i] ?? DEFAULT_PER_LAYER_OPACITY,
      ),
    };
    const target = createTarget(this.gl, options.width, options.height);
    try {
      const drew = this.graphExecutor.composite(this.inputs(), state, {
        target,
        viewport: { x: 0, y: 0, width: options.width, height: options.height },
      });
      if (!drew) return null;
      const pixels = await this.readback.readTexturePixelsAsync(target, options.width, options.height)
        ?? this.readback.readTexturePixels(target, options.width, options.height);
      return { data: pixels, width: options.width, height: options.height };
    } finally {
      destroyTarget(this.gl, target);
    }
  }

  destroy(): void {
    if (this.compositeTarget) {
      destroyTarget(this.gl, this.compositeTarget);
      this.compositeTarget = null;
    }
    publishSlotExecuting(this.graphSlot, undefined);
    this.readback.destroy();
    this.blit.destroy();
    this.stationaryPreview.destroy();
    this.graphExecutor.destroy();
    this.motionField.destroy();
    this.profileLut.destroy();
    this.debugPasses.destroy();
  }

  // ─── graph variants ───────────────────────────────────────────────────────

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
        entry = compileGraph(source.build(variant), 'webgl');
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
   * Make `variant` the executor's target if it is not already, and link its
   * programs. A program the context rejects is an `invalid-pipeline` refusal:
   * that variant then draws the default graph, and until a frame adopts the
   * stand-in the executor keeps drawing the last frame that linked.
   */
  private adoptGraphVariant(variant: GraphVariant): CompiledGraph | null {
    const compiled = this.compiledGraphVariant(variant);
    if (compiled === this.adoptedGraph) return compiled;
    this.graphExecutor.setGraph(compiled);
    this.adoptedGraph = compiled;
    if (!compiled) return null;
    if (this.graphPrimary) {
      // A stand-in default keeps the source's refusal on the breadcrumb.
      const key = graphVariantKey(variant);
      const own = this.graphVariants.get(key);
      publishGraphVariant(compiled, typeof own === 'string' ? own : null, this.graphSource.name, key);
    }
    const error = this.graphExecutor.prepare();
    if (error === null) return compiled;
    this.refuseVariant(compiled, `invalid-pipeline: ${error}`);
    // The refused entry is a string now, so this adopts its stand-in (or nothing).
    return this.adoptGraphVariant(variant);
  }

  /** Remember `compiled`'s variant as refused, so the frame adopts its stand-in. */
  private refuseVariant(compiled: CompiledGraph, message: string): void {
    console.warn('[Chromashift:PassGraph] the context rejected a graph variant —', message);
    for (const cache of [this.graphVariants, this.defaultVariants]) {
      for (const [key, entry] of cache) {
        if (entry === compiled) cache.set(key, message);
      }
    }
    if (this.adoptedGraph === compiled) this.adoptedGraph = null;
    if (this.graphPrimary) publishDiagnostic('passGraphError', message);
  }

  /** What this renderer drew: into its slot's entry, and session-wide from the primary canvas. */
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

  /** How the source's still graph reads the motion field — a `displace` steered by it, say. */
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

  // ─── frames ───────────────────────────────────────────────────────────────

  private inputs(): WebGLGraphInputs {
    const source = this.currentTexture!;
    return {
      source: { texture: source.texture, width: source.width, height: source.height },
      profileLut: this.profileLut.texture,
      motionField: this.motionField.texture,
    };
  }

  private ensureCompositeTarget(width: number, height: number): RenderTarget {
    if (this.compositeTarget
      && this.compositeTarget.width === width
      && this.compositeTarget.height === height) {
      return this.compositeTarget;
    }
    if (this.compositeTarget) destroyTarget(this.gl, this.compositeTarget);
    this.compositeTarget = createTarget(this.gl, width, height);
    return this.compositeTarget;
  }

  /** Draw one frame of the variant `state` needs. Returns whether anything validated drew it. */
  private renderFrameInternal(
    state: RendererState,
    fps: number,
    frame: Omit<WebGLGraphEncodeParams, 'state' | 'fps' | 'drawLayer'>,
  ): boolean {
    if (!this.currentTexture) return false;
    // Non-classic colour profiles render from the baked LUT (docs/COLOR_PROFILES.md).
    this.profileLut.update(state.colorProfileLut);

    const layerCount = Math.max(1, Math.min(MAX_LAYER_COUNT, state.layers.length));
    this.lastLayerCount = layerCount;
    const motionMode = rendererStateValue(state, 'motionMode');
    this.adoptGraphVariant({
      layerCount,
      motion: motionMode !== 0 && this.motionField.texture !== null,
      presentation: 'sdr',
    });
    const ready = this.graphExecutor.readyFrame();
    this.publishDrawn(ready?.compiled ?? null);
    if (!ready) {
      // Nothing linked can draw this frame: black, rather than a half-bound pass.
      const gl = this.gl;
      const { viewport } = frame.output;
      gl.bindFramebuffer(gl.FRAMEBUFFER, frame.output.target?.framebuffer ?? frame.output.framebuffer ?? null);
      gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return false;
    }

    const debugMode = state.webglDebugMode ?? 0;
    this.graphExecutor.encode(this.inputs(), {
      ...frame,
      state,
      fps,
      drawLayer: debugMode === 0
        ? undefined
        : (layerIndex, source) => {
            this.debugPasses.renderLayer(debugMode, source, state, layerIndex, frame.aspect);
            return true;
          },
    }, ready);
    return true;
  }
}

const scaled = (width: number, height: number, scale: number) => ({
  width: Math.max(1, Math.round(width * scale)),
  height: Math.max(1, Math.round(height * scale)),
});

function publishWebglInternalScale(scale: number): void {
  publishDiagnostic('webglInternalScale', scale);
}
