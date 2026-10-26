import { MAIN_VIEW_MODES } from '../viewModes';
import { buildDefaultGraph, compileGraph } from '../graph';
import {
  WebGLGraphExecutor,
  type WebGLGraphEncodeParams,
  type WebGLGraphInputs,
} from '../graph/exec/WebGLGraphExecutor';
import type { RendererState } from '../types/RendererState';
import type { WebGlTextureHandle } from '../types/TextureHandle';
import {
  planStationaryPreview,
  separatedPreviewState,
  tracerWarmupState,
  type StationaryPreviewOptions,
  type StationaryPreviewResult,
} from '../stationaryPreview';
import type { WebGLProfileLut } from './WebGLProfileLut';
import { readTargetPixelsAsync } from './asyncReadback';
import { createTarget, destroyTarget, type RenderTarget } from './resources';

const EMPTY: StationaryPreviewResult = { separated: null, tracer: null };

/**
 * Stationary side previews on WebGL: frames of the default pass graph, drawn
 * by an executor of their own at 128×128 — its own pool, so the main canvas's
 * tracers are untouched — over the context's shared program cache, as
 * `StationaryPreviewRenderer` does on WebGPU.
 */
export class WebGLStationaryPreviewRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly executor: WebGLGraphExecutor;
  /** The main renderer's colour-profile LUT, already uploaded for the session. */
  private readonly profileLut: WebGLProfileLut;
  private sourceTexture: WebGlTextureHandle | null = null;
  private outputTarget: RenderTarget | null = null;

  constructor(gl: WebGL2RenderingContext, profileLut: WebGLProfileLut) {
    this.gl = gl;
    this.profileLut = profileLut;
    this.executor = new WebGLGraphExecutor(gl);
  }

  setSourceTexture(texture: WebGlTextureHandle | null): void {
    this.sourceTexture = texture;
  }

  destroy(): void {
    if (this.outputTarget) {
      destroyTarget(this.gl, this.outputTarget);
      this.outputTarget = null;
    }
    this.executor.destroy();
  }

  async render(
    state: RendererState,
    options: StationaryPreviewOptions = {},
  ): Promise<StationaryPreviewResult> {
    if (!this.sourceTexture) return EMPTY;

    const plan = planStationaryPreview(state, options);
    const { size, fps } = plan;

    this.executor.setGraph(compileGraph(buildDefaultGraph(plan.layerCount), 'webgl'));
    if (this.executor.prepare() !== null) return EMPTY;

    this.ensureOutputTarget(size);
    const preview = plan.state;
    this.profileLut.update(preview.colorProfileLut);
    const inputs: WebGLGraphInputs = {
      source: this.sourceTexture,
      profileLut: this.profileLut.texture,
      motionField: null,
    };
    const frame: Omit<WebGLGraphEncodeParams, 'state'> = {
      fps,
      layer: { width: size, height: size },
      tracer: { width: size, height: size },
      aspect: 1,
      output: { target: this.outputTarget, viewport: { x: 0, y: 0, width: size, height: size } },
    };

    this.executor.clearAccumulators();
    let separated: Uint8ClampedArray<ArrayBuffer> | null = null;
    if (plan.separated) {
      this.executor.encode(inputs, { ...frame, state: separatedPreviewState(preview) });
      separated = await this.readOutput(size);
    }

    let tracer: Uint8ClampedArray<ArrayBuffer> | null = null;
    if (plan.tracer) {
      this.executor.clearAccumulators();
      const warmup = tracerWarmupState(preview);
      for (let i = 0; i < plan.warmupFrames; i += 1) {
        this.executor.encode(inputs, { ...frame, state: warmup, composite: false });
      }
      // The warmed-up tracers, read out of the graph through the tracer view.
      this.executor.composite(inputs, {
        ...preview,
        mainViewMode: MAIN_VIEW_MODES.FULL_RES_TRACER,
        viewportQuarterZoom: false,
        viewportHalfOverlay: false,
        diagnosticsMode: false,
        tracerInspectShowLayers: false,
        tracerInspectHeatmap: false,
      }, frame.output);
      tracer = await this.readOutput(size);
    }

    return { separated, tracer };
  }

  private ensureOutputTarget(size: number): void {
    if (this.outputTarget && this.outputTarget.width === size) return;
    if (this.outputTarget) destroyTarget(this.gl, this.outputTarget);
    this.outputTarget = createTarget(this.gl, size, size);
  }

  private async readOutput(size: number): Promise<Uint8ClampedArray<ArrayBuffer> | null> {
    // A missed thumbnail is retried by the live-preview interval.
    return this.outputTarget ? readTargetPixelsAsync(this.gl, this.outputTarget, size, size) : null;
  }
}
