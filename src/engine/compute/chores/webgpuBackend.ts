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
} from './kernels';
import type {
  ChoreBackendImpl,
  ChoreJob,
  ChoreOutput,
  CoincidenceJob,
  GpuCoincidenceOutput,
  GpuImageAnalysisOutput,
  ImageAnalysisJob,
} from './types';

/** Per-pixel parameters the coincidence compute pass needs, minus geometry. */
export interface CoincidenceEncodeParams {
  colorThresh: number;
  stampBoost: number;
  tracerMode: number;
}

interface CoincidenceBindGroupCacheEntry {
  bindGroup: GPUBindGroup | null;
  layer0: GPUTexture | null;
  layer1: GPUTexture | null;
  layer2: GPUTexture | null;
  stampTexture: GPUTexture | null;
  diagTexture: GPUTexture | null;
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

  private coincidencePipeline: GPUComputePipeline | null = null;
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
    { bindGroup: null, layer0: null, layer1: null, layer2: null, stampTexture: null, diagTexture: null },
    { bindGroup: null, layer0: null, layer1: null, layer2: null, stampTexture: null, diagTexture: null },
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
    if (!job.source) return 'No GPU-resident source texture';
    return `Image ${job.width}×${job.height} exceeds maxTextureDimension2D `
      + `(${this.support.maxTextureDimension2D})`;
  }

  async run(job: ChoreJob): Promise<ChoreOutput | null> {
    if (!this.canRun(job)) return null;
    if (job.op === 'coincidence') {
      return this.runCoincidence(job);
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
    this.ensureCoincidencePipeline();
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
    layers: readonly [GPUTexture, GPUTexture, GPUTexture],
    stampTexture: GPUTexture,
    diagTexture: GPUTexture,
    width: number,
    height: number,
    params: CoincidenceEncodeParams,
    cacheSlot: 0 | 1 = 0,
  ): void {
    this.ensureCoincidencePipeline();
    this.dispatchCoincidence(enc, layers, stampTexture, diagTexture, width, height, params, cacheSlot);
  }

  private dispatchCoincidence(
    enc: GPUCommandEncoder,
    layers: readonly [GPUTexture, GPUTexture, GPUTexture],
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
    if (
      cache.bindGroup
      && cache.layer0 === layers[0] && cache.layer1 === layers[1] && cache.layer2 === layers[2]
      && cache.stampTexture === stampTexture && cache.diagTexture === diagTexture
    ) {
      bindGroup = cache.bindGroup;
    } else {
      bindGroup = this.device.createBindGroup({
        layout: this.coincidenceBGL!,
        entries: [
          { binding: 0, resource: layers[0].createView() },
          { binding: 1, resource: layers[1].createView() },
          { binding: 2, resource: layers[2].createView() },
          { binding: 3, resource: stampTexture.createView() },
          { binding: 4, resource: diagTexture.createView() },
          { binding: 5, resource: { buffer: this.coincidenceUniformBuffer! } },
        ],
      });
      cache.bindGroup = bindGroup;
      cache.layer0 = layers[0];
      cache.layer1 = layers[1];
      cache.layer2 = layers[2];
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

  private ensureCoincidencePipeline(): void {
    if (this.coincidencePipeline) return;

    const module = this.device.createShaderModule({ code: COINCIDENCE_COMPUTE_SHADER });
    this.coincidenceBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: 'write-only', format: 'rgba32float', viewDimension: '2d' },
        },
        {
          binding: 4,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d' },
        },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
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
