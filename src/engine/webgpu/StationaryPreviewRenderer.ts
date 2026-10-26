import { ProfileLutTexture } from '../color/ProfileLutTexture';
import { GpuReadback } from './GpuReadback';
import { buildDefaultGraph, compileGraph } from '../graph';
import { WebGpuGraphExecutor, type GraphExternalInputs } from '../graph/exec/WebGpuGraphExecutor';
import { tracerInspectSettings } from '../graph/exec/uniforms';
import {
  planStationaryPreview,
  separatedPreviewState,
  tracerWarmupState,
  type StationaryPreviewOptions,
  type StationaryPreviewResult,
} from '../stationaryPreview';
import type { TracerInspectPass } from './TracerInspectPass';
import type { RendererState } from '../types/RendererState';
import type { WebGPUPipelines } from './WebGPUPipelines';

const EMPTY: StationaryPreviewResult = { separated: null, tracer: null };

/**
 * Isolated 128×128 GPU path for side-preview thumbnails at preset angles.
 * Does not read or write the main canvas layer/tracer textures.
 *
 * The thumbnails are frames of the default pass graph, drawn by an executor of
 * their own at the session's layer count — so a seven-layer session previews
 * seven bands, where these used to be three hand-encoded passes. *Separated*
 * is the composite with its tracers hidden; *Tracer* warms the accumulators
 * up at the preset angles and reads them out through the tracer view.
 */
export class StationaryPreviewRenderer {
  private readonly device: GPUDevice;
  private readonly outputFormat: GPUTextureFormat;
  private readonly executor: WebGpuGraphExecutor;
  /** The SDR tracer-view pass for a frame of `n` layers — shared with the renderer. */
  /** The renderer's inspect passes, once compiled; `null` if the device refused them. */
  private readonly tracerInspectFor: (layerCount: number) => Promise<TracerInspectPass | null>;
  private readonly readback: GpuReadback;
  private outputTexture: GPUTexture | null = null;
  private sourceTexture: GPUTexture | null = null;
  private maskTexture: GPUTexture | null = null;
  private readonly fallbackMaskTexture: GPUTexture;
  private readonly profileLut: ProfileLutTexture;
  private destroyed = false;

  constructor(
    device: GPUDevice,
    pipelines: WebGPUPipelines,
    internalFormat: GPUTextureFormat,
    outputFormat: GPUTextureFormat,
    sampler: GPUSampler,
    tracerInspectFor: (layerCount: number) => Promise<TracerInspectPass | null>,
  ) {
    this.device = device;
    this.outputFormat = outputFormat;
    this.tracerInspectFor = tracerInspectFor;

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
    // One sampler for the bands and the passes reading them, as the hand-encoded
    // thumbnails used.
    this.executor = new WebGpuGraphExecutor(device, internalFormat, outputFormat, sampler, sampler);
    this.readback = new GpuReadback(device, outputFormat, pipelines);
  }

  setSourceTexture(texture: GPUTexture | null): void {
    this.sourceTexture = texture;
  }

  setMaskTexture(texture: GPUTexture | null): void {
    this.maskTexture = texture;
  }

  destroy(): void {
    this.destroyed = true;
    this.executor.destroy();
    this.outputTexture?.destroy();
    this.fallbackMaskTexture.destroy();
    this.profileLut.destroy();
    this.readback.destroy();
  }

  async render(
    state: RendererState,
    options: StationaryPreviewOptions = {},
  ): Promise<StationaryPreviewResult> {
    if (!this.sourceTexture) return EMPTY;

    const plan = planStationaryPreview(state, options);
    const { size, fps } = plan;

    // Validated before the first encode, as the main canvas's graph is: an
    // invalid pipeline would drop the whole command buffer, not just a pass.
    this.executor.setGraph(compileGraph(buildDefaultGraph(plan.layerCount), 'webgpu'));
    const verdict = await this.executor.prepare();
    if (verdict !== null || this.destroyed || !this.sourceTexture) return EMPTY;

    this.ensureOutput(size);
    const preview = plan.state;

    const separated = plan.separated
      ? await this.renderSeparated(preview, this.inputs(preview), size, fps)
      : null;

    let tracer: Uint8ClampedArray<ArrayBuffer> | null = null;
    // Inputs are read again after the readback await: a new image or mask may
    // have landed meanwhile, and its predecessor been destroyed — submitting
    // a bind group that holds it is a validation error, every warmup frame.
    if (plan.tracer && !this.destroyed && this.sourceTexture) {
      const inputs = this.inputs(preview);
      this.executor.clearAccumulators();
      // No motion field is bound, so the temporal term is off.
      const warmup = tracerWarmupState(preview);
      for (let frame = 0; frame < plan.warmupFrames; frame += 1) {
        const enc = this.device.createCommandEncoder();
        this.executor.encode(enc, inputs, {
          state: warmup,
          outputView: this.outputTexture!.createView(),
          width: size,
          height: size,
          fps,
          composite: false,
        });
        this.device.queue.submit([enc.finish()]);
      }
      tracer = await this.renderTracer(preview, size);
    }

    return { separated, tracer };
  }

  private inputs(state: RendererState): GraphExternalInputs {
    // Non-classic colour profiles render from the baked LUT (docs/COLOR_PROFILES.md).
    this.profileLut.update(state.colorProfileLut);
    return {
      source: this.sourceTexture!,
      classificationMask: this.maskTexture ?? this.fallbackMaskTexture,
      hasClassificationMask: this.maskTexture !== null,
      profileLut: this.profileLut.texture,
      motionField: null,
    };
  }

  private ensureOutput(size: number): void {
    if (this.outputTexture?.width === size) return;
    this.outputTexture?.destroy();
    this.outputTexture = this.device.createTexture({
      size: [size, size, 1],
      format: this.outputFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
  }

  /** The bands alone (see `separatedPreviewState`). */
  private async renderSeparated(
    state: RendererState,
    inputs: GraphExternalInputs,
    size: number,
    fps: number,
  ): Promise<Uint8ClampedArray<ArrayBuffer> | null> {
    const enc = this.device.createCommandEncoder();
    this.executor.encode(enc, inputs, {
      state: separatedPreviewState(state),
      outputView: this.outputTexture!.createView(),
      width: size,
      height: size,
      fps,
    });
    this.device.queue.submit([enc.finish()]);

    const result = await this.readback.readTexturePixels(this.outputTexture!, size, size);
    return result?.data ?? null;
  }

  /** The warmed-up tracers, read out of the graph through the tracer view. */
  private async renderTracer(
    state: RendererState,
    size: number,
  ): Promise<Uint8ClampedArray<ArrayBuffer> | null> {
    const outputs = this.executor.outputTextures();
    if (!outputs) return null;
    const inspect = await this.tracerInspectFor(outputs.layers.length);
    if (!inspect || this.destroyed) return null;
    const enc = this.device.createCommandEncoder();
    inspect.encodeTracerView(
      enc,
      this.outputTexture!.createView(),
      {
        // The thumbnail is the whole tracer, untoned: none of the inspect
        // view's zoom, pan, heatmap or exposure settings apply to it.
        ...tracerInspectSettings(state),
        canvasWidth: size,
        canvasHeight: size,
        inspectZoom: 1,
        inspectPanX: 0,
        inspectPanY: 0,
        showHeatmap: false,
        exposure: 1,
        applyTonemap: false,
        showLayers: false,
      },
      {
        layerTextures: outputs.layers,
        persistAbove: outputs.tracerAbove,
        persistBelow: outputs.tracerBelow,
        pingPong: outputs.pingPong,
      },
    );
    this.device.queue.submit([enc.finish()]);

    const result = await this.readback.readTexturePixels(this.outputTexture!, size, size);
    return result?.data ?? null;
  }
}
