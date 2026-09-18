/**
 * `gpu-chores` — WebGPU compute lane.
 *
 * Extracted from `GpuImageAnalysis.ts` without behavioral change: same two
 * passes, same bind group layouts, same `@workgroup_size(8, 8)`, same
 * 256-entry histogram readback, same reused mask texture.
 *
 * Device policy: this lane **adopts** a `GPUDevice` handed to it by the
 * renderer. It must never call `requestAdapter`/`requestDevice` — a second
 * device is the exact regression the kit is meant to make impossible.
 */

import {
  canAnalyzeTexture,
  detectGpuComputeSupport,
  isSrgbTextureFormat,
  type GpuComputeSupport,
} from './support';
import {
  CLASSIFICATION_COMPUTE_SHADER,
  COINCIDENCE_COMPUTE_SHADER,
  HISTOGRAM_COMPUTE_SHADER,
  MOTION_FIELD_COMPUTE_SHADER,
} from './kernels';
import { EMPTY_MOTION_FIELD_STATS, motionFieldSize, type MotionFieldStats } from './motionKernel';
import { layerTextureEntries, sameLayerTextures, type LayerTextures } from '../../BindGroupCache';
import { CANONICAL_LAYER_COUNT } from '../../graph/layerSpecs';
import { emitCoincidenceComputeWgsl } from '../../graph/templates/wgsl';
import type {
  ChoreBackendImpl,
  ChoreJob,
  ChoreOutput,
  CoincidenceJob,
  GpuCoincidenceOutput,
  GpuImageAnalysisOutput,
  GpuMotionFieldOutput,
  ImageAnalysisJob,
  MotionFieldJob,
} from './types';

/** Per-frame parameters the motion-field compute pass needs, minus geometry. */
export interface MotionFieldEncodeParams {
  /** Resolution divisor; the field is `ceil(width / divisor)` wide. */
  divisor: number;
  /** Noise floor on the normalised luminance difference, in [0,1). */
  threshold: number;
  /** Drop the previous-frame history (source switch, seek, resize). */
  reset: boolean;
}

/** Per-pixel parameters the coincidence compute pass needs, minus geometry. */
export interface CoincidenceEncodeParams {
  colorThresh: number;
  stampBoost: number;
  tracerMode: number;
}

interface CoincidenceBindGroupCacheEntry {
  bindGroup: GPUBindGroup | null;
  layers: LayerTextures | null;
  stampTexture: GPUTexture | null;
  diagTexture: GPUTexture | null;
}

/** Drop every cached bind group — the layout they were built against is gone. */
function invalidateCoincidenceCache(entries: readonly CoincidenceBindGroupCacheEntry[]): void {
  for (const entry of entries) {
    entry.bindGroup = null;
    entry.layers = null;
    entry.stampTexture = null;
    entry.diagTexture = null;
  }
}

/** 2D image passes stay at 8×8; 64 invocations fits every conformant device. */
const WORKGROUP_SIZE = 8;

const HISTOGRAM_BINS = 256;
const HISTOGRAM_BYTES = HISTOGRAM_BINS * 4;

export function averageFromHistogram(histogram: Uint32Array): number {
  let sum = 0;
  let count = 0;
  for (let bucket = 0; bucket < HISTOGRAM_BINS; bucket += 1) {
    const n = histogram[bucket];
    sum += bucket * n;
    count += n;
  }
  return count === 0 ? 128 : sum / count;
}

/**
 * Break-even note: the GPU lane wins on large images (4K–8K), where the two
 * compute passes dwarf the fixed cost of pipeline setup plus the one 1 KiB
 * histogram map. Small stills are dominated by that fixed cost and by
 * `mapAsync` latency, so they are generally no faster than the WASM lane —
 * they are still routed here when a GPU texture already exists, because the
 * alternative is a CPU decode of an image the GPU is already holding.
 * Revisit with a microbench before adding a resolution floor.
 */
export class WebGpuChoreBackend implements ChoreBackendImpl {
  readonly backend = 'webgpu' as const;

  private readonly device: GPUDevice;
  readonly support: GpuComputeSupport;

  private histogramPipeline: GPUComputePipeline | null = null;
  private classificationPipeline: GPUComputePipeline | null = null;
  private histogramBGL: GPUBindGroupLayout | null = null;
  private classificationBGL: GPUBindGroupLayout | null = null;
  private histogramBuffer: GPUBuffer | null = null;
  private histogramUniformBuffer: GPUBuffer | null = null;
  private maskUniformBuffer: GPUBuffer | null = null;
  private histogramStagingBuffer: GPUBuffer | null = null;

  private cachedMaskTexture: GPUTexture | null = null;
  private cachedMaskWidth = 0;
  private cachedMaskHeight = 0;
  /** Serializes overlapping analyze() calls that share staging buffers. */
  private analyzeChain: Promise<unknown> = Promise.resolve();

  private motionPipeline: GPUComputePipeline | null = null;
  private motionBGL: GPUBindGroupLayout | null = null;
  private motionUniformBuffer: GPUBuffer | null = null;
  private motionStatsBuffer: GPUBuffer | null = null;
  private motionStatsStagingBuffer: GPUBuffer | null = null;
  private motionFieldTexture: GPUTexture | null = null;
  /** Ping-ponged previous/next luminance history — one float per field cell. */
  private motionLumTextures: [GPUTexture | null, GPUTexture | null] = [null, null];
  private motionLumSlot: 0 | 1 = 0;
  private motionFieldWidth = 0;
  private motionFieldHeight = 0;
  private motionSourceWidth = 0;
  private motionSourceHeight = 0;
  private motionHistoryValid = false;
  private motionBindGroups: [GPUBindGroup | null, GPUBindGroup | null] = [null, null];
  private motionBindGroupSource: GPUTexture | null = null;
  private motionStatsMapPending = false;
  private lastMotionStats: MotionFieldStats = EMPTY_MOTION_FIELD_STATS;

  private coincidencePipeline: GPUComputePipeline | null = null;
  /** Layer count `coincidencePipeline` was emitted and laid out for. */
  private coincidenceLayerCount = 0;
  private coincidenceBGL: GPUBindGroupLayout | null = null;
  private coincidenceUniformBuffer: GPUBuffer | null = null;
  private cachedStampTexture: GPUTexture | null = null;
  private cachedDiagTexture: GPUTexture | null = null;
  private cachedCoincidenceWidth = 0;
  private cachedCoincidenceHeight = 0;
  /**
   * Two slots so a caller ping-ponging its output texture (as `PersistencePass`
   * does for its diagnostic texture) still gets a cache hit every frame
   * instead of a fresh bind group — and the 5 texture views inside it —
   * every single call. `cacheSlot` in `encodeCoincidenceInto()` selects which.
   */
  private readonly coincidenceBindGroupCache: [CoincidenceBindGroupCacheEntry, CoincidenceBindGroupCacheEntry] = [
    { bindGroup: null, layers: null, stampTexture: null, diagTexture: null },
    { bindGroup: null, layers: null, stampTexture: null, diagTexture: null },
  ];

  constructor(device: GPUDevice) {
    this.device = device;
    this.support = detectGpuComputeSupport(device);
  }

  isSupported(): boolean {
    return this.support.available;
  }

  canAnalyze(width: number, height: number): boolean {
    return canAnalyzeTexture(this.support, width, height);
  }

  canRun(job: ChoreJob): boolean {
    if (job.op === 'coincidence') {
      return Boolean(job.layers) && this.canAnalyze(job.width, job.height);
    }
    if (!job.source) return false;
    return this.canAnalyze(job.width, job.height);
  }

  declineReason(job: ChoreJob): string {
    if (!this.support.available) return this.support.reason ?? 'WebGPU compute unavailable';
    if (job.op === 'coincidence') {
      if (!job.layers) return 'No GPU-resident layer textures';
      return `Coincidence buffer ${job.width}×${job.height} exceeds maxTextureDimension2D `
        + `(${this.support.maxTextureDimension2D})`;
    }
    if (job.op === 'motion-field') {
      if (!job.source) return 'No GPU-resident source frame';
      return `Motion source ${job.width}×${job.height} exceeds maxTextureDimension2D `
        + `(${this.support.maxTextureDimension2D})`;
    }
    if (!job.source) return 'No GPU-resident source texture';
    return `Image ${job.width}×${job.height} exceeds maxTextureDimension2D `
      + `(${this.support.maxTextureDimension2D})`;
  }

  async run(job: ChoreJob): Promise<ChoreOutput | null> {
    if (!this.canRun(job)) return null;
    if (job.op === 'coincidence') {
      return this.runCoincidence(job);
    }
    if (job.op === 'motion-field') {
      return this.runMotionField(job);
    }
    const analysisJob = job as ImageAnalysisJob;
    return this.analyze(analysisJob.source!, analysisJob.width, analysisJob.height, analysisJob.avgLumHint);
  }

  /**
   * One-shot coincidence job for the async kit facade (sibling apps, tests).
   * Chromashift's own per-frame render loop calls `encodeCoincidence()`
   * directly instead, to stay inside the same `GPUCommandEncoder` as the
   * rest of the frame rather than paying for an extra queue submission.
   */
  private async runCoincidence(job: CoincidenceJob): Promise<GpuCoincidenceOutput | null> {
    const layers = job.layers;
    if (!layers) return null;
    this.ensureCoincidencePipeline(layers.length);
    const stampTexture = this.ensureCoincidenceTextures(job.width, job.height);
    const diagTexture = this.cachedDiagTexture!;

    const enc = this.device.createCommandEncoder();
    this.dispatchCoincidence(enc, layers, stampTexture, diagTexture, job.width, job.height, {
      colorThresh: job.colorThresh,
      stampBoost: job.stampBoost,
      tracerMode: job.tracerMode,
    }, 0);
    this.device.queue.submit([enc.finish()]);
    return { kind: 'gpu-coincidence', stampTexture, diagTexture };
  }

  /**
   * Encode the coincidence compute pass into a caller-owned encoder and
   * caller-owned output textures — no submit, no internal texture caching.
   * This is what `PersistencePass` calls directly: it already owns a
   * ping-ponged diagnostic texture pair and a reused stamp texture, and it
   * wants the compute dispatch inside the same command buffer as the
   * composite/decay draws that immediately follow it, not a separate queue
   * submission.
   *
   * `cacheSlot` picks which of the two bind-group cache entries to check —
   * pass the same ping-pong index the caller uses for its own output
   * texture (e.g. `writeIdx`) so a stable set of inputs still hits the
   * cache every frame instead of allocating a fresh bind group (and 5 new
   * texture views) on every single call.
   */
  encodeCoincidenceInto(
    enc: GPUCommandEncoder,
    layers: LayerTextures,
    stampTexture: GPUTexture,
    diagTexture: GPUTexture,
    width: number,
    height: number,
    params: CoincidenceEncodeParams,
    cacheSlot: 0 | 1 = 0,
  ): void {
    this.ensureCoincidencePipeline(layers.length);
    this.dispatchCoincidence(enc, layers, stampTexture, diagTexture, width, height, params, cacheSlot);
  }

  private dispatchCoincidence(
    enc: GPUCommandEncoder,
    layers: LayerTextures,
    stampTexture: GPUTexture,
    diagTexture: GPUTexture,
    width: number,
    height: number,
    params: CoincidenceEncodeParams,
    cacheSlot: 0 | 1,
  ): void {
    const uniformData = new ArrayBuffer(32);
    const uniformU32 = new Uint32Array(uniformData);
    const uniformF32 = new Float32Array(uniformData);
    uniformU32[0] = width;
    uniformU32[1] = height;
    uniformU32[2] = params.tracerMode;
    uniformF32[4] = params.colorThresh;
    uniformF32[5] = params.stampBoost;
    this.device.queue.writeBuffer(this.coincidenceUniformBuffer!, 0, uniformData);

    const cache = this.coincidenceBindGroupCache[cacheSlot];
    let bindGroup: GPUBindGroup;
    const n = layers.length;
    if (
      cache.bindGroup
      && sameLayerTextures(cache.layers, layers)
      && cache.stampTexture === stampTexture && cache.diagTexture === diagTexture
    ) {
      bindGroup = cache.bindGroup;
    } else {
      bindGroup = this.device.createBindGroup({
        layout: this.coincidenceBGL!,
        entries: [
          ...layerTextureEntries(0, layers),
          { binding: n, resource: stampTexture.createView() },
          { binding: n + 1, resource: diagTexture.createView() },
          { binding: n + 2, resource: { buffer: this.coincidenceUniformBuffer! } },
        ],
      });
      cache.bindGroup = bindGroup;
      cache.layers = [...layers];
      cache.stampTexture = stampTexture;
      cache.diagTexture = diagTexture;
    }

    const pass = enc.beginComputePass();
    pass.setPipeline(this.coincidencePipeline!);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(
      Math.ceil(width / WORKGROUP_SIZE),
      Math.ceil(height / WORKGROUP_SIZE),
    );
    pass.end();
  }

  /**
   * Build the coincidence pipeline for `layerCount` inputs.
   *
   * The kernel is emitted per layer count (the shipped three-layer text is the
   * golden, not the implementation), so a session that changes its count gets a
   * new module and layout rather than a layout that no longer matches its
   * shader. The previous pipeline is simply dropped — this happens on a
   * user-visible layer-count change, never per frame.
   */
  private ensureCoincidencePipeline(layerCount: number): void {
    if (this.coincidencePipeline && this.coincidenceLayerCount === layerCount) return;
    this.coincidenceLayerCount = layerCount;
    invalidateCoincidenceCache(this.coincidenceBindGroupCache);

    const module = this.device.createShaderModule({
      code: layerCount === CANONICAL_LAYER_COUNT
        ? COINCIDENCE_COMPUTE_SHADER
        : emitCoincidenceComputeWgsl(layerCount),
    });
    this.coincidenceBGL = this.device.createBindGroupLayout({
      entries: [
        ...Array.from({ length: layerCount }, (_, i) => ({
          binding: i,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'float' as const },
        })),
        {
          binding: layerCount,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: 'write-only', format: 'rgba32float', viewDimension: '2d' },
        },
        {
          binding: layerCount + 1,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d' },
        },
        { binding: layerCount + 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });
    this.coincidencePipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.coincidenceBGL] }),
      compute: { module, entryPoint: 'coincidence_main' },
    });
    this.coincidenceUniformBuffer = this.device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  /** Stamp/diag textures are reused whenever dimensions match, same policy as the analysis mask. */
  private ensureCoincidenceTextures(width: number, height: number): GPUTexture {
    if (
      this.cachedStampTexture
      && this.cachedDiagTexture
      && this.cachedCoincidenceWidth === width
      && this.cachedCoincidenceHeight === height
    ) {
      return this.cachedStampTexture;
    }

    this.cachedStampTexture?.destroy();
    this.cachedDiagTexture?.destroy();
    this.cachedStampTexture = this.device.createTexture({
      size: [width, height, 1],
      format: 'rgba32float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.cachedDiagTexture = this.device.createTexture({
      size: [width, height, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.cachedCoincidenceWidth = width;
    this.cachedCoincidenceHeight = height;
    return this.cachedStampTexture;
  }

  /** Read back mask bytes for golden / e2e validation. */
  async readMaskPixels(width: number, height: number): Promise<Uint8Array | null> {
    if (!this.cachedMaskTexture) return null;
    const bytesPerRow = Math.ceil(width / 256) * 256;
    const staging = this.device.createBuffer({
      size: bytesPerRow * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture: this.cachedMaskTexture },
      { buffer: staging, bytesPerRow },
      [width, height, 1],
    );
    this.device.queue.submit([enc.finish()]);
    try {
      await staging.mapAsync(GPUMapMode.READ);
      const mapped = new Uint8Array(staging.getMappedRange());
      const packed = new Uint8Array(width * height);
      for (let y = 0; y < height; y += 1) {
        packed.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + width), y * width);
      }
      staging.unmap();
      staging.destroy();
      return packed;
    } catch {
      staging.destroy();
      return null;
    }
  }

  /**
   * Build histogram (256 bins), derive average luminance, and write an r8uint mask.
   * The returned mask texture is owned by this instance and reused across calls.
   */
  async analyze(
    source: GPUTexture,
    width: number,
    height: number,
    avgLumHint?: number,
  ): Promise<GpuImageAnalysisOutput | null> {
    if (!this.canAnalyze(width, height)) return null;

    let result: GpuImageAnalysisOutput | null = null;
    const run = this.analyzeChain.then(() => this.analyzeOnce(source, width, height, avgLumHint));
    this.analyzeChain = run.then(() => undefined, () => undefined);
    try {
      result = await run;
    } catch (error) {
      console.warn('GPU image analysis failed:', error);
      return null;
    }
    return result;
  }

  private async analyzeOnce(
    source: GPUTexture,
    width: number,
    height: number,
    avgLumHint?: number,
  ): Promise<GpuImageAnalysisOutput | null> {
    this.ensurePipelines();
    const isSrgb = isSrgbTextureFormat(source.format);
    const srcView = source.createView({ baseMipLevel: 0, mipLevelCount: 1 });
    const maskTexture = this.ensureMaskTexture(width, height);

    this.clearHistogramBuffer();

    const histUniformData = new Uint32Array([width, height, isSrgb ? 1 : 0, 0]);
    this.device.queue.writeBuffer(this.histogramUniformBuffer!, 0, histUniformData);

    const histBindGroup = this.device.createBindGroup({
      layout: this.histogramBGL!,
      entries: [
        { binding: 0, resource: srcView },
        { binding: 1, resource: { buffer: this.histogramBuffer! } },
        { binding: 2, resource: { buffer: this.histogramUniformBuffer! } },
      ],
    });

    const enc = this.device.createCommandEncoder();
    const histPass = enc.beginComputePass();
    histPass.setPipeline(this.histogramPipeline!);
    histPass.setBindGroup(0, histBindGroup);
    histPass.dispatchWorkgroups(
      Math.ceil(width / WORKGROUP_SIZE),
      Math.ceil(height / WORKGROUP_SIZE),
    );
    histPass.end();

    enc.copyBufferToBuffer(
      this.histogramBuffer!,
      0,
      this.histogramStagingBuffer!,
      0,
      HISTOGRAM_BYTES,
    );
    this.device.queue.submit([enc.finish()]);

    await this.histogramStagingBuffer!.mapAsync(GPUMapMode.READ);
    const mapped = new Uint32Array(this.histogramStagingBuffer!.getMappedRange().slice(0));
    this.histogramStagingBuffer!.unmap();

    const histogram = new Uint32Array(HISTOGRAM_BINS);
    histogram.set(mapped);
    const avgLuminance = avgLumHint ?? averageFromHistogram(histogram);

    const maskUniformData = new ArrayBuffer(32);
    const maskUniformU32 = new Uint32Array(maskUniformData);
    const maskUniformF32 = new Float32Array(maskUniformData);
    maskUniformU32[0] = width;
    maskUniformU32[1] = height;
    maskUniformU32[2] = isSrgb ? 1 : 0;
    maskUniformF32[4] = avgLuminance;
    this.device.queue.writeBuffer(this.maskUniformBuffer!, 0, maskUniformData);

    const maskBindGroup = this.device.createBindGroup({
      layout: this.classificationBGL!,
      entries: [
        { binding: 0, resource: srcView },
        { binding: 1, resource: maskTexture.createView() },
        { binding: 2, resource: { buffer: this.maskUniformBuffer! } },
      ],
    });

    const enc2 = this.device.createCommandEncoder();
    const maskPass = enc2.beginComputePass();
    maskPass.setPipeline(this.classificationPipeline!);
    maskPass.setBindGroup(0, maskBindGroup);
    maskPass.dispatchWorkgroups(
      Math.ceil(width / WORKGROUP_SIZE),
      Math.ceil(height / WORKGROUP_SIZE),
    );
    maskPass.end();
    this.device.queue.submit([enc2.finish()]);

    return {
      kind: 'gpu-texture',
      avgLuminance: Math.round(avgLuminance),
      maskTexture,
      histogram,
    };
  }

  // ── motion-field ───────────────────────────────────────────────────────────

  /**
   * One-shot motion-field job for the async kit facade (sibling apps, tests).
   * Chromashift's own render loop calls `encodeMotionFieldInto()` so the
   * dispatch lands in the same `GPUCommandEncoder` as the rest of the frame,
   * exactly as it does for `coincidence`.
   */
  private async runMotionField(job: MotionFieldJob): Promise<GpuMotionFieldOutput | null> {
    const source = job.source;
    if (!source) return null;
    const enc = this.device.createCommandEncoder();
    const output = this.encodeMotionFieldInto(enc, source, job.width, job.height, {
      divisor: job.divisor ?? 4,
      threshold: job.threshold,
      reset: job.reset === true,
    });
    this.device.queue.submit([enc.finish()]);
    return output;
  }

  /**
   * Encode the motion-field compute pass into a caller-owned encoder.
   *
   * Nothing is read back here — the field is a `GPUTexture` the persistence
   * pass binds directly, and the summary statistics accumulate into a 16-byte
   * storage buffer that {@link readMotionFieldStats} maps on the caller's own
   * (much slower) cadence.
   */
  encodeMotionFieldInto(
    enc: GPUCommandEncoder,
    source: GPUTexture,
    width: number,
    height: number,
    params: MotionFieldEncodeParams,
  ): GpuMotionFieldOutput | null {
    if (!this.canAnalyze(width, height)) return null;
    this.ensureMotionPipeline();

    const divisor = Math.max(1, Math.floor(params.divisor));
    const resized = this.ensureMotionTextures(width, height, divisor);
    // A resize throws the history away, so the first field after it must be
    // zero rather than a difference against an unrelated frame.
    const reset = params.reset || resized || !this.motionHistoryValid;

    const readSlot = this.motionLumSlot;
    const writeSlot: 0 | 1 = readSlot === 0 ? 1 : 0;

    const uniformData = new ArrayBuffer(32);
    const u32 = new Uint32Array(uniformData);
    const f32 = new Float32Array(uniformData);
    u32[0] = width;
    u32[1] = height;
    u32[2] = this.motionFieldWidth;
    u32[3] = this.motionFieldHeight;
    u32[4] = divisor;
    u32[5] = reset ? 1 : 0;
    u32[6] = isSrgbTextureFormat(source.format) ? 1 : 0;
    f32[7] = params.threshold;
    this.device.queue.writeBuffer(this.motionUniformBuffer!, 0, uniformData);
    // Statistics are per-frame, not cumulative.
    this.device.queue.writeBuffer(this.motionStatsBuffer!, 0, new Uint32Array(4));

    if (this.motionBindGroupSource !== source) {
      this.motionBindGroups = [null, null];
      this.motionBindGroupSource = source;
    }
    let bindGroup = this.motionBindGroups[writeSlot];
    if (!bindGroup) {
      bindGroup = this.device.createBindGroup({
        layout: this.motionBGL!,
        entries: [
          { binding: 0, resource: source.createView() },
          { binding: 1, resource: this.motionLumTextures[readSlot]!.createView() },
          { binding: 2, resource: this.motionFieldTexture!.createView() },
          { binding: 3, resource: this.motionLumTextures[writeSlot]!.createView() },
          { binding: 4, resource: { buffer: this.motionStatsBuffer! } },
          { binding: 5, resource: { buffer: this.motionUniformBuffer! } },
        ],
      });
      this.motionBindGroups[writeSlot] = bindGroup;
    }

    const pass = enc.beginComputePass();
    pass.setPipeline(this.motionPipeline!);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(
      Math.ceil(this.motionFieldWidth / WORKGROUP_SIZE),
      Math.ceil(this.motionFieldHeight / WORKGROUP_SIZE),
    );
    pass.end();

    this.motionLumSlot = writeSlot;
    this.motionHistoryValid = true;

    return {
      kind: 'gpu-motion-field',
      fieldTexture: this.motionFieldTexture!,
      width: this.motionFieldWidth,
      height: this.motionFieldHeight,
    };
  }

  /** The field texture the last `encodeMotionFieldInto` wrote, if any. */
  getMotionFieldTexture(): GPUTexture | null {
    return this.motionFieldTexture;
  }

  /**
   * Last summary statistics read back, or zeros before the first read. Call
   * {@link pollMotionFieldStats} to refresh — deliberately decoupled so the
   * per-frame path never awaits a map.
   */
  getMotionFieldStats(): MotionFieldStats {
    return this.lastMotionStats;
  }

  /**
   * Copy and map the 16-byte statistics buffer. Safe to call at any rate: a
   * call made while a previous map is in flight is dropped rather than queued.
   */
  pollMotionFieldStats(): void {
    if (!this.motionStatsBuffer || !this.motionStatsStagingBuffer) return;
    if (this.motionStatsMapPending) return;
    this.motionStatsMapPending = true;

    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.motionStatsBuffer, 0, this.motionStatsStagingBuffer, 0, 16);
    this.device.queue.submit([enc.finish()]);

    void this.motionStatsStagingBuffer.mapAsync(GPUMapMode.READ).then(() => {
      const view = new Uint32Array(this.motionStatsStagingBuffer!.getMappedRange().slice(0));
      this.motionStatsStagingBuffer!.unmap();
      this.motionStatsMapPending = false;
      const cells = view[2];
      this.lastMotionStats = cells === 0
        ? EMPTY_MOTION_FIELD_STATS
        : { meanMagnitude: view[0] / 1000 / cells, movingFraction: view[1] / cells, cells };
    }).catch(() => {
      this.motionStatsMapPending = false;
    });
  }

  /** True when the history was dropped and the next field will be all-zero. */
  private ensureMotionTextures(width: number, height: number, divisor: number): boolean {
    const size = motionFieldSize(width, height, divisor);
    if (
      this.motionFieldTexture
      && this.motionLumTextures[0]
      && this.motionLumTextures[1]
      && this.motionFieldWidth === size.width
      && this.motionFieldHeight === size.height
      && this.motionSourceWidth === width
      && this.motionSourceHeight === height
    ) {
      return false;
    }

    this.destroyMotionTextures();
    this.motionFieldTexture = this.device.createTexture({
      size: [size.width, size.height, 1],
      format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    const createLumTexture = () => this.device.createTexture({
      size: [size.width, size.height, 1],
      format: 'r32float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.motionLumTextures = [createLumTexture(), createLumTexture()];
    this.motionLumSlot = 0;
    this.motionFieldWidth = size.width;
    this.motionFieldHeight = size.height;
    this.motionSourceWidth = width;
    this.motionSourceHeight = height;
    this.motionHistoryValid = false;
    this.motionBindGroups = [null, null];
    this.motionBindGroupSource = null;
    return true;
  }

  private ensureMotionPipeline(): void {
    if (this.motionPipeline) return;

    const module = this.device.createShaderModule({ code: MOTION_FIELD_COMPUTE_SHADER });
    this.motionBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d' },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: 'write-only', format: 'r32float', viewDimension: '2d' },
        },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });
    this.motionPipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.motionBGL] }),
      compute: { module, entryPoint: 'motion_field_main' },
    });
    this.motionUniformBuffer = this.device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.motionStatsBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    this.motionStatsStagingBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }

  private destroyMotionTextures(): void {
    this.motionFieldTexture?.destroy();
    this.motionLumTextures[0]?.destroy();
    this.motionLumTextures[1]?.destroy();
    this.motionFieldTexture = null;
    this.motionLumTextures = [null, null];
    this.motionFieldWidth = 0;
    this.motionFieldHeight = 0;
    this.motionSourceWidth = 0;
    this.motionSourceHeight = 0;
    this.motionHistoryValid = false;
    this.motionBindGroups = [null, null];
    this.motionBindGroupSource = null;
  }

  destroy(): void {
    this.cachedMaskTexture?.destroy();
    this.cachedMaskTexture = null;
    this.cachedMaskWidth = 0;
    this.cachedMaskHeight = 0;
    this.histogramBuffer?.destroy();
    this.histogramUniformBuffer?.destroy();
    this.maskUniformBuffer?.destroy();
    this.histogramStagingBuffer?.destroy();
    this.histogramBuffer = null;
    this.histogramUniformBuffer = null;
    this.maskUniformBuffer = null;
    this.histogramStagingBuffer = null;

    this.cachedStampTexture?.destroy();
    this.cachedDiagTexture?.destroy();
    this.cachedStampTexture = null;
    this.cachedDiagTexture = null;
    this.cachedCoincidenceWidth = 0;
    this.cachedCoincidenceHeight = 0;
    this.coincidenceUniformBuffer?.destroy();
    this.coincidenceUniformBuffer = null;

    this.destroyMotionTextures();
    this.motionUniformBuffer?.destroy();
    this.motionStatsBuffer?.destroy();
    this.motionStatsStagingBuffer?.destroy();
    this.motionUniformBuffer = null;
    this.motionStatsBuffer = null;
    this.motionStatsStagingBuffer = null;
    this.lastMotionStats = EMPTY_MOTION_FIELD_STATS;
  }

  /** Pipelines, layouts, and the staging pool are built once and cached. */
  private ensurePipelines(): void {
    if (this.histogramPipeline && this.classificationPipeline) return;

    const histogramModule = this.device.createShaderModule({ code: HISTOGRAM_COMPUTE_SHADER });
    const classificationModule = this.device.createShaderModule({ code: CLASSIFICATION_COMPUTE_SHADER });

    this.histogramBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'storage' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform' },
        },
      ],
    });

    this.classificationBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: 'write-only', format: 'r8uint', viewDimension: '2d' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform' },
        },
      ],
    });

    this.histogramPipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.histogramBGL] }),
      compute: { module: histogramModule, entryPoint: 'histogram_main' },
    });

    this.classificationPipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.classificationBGL] }),
      compute: { module: classificationModule, entryPoint: 'classification_main' },
    });

    this.histogramBuffer = this.device.createBuffer({
      size: HISTOGRAM_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    this.histogramUniformBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.maskUniformBuffer = this.device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.histogramStagingBuffer = this.device.createBuffer({
      size: HISTOGRAM_BYTES,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }

  private clearHistogramBuffer(): void {
    if (!this.histogramBuffer) return;
    this.device.queue.writeBuffer(this.histogramBuffer, 0, new Uint32Array(HISTOGRAM_BINS));
  }

  /**
   * The mask texture is reused whenever the dimensions match, so repeated
   * loads of same-sized images do not grow VRAM.
   */
  private ensureMaskTexture(width: number, height: number): GPUTexture {
    if (
      this.cachedMaskTexture
      && this.cachedMaskWidth === width
      && this.cachedMaskHeight === height
    ) {
      return this.cachedMaskTexture;
    }

    this.cachedMaskTexture?.destroy();
    this.cachedMaskTexture = this.device.createTexture({
      size: [width, height, 1],
      format: 'r8uint',
      usage:
        GPUTextureUsage.STORAGE_BINDING
        | GPUTextureUsage.TEXTURE_BINDING
        | GPUTextureUsage.COPY_DST,
    });
    this.cachedMaskWidth = width;
    this.cachedMaskHeight = height;
    return this.cachedMaskTexture;
  }
}
